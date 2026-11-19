import { parseCanonicalPositiveId } from "@/lib/id-parsing";
import { withRouteErrorHandling } from "@/lib/api-route";
import { NextResponse } from "next/server";
import { LlmConfigError } from "@/lib/llm";
import { loadProjectRow } from "@/lib/projects";
import { hasProjectSummaryContent, isEmptyGeneratedProjectSummary, isGeneratedProjectSummary, normalizeSummary, parseSummary, PROJECT_SUMMARY_OUTPUT_LIMITS as SUMMARY_LIMITS, ProjectSummaryCorruptError, validateGeneratedProjectResume, type ProjectSummary } from "@/lib/summary";
import { createSseResponse } from "@/lib/sse";
import { checkSafeModelInput, safeChatStream, LLM_FEATURES } from "@/lib/safe-llm";
import { ModelInputBudgetError } from "@/lib/llm-input-budget";
import { buildProjectSummaryMessages, PROJECT_SUMMARY_SYSTEM_PROMPT, PROJECT_RESUME_SYSTEM_PROMPT } from "@/lib/project-summary-llm";
import { errorMessage } from "@/lib/error-message";
import { logServerError, requestIdFrom } from "@/lib/server-errors";
import { captureProjectSummaryInput, prepareProjectSummaryProposal, ProjectSummaryHistoryError } from "@/lib/project-summary-history";

async function handlePost(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const projectId = parseCanonicalPositiveId(id);
  if (!Number.isInteger(projectId)) {
    return NextResponse.json({ error: "无效的项目 ID" }, { status: 400 });
  }
  const { searchParams } = new URL(_req.url);
  const mode = searchParams.get("mode") ?? "";
  if (mode !== "" && mode !== "full" && mode !== "resume-only") {
    if (!loadProjectRow(projectId)) return NextResponse.json({ error: "项目不存在" }, { status: 404 });
    return NextResponse.json({ error: "总结模式必须为 full 或 resume-only" }, { status: 400 });
  }
  const isResumeOnly = mode === "resume-only";
  let source: ReturnType<typeof captureProjectSummaryInput>;
  try {
    source = captureProjectSummaryInput(projectId, 60_000);
  } catch (error) {
    if (error instanceof ProjectSummaryHistoryError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
  const { project: row, materials: sourceMaterials, revisionId: sourceRevisionId, materialText: combined } = source;
  let existingSummary: ProjectSummary;
  try {
    // 无材料时沿用空内容提示；有材料时须与提案对照使用同一份有效 JSON。
    const archive = !combined && !row.summary.trim() ? "{}" : row.summary;
    existingSummary = parseSummary(archive);
  } catch (error) {
    if (!(error instanceof ProjectSummaryCorruptError)) throw error;
    return NextResponse.json({ error: error.message }, { status: 422 });
  }
  const hasArchiveContent = hasProjectSummaryContent(existingSummary);
  if (!combined && !hasArchiveContent) {
    return NextResponse.json({ error: "该项目还没有可总结的材料或档案内容，请先导入材料或补充项目档案" }, { status: 400 });
  }

  const systemPrompt = isResumeOnly ? PROJECT_RESUME_SYSTEM_PROMPT : PROJECT_SUMMARY_SYSTEM_PROMPT;
  const messages = buildProjectSummaryMessages({ projectName: row.name, materialText: combined, archive: existingSummary });
  // 与实际调用使用同一份材料，日期规则、系统提示、标签转义均在打开 SSE 前检查。
  try {
    checkSafeModelInput(systemPrompt, messages);
  } catch (error) {
    if (!(error instanceof ModelInputBudgetError)) throw error;
    return NextResponse.json({ error: error.message }, { status: 413 });
  }

  const requestId = requestIdFrom(_req);

  return createSseResponse(async (emitter) => {
    let raw: string;
    try {
      raw = await safeChatStream(
        "summary",
        { feature: LLM_FEATURES.projectSummarize, entity: { type: "project", id: projectId } },
        systemPrompt,
        messages,
        // 字段与提案校验完成前不把模型正文作为可预览结果。
        () => {},
        { signal: emitter.signal, requestId, requireJson: "strict" }
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
      const parsed: unknown = JSON.parse(raw);
      if (!isResumeOnly && isEmptyGeneratedProjectSummary(parsed)) {
        emitter.sendError("当前材料没有可生成的可靠项目总结内容，请补充项目材料或档案后重试");
        return;
      }
      if (isResumeOnly) {
        const resume = validateGeneratedProjectResume(parsed);
        if (!resume) throw new Error(`模型输出必须符合简历字段上限（techStack ≤${SUMMARY_LIMITS.techStack} 字，brief ≤${SUMMARY_LIMITS.brief} 字，achievements 最多 ${SUMMARY_LIMITS.maxAchievements} 条且每条 ≤${SUMMARY_LIMITS.achievement} 字），成果不得重复`);
        // 五维保留原稿，三要素采用本次明确结果；空值也作为变更交给用户核对。
        summary = { ...existingSummary, ...resume };
      } else {
        if (!isGeneratedProjectSummary(parsed)) throw new Error(`模型输出必须包含完整八字段项目总结，并符合字段与总量上限（五维字段每项 ≤${SUMMARY_LIMITS.dimension} 字，techStack ≤${SUMMARY_LIMITS.techStack} 字，brief ≤${SUMMARY_LIMITS.brief} 字，achievements 最多 ${SUMMARY_LIMITS.maxAchievements} 条且每条 ≤${SUMMARY_LIMITS.achievement} 字，文本总量 ≤${SUMMARY_LIMITS.totalText} 字），成果不得重复`);
        summary = normalizeSummary(parsed);
      }
    } catch (err) {
      emitter.sendError(`AI 总结结果异常：${errorMessage(err)}`);
      return;
    }

    // 草稿确认制：AI 产出的总结作为草稿在 done 事件中返回，由用户在页面确认后才写入项目档案
    try {
      const proposal = prepareProjectSummaryProposal(projectId, summary, sourceMaterials, sourceRevisionId, row.name);
      emitter.sendDelta(raw);
      emitter.sendDone(proposal);
    } catch (error) {
      if (error instanceof ProjectSummaryHistoryError) {
        emitter.sendError(error.message);
        return;
      }
      throw error;
    }
  }, requestId);
}

export const POST = withRouteErrorHandling("POST /api/projects/[id]/summarize", handlePost);
