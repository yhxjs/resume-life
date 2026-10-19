import { createHash } from "node:crypto";
import { acquireCommandLock, getDb, inTransaction, now } from "@/lib/db";
import { extractJson } from "@/lib/llm";
import { safeChat, LLM_FEATURES, type PromptPart } from "@/lib/safe-llm";
import { ModelInputBudgetError } from "@/lib/llm-input-budget";
import { getReviewDate } from "@/lib/spaced-repetition";
import { formatResumeContext } from "@/lib/resumes";
import type { ResumeSnapshot } from "@/lib/resume-version-types";

export type InterviewReviewQuestion = {
  question: string;
  answer: string;
  stuck: string;
  feedback: string;
};

export type InterviewReviewResult = {
  mistakes: { question_index: number; gap: string; improved_answer: string }[];
  drills: { question_index: number; question: string }[];
  resume_suggestions: { question_index: number; suggestion: string }[];
};

export type InterviewRecap = {
  id: number;
  application_id: number;
  interview_id: number;
  input_hash: string;
  questions: InterviewReviewQuestion[];
  result: InterviewReviewResult;
  exports: { mistakes: boolean; drills: number | null; resume_suggestions: boolean };
  created_at: string;
};

export type ReviewExportAction = "mistakes" | "drills" | "resume_suggestions";

export class InterviewReviewError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

type RoundContext = {
  id: number;
  application_id: number;
  company: string;
  role: string;
  round_name: string;
  jd: string;
  resume_snapshot: string;
};

type QuestionRow = InterviewReviewQuestion & { position: number };
type RecapRow = Omit<InterviewRecap, "application_id" | "questions" | "result" | "exports"> & { questions: string; result: string };

const SYSTEM_PROMPT = `你是求职者的面试复盘教练。依据真实面试逐题记录，只输出 JSON：
{"mistakes":[{"question_index":1,"gap":"失分点","improved_answer":"可练习的改进回答"}],"drills":[{"question_index":1,"question":"变换角度的追练题"}],"resume_suggestions":[{"question_index":1,"suggestion":"有事实依据的简历修改建议"}]}。
question_index 必须是输入中的题号。错题只收录真实暴露的卡点，不能臆造面试官反馈；追练题不得重复原题。简历建议应基于该题暴露的表达或证据缺口，不编造经历、指标或未提供的简历内容。若没有可靠的某类建议，该数组可为空。`; 

function roundContext(applicationId: number, interviewId: number): RoundContext {
  if (!Number.isSafeInteger(applicationId) || applicationId <= 0 || !Number.isSafeInteger(interviewId) || interviewId <= 0) {
    throw new InterviewReviewError("无效的投递或面试轮次 ID");
  }
  const row = getDb().prepare(`SELECT i.id, i.application_id, i.round_name, a.company, a.role, a.jd,
    COALESCE(a.submitted_resume, rv.snapshot, '') AS resume_snapshot
    FROM application_interviews i JOIN applications a ON a.id = i.application_id
    LEFT JOIN resume_versions rv ON rv.id = a.resume_version_id
    WHERE i.id = ? AND i.application_id = ?`).get(interviewId, applicationId) as RoundContext | undefined;
  if (!row) throw new InterviewReviewError("面试轮次记录不存在", 404);
  return { ...row, resume_snapshot: row.resume_snapshot
    ? formatResumeContext((JSON.parse(row.resume_snapshot) as ResumeSnapshot).modules) : "" };
}

function readQuestions(interviewId: number): InterviewReviewQuestion[] {
  return (getDb().prepare(`SELECT position, question, answer, stuck, feedback
    FROM application_interview_questions WHERE interview_id = ? ORDER BY position`).all(interviewId) as QuestionRow[])
    .map(({ question, answer, stuck, feedback }) => ({ question, answer, stuck, feedback }));
}

function hashReviewInput(context: RoundContext, questions: InterviewReviewQuestion[]): string {
  return createHash("sha256").update(JSON.stringify([
    context.company, context.role, context.jd, context.resume_snapshot, questions,
  ])).digest("hex");
}

function normalizeQuestions(value: unknown): InterviewReviewQuestion[] {
  if (!Array.isArray(value) || value.length > 20) throw new InterviewReviewError("逐题记录最多 20 题");
  let total = 0;
  const questions = value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new InterviewReviewError(`第 ${index + 1} 题格式无效`);
    const source = item as Record<string, unknown>;
    const normalized = {} as InterviewReviewQuestion;
    for (const key of ["question", "answer", "stuck", "feedback"] as const) {
      const raw = source[key] ?? "";
      if (typeof raw !== "string") throw new InterviewReviewError(`第 ${index + 1} 题内容必须是文本`);
      const text = raw.trim();
      if (text.length > 2000) throw new InterviewReviewError(`第 ${index + 1} 题内容不能超过 2000 字`);
      normalized[key] = text;
      total += text.length;
    }
    if (!normalized.question) throw new InterviewReviewError(`第 ${index + 1} 题的提问不能为空`);
    return normalized;
  });
  if (total > 32000) throw new InterviewReviewError("逐题复盘总内容不能超过 32000 字");
  return questions;
}

function mapRecap(row: RecapRow, applicationId: number): InterviewRecap {
  const result = JSON.parse(row.result) as InterviewReviewResult;
  const rows = getDb().prepare(`SELECT e.kind, e.item_index, e.target_id,
    n.id AS notebook_id, d.id AS drill_id, t.id AS task_id
    FROM application_interview_recap_exports e
    LEFT JOIN notebook_entries n ON e.kind = 'mistakes' AND n.id = e.target_id
    LEFT JOIN drills d ON e.kind = 'drills' AND d.id = e.target_id
    LEFT JOIN application_preparation_tasks t ON e.kind = 'resume_suggestions' AND t.id = e.target_id
    WHERE e.recap_id = ?`).all(row.id) as {
      kind: ReviewExportAction; item_index: number; target_id: number;
      notebook_id: number | null; drill_id: number | null; task_id: number | null;
    }[];
  const mistakes = new Set(rows.filter((entry) => entry.kind === "mistakes" && entry.notebook_id !== null).map((entry) => entry.item_index));
  const tasks = new Set(rows.filter((entry) => entry.kind === "resume_suggestions" && entry.task_id !== null).map((entry) => entry.item_index));
  return { ...row, application_id: applicationId, questions: JSON.parse(row.questions), result, exports: {
    mistakes: result.mistakes.length > 0 && result.mistakes.every((_, index) => mistakes.has(index)),
    drills: rows.find((entry) => entry.kind === "drills" && entry.drill_id !== null)?.target_id ?? null,
    resume_suggestions: result.resume_suggestions.length > 0 && result.resume_suggestions.every((_, index) => tasks.has(index)),
  } };
}

function latestRecap(interviewId: number, applicationId: number): InterviewRecap | null {
  const row = getDb().prepare(`SELECT * FROM application_interview_recaps WHERE interview_id = ? ORDER BY id DESC LIMIT 1`)
    .get(interviewId) as RecapRow | undefined;
  return row ? mapRecap(row, applicationId) : null;
}

export function getInterviewReview(applicationId: number, interviewId: number, recapId?: number) {
  const context = roundContext(applicationId, interviewId);
  const questions = readQuestions(interviewId);
  const latest = latestRecap(interviewId, applicationId);
  const history = getDb().prepare(`SELECT id, created_at, input_hash FROM application_interview_recaps
    WHERE interview_id = ? ORDER BY id DESC`).all(interviewId) as { id: number; created_at: string; input_hash: string }[];
  let selected: InterviewRecap | null = null;
  if (recapId !== undefined) {
    if (!Number.isSafeInteger(recapId) || recapId <= 0) throw new InterviewReviewError("无效的复盘记录 ID");
    const row = getDb().prepare("SELECT * FROM application_interview_recaps WHERE id = ? AND interview_id = ?")
      .get(recapId, interviewId) as RecapRow | undefined;
    if (!row) throw new InterviewReviewError("复盘记录不存在", 404);
    selected = mapRecap(row, applicationId);
  }
  return { questions, input_hash: hashReviewInput(context, questions), latest, selected, history };
}

export function exportInterviewReview(applicationId: number, interviewId: number, recapId: unknown, action: unknown) {
  if (typeof recapId !== "number" || !Number.isSafeInteger(recapId) || recapId <= 0) throw new InterviewReviewError("无效的复盘记录 ID");
  if (action !== "mistakes" && action !== "drills" && action !== "resume_suggestions") throw new InterviewReviewError("无效的复盘操作");
  const confirmedRecapId = recapId;
  const kind: ReviewExportAction = action;
  return inTransaction(() => {
    const context = roundContext(applicationId, interviewId);
    const row = getDb().prepare("SELECT * FROM application_interview_recaps WHERE id = ? AND interview_id = ?")
      .get(recapId, interviewId) as RecapRow | undefined;
    if (!row) throw new InterviewReviewError("复盘记录不存在", 404);
    const recap = mapRecap(row, applicationId);
    const entries = recap.result[action];
    if (!entries.length) throw new InterviewReviewError("当前复盘没有可处理的结果");
    const db = getDb();
    const timestamp = now();
    const targetTable = action === "mistakes" ? "notebook_entries" : action === "drills" ? "drills" : "application_preparation_tasks";
    const existing = db.prepare(`SELECT e.id, e.item_index, COALESCE(t.id, 0) AS target_id
      FROM application_interview_recap_exports e LEFT JOIN ${targetTable} t ON t.id = e.target_id
      WHERE e.recap_id = ? AND e.kind = ?`)
      .all(recapId, action) as { id: number; item_index: number; target_id: number }[];
    const byIndex = new Map(existing.map((item) => [item.item_index, item]));
    function targetAt(index: number): { exportId: number; targetId: number } {
      const stored = byIndex.get(index);
      if (stored?.target_id) {
        return { exportId: stored.id, targetId: stored.target_id };
      }
      const exportId = stored?.id ?? Number(db.prepare(`INSERT INTO application_interview_recap_exports
        (recap_id, kind, item_index) VALUES (?, ?, ?)`).run(confirmedRecapId, kind, index).lastInsertRowid);
      return { exportId, targetId: 0 };
    }
    function saveTarget(exportId: number, targetId: number) {
      db.prepare("UPDATE application_interview_recap_exports SET target_id = ? WHERE id = ?").run(targetId, exportId);
    }

    let drillId: number | null = null;
    if (action === "mistakes") {
      const insertReview = db.prepare("INSERT OR IGNORE INTO review_cards (notebook_id, next_review_date, created_at) VALUES (?, ?, ?)");
      const reviewDate = getReviewDate(new Date(timestamp));
      recap.result.mistakes.forEach((item, index) => {
        const { exportId, targetId } = targetAt(index);
        if (targetId) return;
        const source = recap.questions[item.question_index - 1]!;
        const inserted = db.prepare(`INSERT INTO notebook_entries
          (source, source_id, source_label, question, answer, comment, reference, created_at, updated_at)
          VALUES ('application_interview', ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          exportId, `${context.company} · ${context.round_name}`, source.question, source.answer,
          item.gap, item.improved_answer, timestamp, timestamp);
        const notebookId = Number(inserted.lastInsertRowid);
        saveTarget(exportId, notebookId);
        insertReview.run(notebookId, reviewDate, timestamp);
        db.prepare("INSERT OR IGNORE INTO application_preparation_resources (application_id, notebook_id) VALUES (?, ?)")
          .run(applicationId, notebookId);
      });
    } else if (action === "drills") {
      const { exportId, targetId } = targetAt(0);
      drillId = targetId;
      if (!drillId) {
        const inserted = db.prepare(`INSERT INTO drills (source, jd, focus, created_at) VALUES ('interview', ?, ?, ?)`)
          .run(context.jd, `真实面试 · ${context.company} · ${context.round_name}`, timestamp);
        drillId = Number(inserted.lastInsertRowid);
        const insertQuestion = db.prepare("INSERT INTO drill_questions (drill_id, idx, question) VALUES (?, ?, ?)");
        recap.result.drills.forEach((item, index) => insertQuestion.run(drillId, index + 1, item.question));
        saveTarget(exportId, drillId);
      }
    } else {
      // roundContext 已在当前写事务中校验投递与轮次，无需逐项重载投递详情。
      const insertTask = db.prepare("INSERT INTO application_preparation_tasks (application_id, title, due_time, created_at) VALUES (?, ?, '', ?)");
      recap.result.resume_suggestions.forEach((item, index) => {
        const { exportId, targetId } = targetAt(index);
        if (targetId) return;
        const title = `简历修改 · 第 ${item.question_index} 题：${item.suggestion}`;
        const suffix = `…（详见复盘 #${recapId}）`;
        const task = insertTask.run(applicationId, (title.length <= 200 ? title : `${title.slice(0, 200 - suffix.length)}${suffix}`).trim(), timestamp);
        saveTarget(exportId, Number(task.lastInsertRowid));
      });
    }
    return { ...getInterviewReview(applicationId, interviewId, recapId), drill_id: drillId };
  });
}

export function saveInterviewQuestions(applicationId: number, interviewId: number, input: unknown, expectedHash: string) {
  const questions = normalizeQuestions(input);
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new InterviewReviewError("逐题记录版本无效");
  return inTransaction(() => {
    const context = roundContext(applicationId, interviewId);
    const current = readQuestions(interviewId);
    if (hashReviewInput(context, current) !== expectedHash) throw new InterviewReviewError("面试或投递资料已变化，请刷新后重试", 409);
    if (JSON.stringify(current) !== JSON.stringify(questions)) {
      const db = getDb();
      db.prepare("DELETE FROM application_interview_questions WHERE interview_id = ?").run(interviewId);
      const insert = db.prepare(`INSERT INTO application_interview_questions
        (interview_id, position, question, answer, stuck, feedback, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
      const timestamp = now();
      questions.forEach((item, index) => insert.run(interviewId, index + 1, item.question, item.answer, item.stuck, item.feedback, timestamp));
      db.prepare("UPDATE application_interviews SET updated_at = ? WHERE id = ?").run(timestamp, interviewId);
    }
    return getInterviewReview(applicationId, interviewId);
  });
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 4000;
}

function parseResult(raw: string, questionCount: number): InterviewReviewResult {
  let value: unknown;
  try { value = extractJson<unknown>(raw); } catch { throw new InterviewReviewError("AI 未返回有效复盘结果，请重试", 502); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InterviewReviewError("AI 未返回有效复盘结果，请重试", 502);
  const source = value as Record<string, unknown>;
  function entries(key: keyof InterviewReviewResult, fields: readonly string[]) {
    const rows = source[key];
    if (!Array.isArray(rows) || rows.length > 20) throw new InterviewReviewError("AI 未返回有效复盘结果，请重试", 502);
    return rows.map((item): Record<string, unknown> => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new InterviewReviewError("AI 未返回有效复盘结果，请重试", 502);
      const entry = item as Record<string, unknown>;
      if (!Number.isSafeInteger(entry.question_index) || (entry.question_index as number) < 1 || (entry.question_index as number) > questionCount ||
          !fields.every((field) => validText(entry[field]))) throw new InterviewReviewError("AI 未返回有效复盘结果，请重试", 502);
      return entry;
    });
  }
  return {
    mistakes: entries("mistakes", ["gap", "improved_answer"]).map((item) => ({
      question_index: item.question_index as number,
      gap: (item.gap as string).trim(),
      improved_answer: (item.improved_answer as string).trim(),
    })),
    drills: entries("drills", ["question"]).map((item) => ({
      question_index: item.question_index as number,
      question: (item.question as string).trim(),
    })),
    resume_suggestions: entries("resume_suggestions", ["suggestion"]).map((item) => ({
      question_index: item.question_index as number,
      suggestion: (item.suggestion as string).trim(),
    })),
  };
}

function promptParts(context: RoundContext, questions: InterviewReviewQuestion[]): PromptPart[] {
  const parts: PromptPart[] = [
    { trust: "trusted", text: "【公司】\n" }, { trust: "untrusted", tag: "company", text: context.company },
    { trust: "trusted", text: "\n【岗位】\n" }, { trust: "untrusted", tag: "role", text: context.role },
    { trust: "trusted", text: "\n【岗位要求】\n" }, { trust: "untrusted", tag: "job_description", text: context.jd },
    { trust: "trusted", text: "\n【投递简历快照】\n" }, { trust: "untrusted", tag: "resume_snapshot", text: context.resume_snapshot },
  ];
  questions.forEach((item, index) => {
    parts.push({ trust: "trusted", text: `\n【第 ${index + 1} 题】\n问了什么：` }, { trust: "untrusted", tag: "interview_question", text: item.question },
      { trust: "trusted", text: "\n怎么回答：" }, { trust: "untrusted", tag: "candidate_answer", text: item.answer },
      { trust: "trusted", text: "\n卡在哪里：" }, { trust: "untrusted", tag: "stuck_point", text: item.stuck },
      { trust: "trusted", text: "\n对方反馈：" }, { trust: "untrusted", tag: "interviewer_feedback", text: item.feedback });
  });
  return parts;
}

export async function confirmInterviewReview(applicationId: number, interviewId: number, expectedHash: string, signal?: AbortSignal) {
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new InterviewReviewError("逐题记录版本无效");
  const context = roundContext(applicationId, interviewId);
  const questions = readQuestions(interviewId);
  if (!questions.length) throw new InterviewReviewError("请先保存至少一题，再确认复盘");
  if (hashReviewInput(context, questions) !== expectedHash) throw new InterviewReviewError("面试或投递资料已变化，请刷新后重试", 409);
  const existing = latestRecap(interviewId, applicationId);
  if (existing?.input_hash === expectedHash) return getInterviewReview(applicationId, interviewId);

  const release = acquireCommandLock(`real-interview-review:${interviewId}`);
  if (!release) throw new InterviewReviewError("这轮面试正在生成复盘，请稍候", 409);
  try {
    let raw: string;
    try {
      raw = await safeChat("summary", { feature: LLM_FEATURES.realInterviewReview }, SYSTEM_PROMPT,
        [{ role: "user", parts: promptParts(context, questions) }], { signal, requireJson: true });
    } catch (error) {
      if (error instanceof ModelInputBudgetError) throw new InterviewReviewError(error.message);
      throw new InterviewReviewError("AI 生成失败，请检查模型设置后重试", 502);
    }
    const result = parseResult(raw, questions.length);
    return inTransaction(() => {
      const currentContext = roundContext(applicationId, interviewId);
      if (JSON.stringify(currentContext) !== JSON.stringify(context) || hashReviewInput(currentContext, readQuestions(interviewId)) !== expectedHash) {
        throw new InterviewReviewError("面试或投递资料已变化，请刷新后重新确认", 409);
      }
      const duplicate = latestRecap(interviewId, applicationId);
      if (duplicate?.input_hash !== expectedHash) {
        getDb().prepare(`INSERT INTO application_interview_recaps (interview_id, input_hash, questions, result, created_at)
          VALUES (?, ?, ?, ?, ?)`).run(interviewId, expectedHash, JSON.stringify(questions), JSON.stringify(result), now());
      }
      return getInterviewReview(applicationId, interviewId);
    });
  } finally {
    release();
  }
}
