import { withRouteErrorHandling } from "@/lib/api-route";
import { NextResponse } from "next/server";
import { extractJson, LlmConfigError } from "@/lib/llm";
import { collectProjectMaterialText, loadProjectRow } from "@/lib/projects";
import { isGeneratedProjectSummary, normalizeSummary, type ProjectSummary } from "@/lib/summary";
import { createSseResponse } from "@/lib/sse";
import { safeChatStream, LLM_FEATURES } from "@/lib/safe-llm";
import { errorMessage } from "@/lib/error-message";
import { logServerError, requestIdFrom } from "@/lib/server-errors";
import { captureProjectMaterialSnapshot, prepareProjectSummaryProposal, projectSummaryRevision } from "@/lib/project-summary-history";

const SYSTEM_PROMPT = `你是资深技术专家。基于用户提供的一个项目的全部材料，为该项目提炼出结构化、高质量的项目档案及简历专供要素，输出 JSON：
{
  "overview": "项目概述：业务背景、项目定位、解决什么核心痛点、系统的主要功能与运行形态",
  "architecture": "架构设计：核心技术栈选型、模块划分、解耦设计与数据流/部署方式",
  "highlights": "技术亮点：有深度与含金量的技术决策、底层优化、设计模式或关键解决方案",
  "responsibilities": "主要职责：主导/参与的核心模块设计与开发、关键机制落地、测试与工程化规范建设",
  "challenges": "难点与成果：踩过的坑或攻坚难题、具体应对手段与量化成效",
  "techStack": "技术栈：核心编程语言、框架、主要依赖库与关键中间件（例如：React 19, Next.js, TypeScript, Tailwind CSS, SQLite）",
  "brief": "项目简要概述：针对简历的一两句精炼介绍（项目定位与核心业务/技术痛点）",
  "achievements": [
    "项目描述与成果1：负责的核心模块/架构动作、解决的技术难点与量化业务/技术成效",
    "项目描述与成果2：...",
    "项目描述与成果3：..."
  ]
}
规则：
1. 前五个五维字段（overview/architecture/highlights/responsibilities/challenges）每项写一段连贯充实的中文（可多句），直接陈述技术事实与工程动作，严禁使用列表项（- 或 1.）或 markdown 标题，严禁出现“材料体现/材料显示/材料中/材料提到”等元话语或旁白；
2. 提炼总结时保持合理的抽象颗粒度，简要概括技术方案与架构机制，避免陷入类名、方法名或微观代码调用等过于细碎的实现细节；
3. techStack 提取核心技术栈，纯文本，简洁清晰；
4. brief 精练概括项目定位，适合直接用于简历项目简介；
5. achievements 输出为 3-5 条字符串的 JSON 数组（每一项单独成条，包含明确的技术动作与量化成效）；
6. 材料中无法推断的内容留空或空数组；真实基于项目材料，不要虚构；只输出合法的 JSON 对象。`;

const RESUME_ONLY_PROMPT = `你是资深技术专家。基于用户提供的项目材料及已有项目背景，专门为简历项目经历提炼标准的三大核心要素，输出 JSON：
{
  "techStack": "技术栈：核心编程语言、框架、主要依赖库与关键中间件（以逗号分隔）",
  "brief": "项目简要概述：针对简历的一两句精炼介绍（项目定位与解决的核心痛点）",
  "achievements": [
    "项目描述与成果1：负责的核心模块设计与开发、关键技术动作与量化成效",
    "项目描述与成果2：...",
    "项目描述与成果3：..."
  ]
}
规则：
1. 提炼项目经历时保持合理的抽象颗粒度，简要概括核心方案与成效，避免出现类名、方法名等过于细碎的代码实现细节；
2. techStack 提取核心技术栈，纯文本，简洁清晰；
3. brief 简练精炼，供简历项目简介使用；
4. achievements 必须输出为 3-5 条独立字符串的 JSON 数组（每一项单独列出，包含技术方案与业务/性能量化成果）；
5. 真实基于项目材料，不要虚构；只输出合法的 JSON 对象。`;

async function handlePost(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const projectId = Number(id);
  if (!Number.isInteger(projectId)) {
    return NextResponse.json({ error: "无效的项目 ID" }, { status: 400 });
  }
  const row = loadProjectRow(projectId);
  if (!row) return NextResponse.json({ error: "项目不存在" }, { status: 404 });

  const { searchParams } = new URL(_req.url);
  const isResumeOnly = searchParams.get("mode") === "resume-only";
  const sourceMaterials = captureProjectMaterialSnapshot(projectId);
  const sourceRevisionId = projectSummaryRevision(projectId);

  const combined = await collectProjectMaterialText(
    projectId,
    // 多读一个字符用于检测超限；完整快照只能与完整模型输入对应。
    60_001,
    (material, index) =>
      `${index === 0 ? "" : "\n\n"}===== 材料：${material.title} =====\n${material.content}`,
  );
  if (combined.length > 60_000) {
    return NextResponse.json({ error: "项目材料超过单次总结的 60000 字符限制（含标题与分隔符），请精简材料后重试；本次未生成总结，原材料保持不变" }, { status: 413 });
  }
  if (!combined && !row.summary) {
    return NextResponse.json({ error: "该项目还没有任何材料，请先导入材料" }, { status: 400 });
  }

  const userPromptContent = combined || `已有项目档案参考：\n${row.summary}`;
  const systemPrompt = isResumeOnly ? RESUME_ONLY_PROMPT : SYSTEM_PROMPT;

  const requestId = requestIdFrom(_req);

  return createSseResponse(async (emitter) => {
    let raw: string;
    try {
      raw = await safeChatStream(
        "summary",
        { feature: LLM_FEATURES.projectSummarize, entity: { type: "project", id: projectId } },
        systemPrompt,
        [
          {
            role: "user",
            parts: [
              { trust: "untrusted", tag: "project_name", text: row.name },
              { trust: "trusted", text: "\n\n" },
              { trust: "untrusted", tag: "project_materials", text: userPromptContent },
            ],
          },
        ],
        (delta) => {
          emitter.sendDelta(delta);
        },
        { signal: emitter.signal, requestId }
      );
    } catch (err) {
      if (err instanceof LlmConfigError) {
        emitter.sendError(err.message);
      } else {
        const loggedId = logServerError("sse.projects.summarize", err, { requestId, status: 500 });
        emitter.sendError(`服务端处理失败（${loggedId}）：${errorMessage(err)}`);
      }
      return;
    }

    let summary: ProjectSummary;
    try {
      const parsed = extractJson<unknown>(raw);
      if (!isGeneratedProjectSummary(parsed)) throw new Error("模型输出未包含有效的项目总结结构");
      const normalized = normalizeSummary(parsed);
      if (isResumeOnly) {
        // 单独提炼简历三项时，完整保留数据库已有五维内容
        let existingSummary = normalizeSummary({});
        try {
          if (row.summary) existingSummary = normalizeSummary(JSON.parse(row.summary));
        } catch {
          // ignore
        }
        summary = {
          ...existingSummary,
          techStack: normalized.techStack || existingSummary.techStack,
          brief: normalized.brief || existingSummary.brief,
          achievements:
            normalized.achievements.length > 0
              ? normalized.achievements
              : existingSummary.achievements,
        };
      } else {
        summary = normalized;
      }
    } catch (err) {
      emitter.sendError(`AI 总结结果异常：${errorMessage(err)}`);
      return;
    }

    // 草稿确认制：AI 产出的总结作为草稿在 done 事件中返回，由用户在页面确认后才写入项目档案
    emitter.sendDone(prepareProjectSummaryProposal(projectId, summary, sourceMaterials, sourceRevisionId));
  }, requestId);
}

export const POST = withRouteErrorHandling("POST /api/projects/[id]/summarize", handlePost);
