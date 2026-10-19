import { getDb, inTransaction, now } from "@/lib/db";

import { extractJson, LlmConfigError } from "@/lib/llm";

import { loadProjectContext, ProjectNotFoundError } from "@/lib/projects";

import { ProjectSummaryCorruptError } from "@/lib/summary";

import { MAX_MODEL_INPUT_CHARS } from "@/lib/llm-input-budget";

import { UNTRUSTED_DATA_SYSTEM_RULES } from "@/lib/prompt-safety";

import { safeChat, LLM_FEATURES, type PromptPart } from "@/lib/safe-llm";

import { INTERVIEW_DIMENSIONS, normalizeReport, weakDimensions } from "@/lib/scores";

import { errorMessage } from "@/lib/error-message";

import { loadBankContext, loadInterviewTurnParts, promptPartsLength } from "@/lib/drills-context";

import { insertQuestions, MAX_DRILL_QUESTIONS, parseQuestionItems } from "@/lib/drills-questions";

export type CreatedDrill = { id: number; count: number };

function validateQuestionCount(questions: readonly unknown[], count: number): void {
  if (questions.length === 0) throw new HttpError(502, "AI 没有生成有效题目，请重试");
  if (questions.length > Math.min(count, MAX_DRILL_QUESTIONS)) {
    throw new HttpError(502, "AI 生成的题目数量超过本次请求上限，请重试");
  }
}

const PROJECT_PROMPT = `你是资深面试官。基于给定的项目档案与材料，为该项目设计深挖面试题。
输出 JSON：{"questions": ["题目1", "题目2", ...]}
要求：题目围绕项目的背景、架构、技术难点、权衡决策、结果与候选人职责；从浅入深排列；每道题是一个具体的问题（不要选择题/判断题）；只输出 JSON。`;

const BANK_QUESTION_PROMPT = `你是资深面试官。请结合岗位方向与 JD，出八股与行为面试题：优先覆盖核心考点，八股与行为题按岗位侧重合理搭配，按由浅入深排列。
若提供了参考题库（每行格式：ID|类型|题目），它只是参考题源：其中合适的题目可直接采用原题，也可结合方向与 JD 出新题；同一套题内不要重复。
输出 JSON：{"questions": [{"question": "题目文本", "kind": "tech"（八股）或 "behavior"（行为）}, ...]}。只输出 JSON。`;

const REMEDIATION_PROMPT = `你是资深面试教练。候选人刚结束一场模拟面试，想在短板维度上做针对性练习。
请围绕总结报告中的低分维度与逐题作答暴露的失分点出追练题：变换角度重考失分点，补齐对应的能力短板（知识盲区用八股题、表达与条理问题换场景重考），不要与原题重复；由浅入深排列；每道题是一个具体的问题（不要选择题/判断题）。
输出 JSON：{"questions": [{"question": "题目文本", "kind": "tech"（八股）或 "behavior"（行为）}, ...]}。只输出 JSON。`;

/** 项目深挖题：从项目档案与材料生成 */
export async function createProjectDrill(body: { project_id?: unknown }, count: number, signal: AbortSignal): Promise<CreatedDrill> {
  const projectId = Number(body?.project_id);
  if (!Number.isInteger(projectId)) {
    throw new HttpError(400, "请选择项目");
  }

  let context: string;
  try {
    context = await loadProjectContext(projectId);
  } catch (err) {
    if (err instanceof ProjectSummaryCorruptError) throw new HttpError(422, err.message);
    if (err instanceof ProjectNotFoundError) throw new HttpError(404, err.message);
    throw err;
  }

  let raw: string;
  try {
    raw = await safeChat("question", { feature: LLM_FEATURES.drillProject, entity: { type: "project", id: projectId } }, PROJECT_PROMPT, [
      {
        role: "user",
        parts: [
          { trust: "untrusted", tag: "project_context", text: context },
          { trust: "trusted", text: "\n\n请生成 " },
          { trust: "untrusted", tag: "question_count", text: String(count) },
          { trust: "trusted", text: " 道面试深挖题。" },
        ],
      },
    ], { signal, requireJson: true });
  } catch (err) {
    throw new HttpError(502, llmErrorMessage(err));
  }

  let questions: string[] = [];
  try {
    const parsed = extractJson<{ questions?: unknown }>(raw);
    questions = Array.isArray(parsed.questions)
      ? [...new Set(parsed.questions.filter((q): q is string => typeof q === "string" && q.trim().length > 0).map((q) => q.trim()))]
      : [];
  } catch {
    questions = [];
  }
  validateQuestionCount(questions, count);

  const db = getDb();
  return inTransaction(() => {
    const result = db
      .prepare("INSERT INTO drills (source, project_id, created_at) VALUES ('project', ?, ?)")
      .run(projectId, now());
    const newId = Number(result.lastInsertRowid);
    insertQuestions(newId, questions.map((q) => ({ question: q, kind: "" })));
    return { id: newId, count: questions.length };
  });
}

/** 岗位通用题（八股/行为）：按方向/JD 出题，题库条目仅作参考题源 */
export async function createBankDrill(
  body: { direction?: unknown; jd?: unknown },
  count: number,
  signal: AbortSignal
): Promise<CreatedDrill> {
  const direction = typeof body?.direction === "string" ? body.direction.trim() : "";
  const jd = typeof body?.jd === "string" ? body.jd.trim() : "";
  if (!direction && !jd) {
    throw new HttpError(400, "请填写岗位方向或 JD（至少一项）");
  }

  // 题库为空时同样可出题，只是没有参考题源
  const bank = await loadBankContext(direction || undefined);

  let raw: string;
  try {
    raw = await safeChat("question", { feature: LLM_FEATURES.drillBank }, BANK_QUESTION_PROMPT, [
      {
        role: "user",
        parts: bankQuestionParts(direction, jd, bank, count),
      },
    ], { signal });
  } catch (err) {
    throw new HttpError(502, llmErrorMessage(err));
  }

  // 解析题目列表（kind 归一化、去重）；解析失败按空处理，下方统一报错
  let questions: { question: string; kind: string }[] = [];
  try {
    questions = parseQuestionItems(raw);
  } catch {
    questions = [];
  }
  validateQuestionCount(questions, count);

  const db = getDb();
  return inTransaction(() => {
    const result = db
      .prepare("INSERT INTO drills (source, direction, jd, created_at) VALUES ('bank', ?, ?, ?)")
      .run(direction, jd, now());
    const newId = Number(result.lastInsertRowid);
    insertQuestions(newId, questions);
    return { id: newId, count: questions.length };
  });
}

/** 面试追练题：从总结报告的短板/低分维度与本场问答的失分点生成 */
export async function createInterviewDrill(
  body: { interview_id?: unknown },
  count: number,
  signal: AbortSignal
): Promise<CreatedDrill> {
  const interviewId = Number(body?.interview_id);
  if (!Number.isInteger(interviewId)) {
    throw new HttpError(400, "请选择面试记录");
  }
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
  const report = normalizeReport(reportRaw);
  if (!report) {
    throw new HttpError(400, "该面试还没有有效的总结报告，请先生成报告");
  }

  // 追练重点：报告中的低分维度；各维都不低时取最低两维
  const focus = weakDimensions(report)
    .map((k) => INTERVIEW_DIMENSIONS.find((d) => d.key === k)?.label ?? k)
    .join("、");

  const reportText = [
    `综合 ${report.overall} 分`,
    INTERVIEW_DIMENSIONS.map((d) => `${d.label} ${report[d.key]}`).join("，"),
    `短板：${report.weaknesses}`,
    `建议：${report.suggestions}`,
  ].join("\n");
  const contextPrefix: PromptPart[] = [
    { trust: "trusted", text: "【岗位要求】\n" },
    { trust: "untrusted", tag: "job_description", text: interview.jd },
    { trust: "trusted", text: "\n\n【总结报告】\n" },
    { trust: "untrusted", tag: "interview_report", text: reportText },
    { trust: "trusted", text: "\n\n【本场问答】\n" },
  ];
  const contextSuffix: PromptPart[] = [
    { trust: "trusted", text: "\n\n请出 " },
    { trust: "untrusted", tag: "question_count", text: String(count) },
    { trust: "trusted", text: " 道追练题，重点考察：" },
    { trust: "untrusted", tag: "focus_dimensions", text: focus },
    { trust: "trusted", text: "。" },
  ];
  const safeFixedInputChars = REMEDIATION_PROMPT.length
    + 1
    + UNTRUSTED_DATA_SYSTEM_RULES.length
    + promptPartsLength(contextPrefix)
    + promptPartsLength(contextSuffix);
  if (safeFixedInputChars > MAX_MODEL_INPUT_CHARS) {
    throw new HttpError(
      413,
      `完整模型输入超过 ${MAX_MODEL_INPUT_CHARS} 字符，请缩短简历、岗位要求或历史内容后重试`,
    );
  }

  const turnParts = await loadInterviewTurnParts(
    interviewId,
    MAX_MODEL_INPUT_CHARS - safeFixedInputChars,
  );

  let raw: string;
  try {
    raw = await safeChat("question", { feature: LLM_FEATURES.drillRemediation, entity: { type: "interview", id: interviewId } }, REMEDIATION_PROMPT, [
      {
        role: "user",
        parts: [
          ...contextPrefix,
          ...turnParts,
          ...contextSuffix,
        ],
      },
    ], { signal });
  } catch (err) {
    throw new HttpError(502, llmErrorMessage(err));
  }

  let questions: { question: string; kind: string }[] = [];
  try {
    questions = parseQuestionItems(raw);
  } catch {
    questions = [];
  }
  validateQuestionCount(questions, count);

  return inTransaction(() => {
    const result = db
      .prepare("INSERT INTO drills (source, interview_id, focus, created_at) VALUES ('interview', ?, ?, ?)")
      .run(interviewId, focus, now());
    const newId = Number(result.lastInsertRowid);
    insertQuestions(newId, questions);
    return { id: newId, count: questions.length };
  });
}

function bankQuestionParts(direction: string, jd: string, bank: string, count: number): PromptPart[] {
  const parts: PromptPart[] = [];
  const append = (label: string, tag: string, text: string) => {
    if (parts.length > 0) parts.push({ trust: "trusted", text: "\n\n" });
    parts.push(
      { trust: "trusted", text: `${label}\n` },
      { trust: "untrusted", tag, text },
    );
  };
  if (direction) append("【岗位方向】", "job_direction", direction);
  if (jd) append("【岗位要求（JD）】", "job_description", jd);
  if (bank) append("【参考题库】", "question_bank", bank);
  parts.push(
    { trust: "trusted", text: "\n\n请出 " },
    { trust: "untrusted", tag: "question_count", text: String(count) },
    { trust: "trusted", text: " 道题。" },
  );
  return parts;
}

function llmErrorMessage(err: unknown): string {
  return err instanceof LlmConfigError
    ? err.message
    : errorMessage(err);
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
