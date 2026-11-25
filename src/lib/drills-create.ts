import { getDb, inTransaction } from "@/lib/db";

import { LlmConfigError } from "@/lib/llm";

import { loadProjectContext, projectContextMatches, ProjectNotFoundError } from "@/lib/projects";

import { ProjectSummaryCorruptError } from "@/lib/summary";

import { MAX_MODEL_INPUT_CHARS, ModelInputBudgetError } from "@/lib/llm-input-budget";

import { safeChat, checkSafeModelInput, LLM_FEATURES, type PromptPart } from "@/lib/safe-llm";

import { errorMessage } from "@/lib/error-message";

import { loadBankContext, loadInterviewQuestionContext, loadInterviewTurnParts, readBankDrillSource } from "@/lib/drills-context";

import { parseQuestionItems } from "@/lib/drills-questions";
import { createDrillRecord } from "@/lib/drill-store";
import { hasQuestionContent, questionComparisonKey } from "@/lib/question-normalization";
import { BANK_DRILL_QUESTION_PROMPT, buildBankDrillQuestionMessages, buildProjectDrillQuestionMessages, PROJECT_DRILL_QUESTION_PROMPT, serializeBankQuestion } from "@/lib/drill-question-llm";
import { buildInterviewRemediationMessages, buildInterviewRemediationParts, readInterviewRemediationReport, REMEDIATION_PROMPT } from "@/lib/drill-remediation-llm";

export type CreatedDrill = { id: number; count: number };

function generatedQuestions(raw: string, maxCount: number, project = false): { question: string; kind: string }[] {
  try {
    return parseQuestionItems(raw, { maxCount, project });
  } catch (err) {
    throw new HttpError(502, errorMessage(err));
  }
}

/** 项目深挖题：从项目档案与材料生成 */
export async function createProjectDrill(body: { project_id?: unknown }, count: number, signal: AbortSignal): Promise<CreatedDrill> {
  const projectId = body?.project_id;
  if (typeof projectId !== "number" || !Number.isSafeInteger(projectId) || projectId <= 0) {
    throw new HttpError(400, "请选择项目");
  }

  let context: string;
  try {
    context = await loadProjectContext(projectId);
  } catch (err) {
    if (err instanceof ModelInputBudgetError) throw new HttpError(413, err.message);
    if (err instanceof ProjectSummaryCorruptError) throw new HttpError(422, err.message);
    if (err instanceof ProjectNotFoundError) throw new HttpError(404, err.message);
    throw err;
  }

  let raw: string;
  try {
    raw = await safeChat("question", { feature: LLM_FEATURES.drillProject, entity: { type: "project", id: projectId } }, PROJECT_DRILL_QUESTION_PROMPT,
      buildProjectDrillQuestionMessages(context, count), { signal, requireJson: "strict"});
  } catch (err) {
    throw new HttpError(err instanceof ModelInputBudgetError ? 413 : 502, llmErrorMessage(err));
  }

  const questions = generatedQuestions(raw, count, true);

  return inTransaction(() => {
    signal.throwIfAborted();
    if (!projectContextMatches(projectId, context)) {
      throw new HttpError(409, "项目档案或材料已发生变化，请刷新后重新出题");
    }
    const newId = createDrillRecord({ source: "project", projectId, questions });
    return { id: newId, count: questions.length };
  });
}

/** 岗位通用题（八股/行为）：按方向/JD 出题，题库条目仅作参考题源 */
export async function createBankDrill(
  body: { direction?: unknown; jd?: unknown; previous_drill_id?: unknown },
  count: number,
  signal: AbortSignal
): Promise<CreatedDrill> {
  const previousId = body.previous_drill_id;
  if (previousId !== undefined && (typeof previousId !== "number" || !Number.isSafeInteger(previousId) || previousId <= 0)) {
    throw new HttpError(400, "原练习 ID 无效");
  }
  if (previousId !== undefined && (body.direction !== undefined || body.jd !== undefined)) {
    throw new HttpError(400, "重练使用原场次背景，不能同时指定方向或 JD");
  }
  const previous = previousId === undefined ? null : inTransaction(() => readBankDrillSource(previousId as number));
  if (previousId !== undefined && !previous) throw new HttpError(404, "原题库练习不存在");
  if (previous && !previous.questions.length) throw new HttpError(400, "原练习没有可用于重练的题目");
  if (previous?.questions.some(question => !hasQuestionContent(question.question))) throw new HttpError(400, "原练习含无效题干，请重新创建练习");
  const direction = previous ? previous.drill.direction : typeof body.direction === "string" ? body.direction.trim() : "";
  const jd = previous ? previous.drill.jd : typeof body.jd === "string" ? body.jd.trim() : "";
  if (!previous && !direction && !jd) {
    throw new HttpError(400, "请填写岗位方向或 JD（至少一项）");
  }

  // 先保留完整 JD、方向与固定指令，参考题库只使用剩余额度（含标签转义开销）。
  const bankBudget = remainingContextChars(BANK_DRILL_QUESTION_PROMPT, buildBankDrillQuestionMessages(direction, jd, "", count)[0]!.parts);
  // A saved selection must stay complete, including unlabelled and mixed-direction questions.
  const bank = previous ? previous.questions.map(serializeBankQuestion).join("\n")
    : await loadBankContext(direction || undefined, Math.min(60_000, bankBudget));

  let raw: string;
  try {
    raw = await safeChat("question", { feature: LLM_FEATURES.drillBank }, BANK_DRILL_QUESTION_PROMPT,
      buildBankDrillQuestionMessages(direction, jd, bank, count), { signal, requireJson: "strict"});
  } catch (err) {
    throw new HttpError(err instanceof ModelInputBudgetError ? 413 : 502, llmErrorMessage(err));
  }

  const questions = generatedQuestions(raw, count);

  return inTransaction(() => {
    signal.throwIfAborted();
    if (previous && JSON.stringify(readBankDrillSource(previous.drill.id)) !== JSON.stringify(previous)) {
      throw new HttpError(409, "原练习题目或背景已变化，请刷新后再出题");
    }
    const newId = createDrillRecord({ source: "bank", direction, jd, questions });
    return { id: newId, count: questions.length };
  });
}

/** 同步构建实际外发材料；调用方用短事务固定报告、原题及预算内原答。 */
function interviewDrillContext(interviewId: number, count: number) {
  const db = getDb();
  const interview = db
    .prepare("SELECT id, jd, report FROM interviews WHERE id = ?")
    .get(interviewId) as { id: number; jd: string; report: string } | undefined;
  if (!interview) {
    throw new HttpError(404, "面试不存在");
  }
  let reportRaw: unknown = null;
  try {
    reportRaw = JSON.parse(interview.report);
  } catch {
    reportRaw = null;
  }
  const reportContext = readInterviewRemediationReport(reportRaw);
  if (!reportContext) {
    throw new HttpError(400, "该面试还没有有效的总结报告，请先生成报告");
  }

  const { reportText, focus } = reportContext;
  const buildParts = (questionParts: readonly PromptPart[], turnParts: readonly PromptPart[]) => buildInterviewRemediationParts({
    jd: interview.jd, reportText, questionParts, turnParts, count, focus,
  });
  const questionBudget = remainingContextChars(REMEDIATION_PROMPT, buildParts([], []));
  let questionContext: ReturnType<typeof loadInterviewQuestionContext>;
  try {
    questionContext = loadInterviewQuestionContext(interviewId, questionBudget);
  } catch (error) {
    if (error instanceof ModelInputBudgetError) throw new HttpError(413, error.message);
    throw error;
  }
  const turnBudget = remainingContextChars(REMEDIATION_PROMPT, buildParts(questionContext.parts, []));
  const turnParts = loadInterviewTurnParts(
    interviewId,
    turnBudget,
  );
  return {
    jd: interview.jd,
    focus,
    questions: questionContext.questions,
    parts: buildParts(questionContext.parts, turnParts),
  };
}

/** 面试追练题：模型等待期间不持锁，提交前复核实际用于出题和去重的材料。 */
export async function createInterviewDrill(
  body: { interview_id?: unknown },
  count: number,
  signal: AbortSignal
): Promise<CreatedDrill> {
  const interviewId = body?.interview_id;
  if (typeof interviewId !== "number" || !Number.isSafeInteger(interviewId) || interviewId <= 0) throw new HttpError(400, "请选择面试记录");
  const context = inTransaction(() => interviewDrillContext(interviewId, count));

  let raw: string;
  try {
    raw = await safeChat("question", { feature: LLM_FEATURES.drillRemediation, entity: { type: "interview", id: interviewId } }, REMEDIATION_PROMPT,
      buildInterviewRemediationMessages(context.parts), {
        signal,
        requireJson: "strict"
      });
  } catch (err) {
    throw new HttpError(502, llmErrorMessage(err));
  }

  const questions = generatedQuestions(raw, count);

  if (questions.some((item) => context.questions.has(questionComparisonKey(item.question)))) {
    throw new HttpError(502, "AI 追练题与本场原题重复，请重试");
  }

  return inTransaction(() => {
    signal.throwIfAborted();
    let current: ReturnType<typeof interviewDrillContext>;
    try {
      current = interviewDrillContext(interviewId, count);
    } catch (error) {
      if (error instanceof HttpError || error instanceof ModelInputBudgetError) {
        throw new HttpError(409, "面试追练依据已发生变化，请刷新后重新出题");
      }
      throw error;
    }
    if (JSON.stringify(current.parts) !== JSON.stringify(context.parts)) {
      throw new HttpError(409, "面试追练依据已发生变化，请刷新后重新出题");
    }
    const newId = createDrillRecord({ source: "interview", interviewId, jd: context.jd, focus: context.focus, questions });
    return { id: newId, count: questions.length };
  });
}

function llmErrorMessage(err: unknown): string {
  return err instanceof LlmConfigError
    ? err.message
    : errorMessage(err);
}

/** 与真正调用走同一套拼装，日期规则、标签及转义都计入预算。 */
function remainingContextChars(system: string, parts: readonly PromptPart[]): number {
  try {
    const messages = checkSafeModelInput(system, [{ role: "user", parts }]);
    return MAX_MODEL_INPUT_CHARS - messages.reduce((total, message) => {
      if (typeof message.content !== "string") throw new Error("出题上下文必须为纯文本");
      return total + message.content.length;
    }, 0);
  } catch (err) {
    if (err instanceof ModelInputBudgetError) throw new HttpError(413, err.message);
    throw err;
  }
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
