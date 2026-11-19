import type { InterviewRecap, InterviewRecapSourceContext, InterviewReviewQuestion, InterviewReviewResponse } from "./application-interview-review";

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const positiveId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const hash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const fields = ["question", "answer", "stuck", "feedback"] as const;
const sourceFields = ["company", "role", "round_name", "jd"] as const;
type ReviewIdentity = { applicationId: number; interviewId: number };

function fail(): never { throw new Error("复盘响应不完整或记录不符，请重新读取"); }

function questions(value: unknown): value is InterviewReviewQuestion[] {
  return Array.isArray(value) && value.every(item => record(item) && fields.every(field => typeof item[field] === "string"));
}

function sourceContext(value: unknown): value is InterviewRecapSourceContext | null {
  return value === null || (record(value) && sourceFields.every(field => typeof value[field] === "string"));
}

export function reviewSourceContextMatches(actual: unknown, expected: InterviewRecapSourceContext | null): boolean {
  if (!sourceContext(actual)) return false;
  if (actual === null || expected === null) return actual === expected;
  return sourceFields.every(field => actual[field] === expected[field]);
}

/** 核对存档的渲染结构和归属，不把新生成的长度限制套在历史内容上。 */
export function readInterviewRecap(value: unknown, identity: ReviewIdentity): InterviewRecap {
  if (!record(value) || !positiveId(value.id) || value.application_id !== identity.applicationId || value.interview_id !== identity.interviewId
    || !hash(value.input_hash) || typeof value.created_at !== "string" || !questions(value.questions) || !sourceContext(value.source_context) || !record(value.result) || !record(value.exports)
    || typeof value.exports.mistakes !== "boolean" || typeof value.exports.resume_suggestions !== "boolean"
    || (value.exports.drills !== null && !positiveId(value.exports.drills))) fail();
  const questionCount = value.questions.length;
  const resultFields = { mistakes: ["gap", "improved_answer"], drills: ["question"], resume_suggestions: ["suggestion"] } as const;
  for (const [kind, texts] of Object.entries(resultFields)) {
    const entries = value.result[kind];
    if (!Array.isArray(entries) || entries.some(entry => !record(entry) || !positiveId(entry.question_index) || entry.question_index > questionCount
      || texts.some(field => typeof entry[field] !== "string"))) fail();
  }
  return value as InterviewRecap;
}

/** 完整校验后才替换当前草稿，损坏回包不能造成部分状态更新。 */
export function readInterviewReviewResponse(value: unknown, identity: ReviewIdentity): InterviewReviewResponse {
  if (!record(value) || !positiveId(identity.applicationId) || !positiveId(identity.interviewId) || !questions(value.questions)
    || !Array.isArray(value.history) || (value.input_hash === null
      ? typeof value.material_error !== "string" || !value.material_error.trim()
      : !hash(value.input_hash) || value.material_error !== null)) fail();
  let previousId = Infinity;
  for (const item of value.history) {
    if (!record(item) || !positiveId(item.id) || item.id >= previousId || !hash(item.input_hash) || typeof item.created_at !== "string") fail();
    previousId = item.id;
  }
  for (const kind of ["latest", "selected"] as const) {
    if (value[kind] === null) continue;
    const recap = readInterviewRecap(value[kind], identity);
    const entry = value.history.find(item => item.id === recap.id);
    if (!entry || entry.input_hash !== recap.input_hash || entry.created_at !== recap.created_at) fail();
  }
  if (value.history.length === 0 ? value.latest !== null : !record(value.latest) || value.latest.id !== value.history[0].id) fail();
  return value as InterviewReviewResponse;
}

export function reviewQuestionsMatch(actual: readonly InterviewReviewQuestion[], expected: readonly InterviewReviewQuestion[], trimExpected = false): boolean {
  return actual.length === expected.length && actual.every((item, index) => fields.every(field =>
    item[field] === (trimExpected ? expected[index]![field].trim() : expected[index]![field])));
}
