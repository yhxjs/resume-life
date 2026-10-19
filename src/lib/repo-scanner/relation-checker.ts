import { extractJson } from "@/lib/llm";
import { safeChat, LLM_FEATURES } from "@/lib/safe-llm";
import type { PathValidationResult } from "./path-validator";
import { detectInstalledClis, type CliType } from "./cli-runner";
import { UNTRUSTED_DATA_SYSTEM_RULES, wrapUntrustedData } from "../prompt-safety";
import { runCliPrompt, textOnlyCliArgs } from "./cli-process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface PathRelationCheckResult {
  isRelated: boolean | null;
  reason: string;
  method: "single" | "model" | "cli" | "heuristic";
}

const PATH_RELATION_SYSTEM_PROMPT = `你是一名资深软件系统架构师。用户在项目库中同时选择了多个本地代码仓库路径，准备将它们合并提炼为同一个项目的简历亮点与技术档案。
请分析这几个代码库之间是否存在合理的工程/业务协同关联（例如：同属一个系统的前后端分离模块、微服务架构下的不同服务子项目、主应用与附属SDK/工具库等）。
如果这几个代码库没有任何技术栈协作、业务定位毫不相关、完全属于互不相干的两个独立项目（例如一个是网络网卡唤醒工具，另一个是音乐创作系统），则判定为没有关联关系。`;

type RepoSummaryInput = {
  path: string;
  projectName?: string;
  features?: string[];
  readmeSnippet?: string;
  packageMetadata?: Record<string, unknown>;
};

function buildRepoSummariesText(paths: RepoSummaryInput[]): string {
  return paths.map((p, idx) => {
    const metaStr = p.packageMetadata ? JSON.stringify(p.packageMetadata) : "无";
    const snippet = p.readmeSnippet ? p.readmeSnippet.slice(0, 300) : "无";
    return `[代码库 ${idx + 1}]
- 路径: ${p.path}
- 项目名称: ${p.projectName || "未知"}
- 包含工程特征: ${(p.features || []).join(", ")}
- 构建包元信息: ${metaStr}
- README 摘要: ${snippet}`;
  }).join("\n\n");
}

/**
 * CLI 只消费摘要文本，采用与 HTTP 模型相同的不可信材料标记。
 */
export function buildPathRelationCheckPrompt(paths: RepoSummaryInput[]): string {
  return `${PATH_RELATION_SYSTEM_PROMPT}\n${UNTRUSTED_DATA_SYSTEM_RULES}

以下是待比对的代码库摘要信息：
${wrapUntrustedData("repo_summaries", buildRepoSummariesText(paths))}

请严格仅输出一个合法的 JSON 对象，不要包含 markdown 标记或任何其他多余文本：
{
  "isRelated": true 或 false,
  "reason": "简要说明你做出该判断的原因（1-2句话，若不相关请具体指出它们各自是什么，为什么不属于同一个项目）"
}`;
}

/**
 * 轻量启发式多工程差异分析（在 AI 不可用时作为智能兜底防护）
 */
function analyzeHeuristicRelation(paths: PathValidationResult[]): {
  isSuspicious: boolean;
  reason: string;
} {
  const names = paths.map((p) => p.projectName || "").filter(Boolean);
  const types = paths.map((p) => (p.packageMetadata?.type as string) || "unknown");

  const distinctTypes = new Set(types.filter((t) => t !== "unknown"));

  const firstWord = (names[0] ? names[0].split(/[-_.]/)[0] : "") || "";
  const prefix = firstWord.toLowerCase();
  const hasCommonPrefix = Boolean(prefix) && names.length > 1 && names.every((n) => {
    return n.toLowerCase().startsWith(prefix);
  });

  if (distinctTypes.size > 1 && !hasCommonPrefix) {
    const details = paths.map((p) => `「${p.projectName}」(${p.packageMetadata?.type || p.features?.[0] || "代码库"})`).join(" 与 ");
    return {
      isSuspicious: true,
      reason: `检测到 ${details} 属于完全不同的工程生态与技术栈，且未检测到公共命名或父级模块关联。`,
    };
  }

  const snippets = paths.map((p) => (p.readmeSnippet || "").toLowerCase());
  if (snippets.length > 1 && snippets.every((s) => s.length > 20)) {
    const sn0 = snippets[0] || "";
    const sn1 = snippets[1] || "";
    const words0 = new Set(sn0.match(/[一-龥]{2,}|[a-zA-Z]{3,}/g) || []);
    const words1 = new Set(sn1.match(/[一-龥]{2,}|[a-zA-Z]{3,}/g) || []);
    let commonCount = 0;
    for (const w of words0) {
      if (words1.has(w)) commonCount++;
    }
    if (commonCount === 0 && !hasCommonPrefix) {
      return {
        isSuspicious: true,
        reason: `代码库「${names[0] || "A"}」与「${names[1] || "B"}」的业务定位与功能描述未发现任何重叠，疑似属于互不相干的独立工程。`,
      };
    }
  }

  return { isSuspicious: false, reason: "" };
}

/**
 * 通过系统内置 LLM 或宿主机本地 CLI 研判多个路径是否属于同一个项目
 */
export async function checkPathsRelation(
  paths: PathValidationResult[],
  options?: { preferredCli?: "auto" | CliType; signal?: AbortSignal; projectId?: number }
): Promise<PathRelationCheckResult> {
  options?.signal?.throwIfAborted();
  if (paths.length <= 1) {
    return { isRelated: true, reason: "单一路径无需校验关联性", method: "single" };
  }

  const { preferredCli = "auto", signal } = options || {};

  const repoSummaries = buildRepoSummariesText(
    paths.map((p) => ({
      path: p.normalizedPath || "",
      projectName: p.projectName,
      features: p.features,
      readmeSnippet: p.readmeSnippet,
      packageMetadata: p.packageMetadata,
    }))
  );

  //    必须经 safeChat 的不可信标签包裹，与其他 11 个 LLM 消费点保持同一条信任边界。
  try {
    const reply = await safeChat(
      "summary",
      {
        feature: LLM_FEATURES.projectRepoRelation,
        ...(options?.projectId ? { entity: { type: "project", id: options.projectId } } : {}),
      },
      `${PATH_RELATION_SYSTEM_PROMPT}\n\n请严格仅输出一个合法的 JSON 对象（isRelated 为 boolean，reason 为 1-2 句简要说明），不要包含 markdown 标记或任何其他多余文本。`,
      [
        {
          role: "user",
          parts: [{ trust: "untrusted", tag: "repo_summaries", text: repoSummaries }],
        },
      ],
      { signal }
    );
    const parsed = extractJson<{ isRelated?: unknown; reason?: unknown }>(reply);
    if (typeof parsed?.isRelated === "boolean" && typeof parsed.reason === "string" && parsed.reason.trim()) {
      return {
        isRelated: parsed.isRelated,
        reason: parsed.reason,
        method: "model",
      };
    }
  } catch (err) {
    signal?.throwIfAborted();
    if (err instanceof Error && err.name === "AbortError") {
      throw err;
    }
    // 忽略未配置 LLM 或输入超预算，继续尝试本地 CLI
  }

  try {
    const clis = await detectInstalledClis();
    const primaryPath = paths[0]?.normalizedPath;

    // 优先顺序：如果指定了 preferredCli 则优先，否则 claude 优先（次选 codex）
    const candidateClis: CliType[] = [];
    if (preferredCli === "codex" && clis.codex.available) {
      candidateClis.push("codex");
    } else if (preferredCli === "claude" && clis.claude.available) {
      candidateClis.push("claude");
    } else {
      if (clis.claude.available) candidateClis.push("claude");
      if (clis.codex.available) candidateClis.push("codex");
    }

    if (primaryPath) {
      for (const cli of candidateClis) {
        const cliPath = clis[cli].path;
        const cliResult = await runCliQuickCheck(cli, cliPath, buildPathRelationCheckPrompt(paths.map((p) => ({
          path: p.normalizedPath || "",
          projectName: p.projectName,
          features: p.features,
          readmeSnippet: p.readmeSnippet,
          packageMetadata: p.packageMetadata,
        }))), signal);
        if (cliResult) {
          return cliResult;
        }
      }
    }
  } catch {
    signal?.throwIfAborted();
  }

  const heuristic = analyzeHeuristicRelation(paths);
  if (heuristic.isSuspicious) {
    return {
      isRelated: false,
      reason: `AI 与本机 CLI 未能完成研判，启发式检查提示：${heuristic.reason}`,
      method: "heuristic",
    };
  }

  return {
    isRelated: null,
    reason: "AI 与本机 CLI 未能完成研判；启发式未发现明确冲突，但无法确认这些代码库属于同一项目。",
    method: "heuristic",
  };
}

/**
 * 辅助：使用本机 CLI 执行快速单次文本问答获取 JSON 判断。
 * 提示词只走 stdin：既避免 Windows 下 cmd.exe 对 argv 的解析注入面，
 * 也绕开 ~8K 字符的命令行长度上限。
 */
async function runCliQuickCheck(
  cliType: "claude" | "codex",
  cliExecutablePath: string | undefined,
  prompt: string,
  signal?: AbortSignal
): Promise<PathRelationCheckResult | null> {
  signal?.throwIfAborted();
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), "resume-life-relation-"));
  try {
    const stdout = await runCliPrompt({ command: cliExecutablePath || cliType,
      args: textOnlyCliArgs(cliType), cwd: workdir, prompt, timeoutMs: 15_000, signal });
    const parsed = extractJson<{ isRelated?: unknown; reason?: unknown }>(stdout);
    if (typeof parsed?.isRelated === "boolean" && typeof parsed.reason === "string" && parsed.reason.trim()) {
      return { isRelated: parsed.isRelated, reason: parsed.reason, method: "cli" };
    }
    return null;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof Error) return null;
    throw error;
  } finally {
    if (path.dirname(workdir) !== os.tmpdir() || !path.basename(workdir).startsWith("resume-life-relation-")) throw new Error("CLI 临时目录边界无效");
    await fs.rm(workdir, { recursive: true, force: true });
  }
}
