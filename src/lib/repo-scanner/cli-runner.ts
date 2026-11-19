import { promisify } from "util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildRepoScanArchive, buildRepoScanLengthRepairPrompt, buildRepoScanPrompt, type RepoTarget } from "./prompts";
import { extractJson } from "@/lib/llm";
import { getGeneratedProjectSummaryIssue, isEmptyGeneratedProjectSummary, normalizeSummary, type ProjectSummary } from "@/lib/summary";
import { collectRepoSourceSnapshot, RepoSourceEmptyError } from "./source-snapshot";
import { runCliPrompt, textOnlyCliArgs } from "./cli-process";
import { cleanupCliWorkdir } from "./cli-workdir";

const { execFile } = process.getBuiltinModule("child_process");
const execFileAsync = promisify(execFile);

export type CliType = "codex" | "claude";
export interface CliAvailability { available: boolean; path?: string; version?: string }
export interface DetectedClis { codex: CliAvailability; claude: CliAvailability; recommended: CliType | null }

/** 探测本机 CLI；检测失败不等于扫描执行失败。 */
export async function detectInstalledClis(signal?: AbortSignal): Promise<DetectedClis> {
  signal?.throwIfAborted();
  const result: DetectedClis = { codex: { available: false }, claude: { available: false }, recommended: null };
  for (const cli of ["codex", "claude"] as const) {
    signal?.throwIfAborted();
    try {
      const { stdout } = await execFileAsync(process.platform === "win32" ? "where.exe" : "which", [cli], { timeout: 5000, maxBuffer: 16_384, windowsHide: true, signal });
      signal?.throwIfAborted();
      const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const chosen = cli === "codex" ? lines.find((line) => line.endsWith(".cmd")) || lines[0]
        : lines.find((line) => line.endsWith(".exe")) || lines[0];
      if (chosen) result[cli] = { available: true, path: chosen };
    } catch { signal?.throwIfAborted(); /* 未安装或探测不可用；取消不能伪装成未安装 */ }
  }
  // Windows 原生安装器更新用户 PATH 后，已运行的服务仍可能持有旧环境。
  // 保留 PATH 的优先级，漏检时只检查当前用户的默认安装位置。
  if (process.platform === "win32" && !result.claude.available) {
    signal?.throwIfAborted();
    const nativePath = path.join(os.homedir(), ".local", "bin", "claude.exe");
    try {
      const installed = await fs.stat(nativePath);
      signal?.throwIfAborted();
      if (installed.isFile()) result.claude = { available: true, path: nativePath };
    } catch { signal?.throwIfAborted(); /* 默认位置不存在或不可访问 */ }
  }
  result.recommended = result.claude.available ? "claude" : result.codex.available ? "codex" : null;
  return result;
}

export interface RunScanOptions {
  repoPath?: string;
  repoPaths?: string[];
  targets?: RepoTarget[];
  projectName: string;
  projectArchive?: string;
  preferredCli?: "auto" | CliType;
  signal?: AbortSignal;
  onDelta?: (text: string, log?: string) => void;
}

export interface ScanResult { summary: ProjectSummary; cliUsed: CliType; rawOutput: string; logs: string[] }

const activeScans = new Set<string>();

/** 用受限源码材料进行文本分析，CLI 工作目录不含原仓库或其配置。 */
export async function runRepoScan(options: RunScanOptions): Promise<ScanResult> {
  const { projectName, preferredCli = "auto", signal, onDelta } = options;
  signal?.throwIfAborted();
  buildRepoScanArchive(options.projectArchive);
  const paths = options.repoPaths?.length ? options.repoPaths : options.repoPath ? [options.repoPath] : [];
  if (!paths.length || !paths[0]) throw new Error("必须提供至少一个有效的本地代码仓库路径");
  const key = paths.map((value) => path.resolve(value)).sort().join("\0");
  if (activeScans.has(key)) throw new Error("该仓库扫描正在进行，请等待完成");
  if (activeScans.size >= 2) throw new Error("本机扫描繁忙，请等待当前任务完成");
  activeScans.add(key);
  let workdir: string | undefined;
  try {
    const clis = await detectInstalledClis(signal);
    const chosen = preferredCli === "auto" ? clis.recommended : preferredCli;
    if (!chosen || !clis[chosen].available || !clis[chosen].path) throw new Error("本机未检测到指定 CLI，请先安装配置");
    const targets = options.targets?.length ? options.targets : paths.map((value) => ({ path: value }));
    const source = await collectRepoSourceSnapshot(targets, signal);
    if (!source) throw new RepoSourceEmptyError();
    const logs: string[] = [];
    const addLog = (value: string, delta?: string) => {
      const log = value.slice(0, 240);
      if (logs.length === 200) logs.shift();
      logs.push(log);
      onDelta?.(delta || log, log);
    };
    addLog(`[引擎选择] 使用 ${chosen === "claude" ? "Claude Code CLI" : "Codex CLI"} 分析受限源码材料`);
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), "resume-life-cli-"));
    const prompt = buildRepoScanPrompt(projectName, targets, source, options.projectArchive);
    // 首次生成与一次长度修正共用五分钟截止时间；不重试进程错误或取消。
    const deadline = Date.now() + 5 * 60 * 1000;
    const runPrompt = (input: string) => runCliPrompt({
      command: clis[chosen].path!, args: textOnlyCliArgs(chosen), cwd: workdir!,
      prompt: input, timeoutMs: Math.max(1, deadline - Date.now()), signal,
      onOutput(text, stderr) {
        for (const line of text.split(/\r?\n/).map((value) => value.trim()).filter(Boolean).slice(stderr ? -2 : -3)) {
          if (!line.startsWith("{") && !line.startsWith("}")) addLog(`[${stderr ? "提示" : "输出"}] ${line.slice(0, 80)}`, line.slice(0, 80));
        }
      },
    });
    let stdout = await runPrompt(prompt);
    let parsed = extractJson<unknown>(stdout);
    if (isEmptyGeneratedProjectSummary(parsed)) throw new Error("源码材料没有可归纳的可靠项目信息");
    let issue = getGeneratedProjectSummaryIssue(parsed);
    // 只对有限大小的超长输出请求精简，不把残缺结构清洗成成功，也不无限重试。
    if (issue?.kind === "length" && stdout.length <= 64_000 && Date.now() < deadline) {
      signal?.throwIfAborted();
      addLog(`[输出修正] ${issue.message}，正在依据原材料精简一次`);
      stdout = await runPrompt(buildRepoScanLengthRepairPrompt(prompt, stdout, issue.message));
      parsed = extractJson<unknown>(stdout);
      if (isEmptyGeneratedProjectSummary(parsed)) throw new Error("源码材料没有可归纳的可靠项目信息");
      issue = getGeneratedProjectSummaryIssue(parsed);
    }
    if (issue) throw new Error(`CLI 输出未通过完整八字段项目总结 JSON 校验：${issue.message}`);
    addLog("[完成] 项目总结解析完成");
    return { summary: normalizeSummary(parsed), cliUsed: chosen, rawOutput: stdout, logs };
  } finally {
    activeScans.delete(key);
    if (workdir) await cleanupCliWorkdir(workdir, "scan");
  }
}
