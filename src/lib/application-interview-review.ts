import { createHash } from "node:crypto";
import { acquireCommandLock, getDb, inTransaction, now } from "@/lib/db";
import { safeChat, LLM_FEATURES, type PromptPart, type SafeMessage } from "@/lib/safe-llm";
import {
  INTERVIEW_QUESTION_RULES,
  REFERENCE_ANSWER_RULES,
  STANDALONE_DRILL_QUESTION_MAX_CHARS,
  STANDALONE_DRILL_QUESTION_RULES,
} from "@/lib/prompt-guidelines";
import { ModelInputBudgetError } from "@/lib/llm-input-budget";
import { getReviewDate } from "@/lib/spaced-repetition";
import { formatResumeContext } from "@/lib/resumes";
import { assertResumeModelModules } from "@/lib/resume-model-material";
import { ResumeContextError } from "@/lib/resume-errors";
import { hasQuestionContent, questionComparisonKey } from "@/lib/question-normalization";
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
  source_context: InterviewRecapSourceContext | null;
  exports: { mistakes: boolean; drills: number | null; resume_suggestions: boolean };
  created_at: string;
};

export type InterviewRecapSourceContext = {
  company: string;
  role: string;
  round_name: string;
  jd: string;
};

export type InterviewReviewResponse = {
  questions: InterviewReviewQuestion[];
  input_hash: string | null;
  material_error: string | null;
  latest: InterviewRecap | null;
  selected: InterviewRecap | null;
  history: { id: number; created_at: string; input_hash: string }[];
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
type RecapRow = Omit<InterviewRecap, "application_id" | "questions" | "result" | "exports" | "source_context"> & { questions: string; result: string };

const REVIEW_RESULT_MAX_TEXT_CHARS = 4000;
export const REVIEW_RESUME_SUGGESTION_MAX_CHARS = 180;

export const INTERVIEW_REVIEW_SYSTEM_PROMPT = `你是求职者的面试复盘教练。依据求职者事后整理的逐题记录，提炼有依据的卡点、练习题与简历建议。
材料边界：
- 记录是事后整理，可能不完整或并非逐字原话。回答为空或写“记不清”只表示未记录或无法回忆，不等于现场没有回答、回答错误或不具备能力。评价只落在已记录内容：缺少信息写明“记录尚未说明”，不反推现场遗漏、表达组织或原因；自述犹豫也不能还原现场表现。明确记录的卡点按自述说明来源，题干未要求的内容不能算失分点。
- “卡在哪里”是候选人的自我感受，“对方反馈”是候选人转述；结合已记录回答核对，不把自我怀疑、揣测或转述升级为已证实的能力结论，也不臆造面试官原话、心理或未通过的原因。缺少原答时明确依据是自述卡点或转述反馈。
- JD 是岗位要求，简历快照是候选人提供的经历材料，都不能补成现场已经说过的回答；公司名不能用于猜测内部评价标准。结合题干确定原答主体：询问团队流程时，省略主语的步骤仍归团队，不改成本人已执行的动作。只有原记录确认本人参与，才能据此改写个人经历或建议写入简历；主体不明时保留待核实。
- 原答或简历“未提供某项信息”只表示本次材料未知，不改写为候选人没有做过、没有数据或尚未上线。未提供收益时，示范与建议可以省略收益或写待核实，不能替用户认定未验证、未参与设计或未发布；明确否定也只保留原动作与范围。
- 结合全部逐题记录核对同一经历。后题明确更正前题的项目、职责或指标归属时，在更正范围内撤回旧说法，保留其他仍有依据的工作与原题号；更正仍是候选人自述，不等于独立核实。矛盾未澄清时指出具体冲突，不仅凭题号靠后就认定更可靠；“记不清”不等于否认或证实。
- 知识解释与假设方案可用于讨论理解和推理，不能证明本人已实施、主导、上线或取得收益；也不因假设技术不同于实际经历就认定简历矛盾。mistakes、drills、resume_suggestions 均保留假设、个人分工、未上线和未验证等限定，不把题干示例、转述反馈或练习示范补成既往事实。
处理规则：
- mistakes 先核对本题实际要求，再收录记录中有依据的错误或明确记录的卡点。问职责或状态时，范围已交代清楚就不因缺少具体案例、步骤或成果另造缺项；问方法或依据时才核对对应要点。可选展开不作为错误，只有题干、记忆缺口或笼统担忧时可为 []，没有适用项返回 []。gap 指明对应证据与记录局限，improved_answer 是练习示范，不是对现场回答的还原。
- drills 先按所求信息对照全部原题和本批新题，不得与本次任何原题重复，也不得与其他追练题重复或仅换措辞。仅把职责或工作范围题缩到某次，再问具体做了什么，仍是同一目标；换说话人、纠正错误前提或增加表达模板也不构成新目标。同主题可问原题尚未要求的具体输入、观察或判断依据，也可改变影响答案的实质条件；这些是可选方向，已被原题覆盖时仍不可重问。若只需重述原题所求内容即可作答，就换一个目标，不靠案例数量或措辞判新。每道原题最多一道中性新题，以原 question_index 进入数组；一题一个主要信息，不预设能力缺陷。没有新目标则跳过，均不适用时返回 []。
- resume_suggestions 应对应具体表达或证据缺口，不编造经历、指标或未提供的简历内容；单次回答或记忆缺口不能证明简历失实，没有可靠建议时用 []。
输出 JSON：
{"mistakes":[],"drills":[],"resume_suggestions":[]}。
有适用项时，各数组元素严格使用以下字段与类型（这是结构说明，不是必须填充的示例）：
- mistakes：{"question_index":整数题号,"gap":"有依据的卡点与记录局限","improved_answer":"保留事实限定的练习示范"}。
- drills：{"question_index":整数题号,"question":"不与原题或其他追练题重复的完整新问题"}。
- resume_suggestions：{"question_index":整数题号,"suggestion":"有依据的简历建议"}。
三个数组必须全部返回，无适用项时用 []，允许三个数组均为空，不为每道题凑齐三类结果。顶层只返回 mistakes、drills、resume_suggestions；每项只返回 question_index 和该数组对应的文本字段，不增加其他键。question_index 必须是输入中的 JSON 整数题号，不按结果顺序重新编号，每类数组同一题最多一项；所有结果文本须包含可见内容且不超过 ${REVIEW_RESULT_MAX_TEXT_CHARS} 字符，不得用纯标点、零宽或控制字符占位；保留完整句意与事实限定。resume_suggestions.suggestion 另限 ${REVIEW_RESUME_SUGGESTION_MAX_CHARS} 字，须能与题号前缀一起完整放入 200 字待办标题。只输出 JSON。
${REFERENCE_ANSWER_RULES}
${INTERVIEW_QUESTION_RULES}
${STANDALONE_DRILL_QUESTION_RULES}`;

type StoredRoundContext = Omit<RoundContext, "resume_snapshot"> & { resume_snapshot: string | null };

// 历史读取和导出只依赖轮次归属，不要求当前简历可用于新生成。
function readRound(applicationId: number, interviewId: number): StoredRoundContext {
  if (!Number.isSafeInteger(applicationId) || applicationId <= 0 || !Number.isSafeInteger(interviewId) || interviewId <= 0) {
    throw new InterviewReviewError("无效的投递或面试轮次 ID");
  }
  const row = getDb().prepare(`SELECT i.id, i.application_id, i.round_name, a.company, a.role, a.jd,
    CASE WHEN a.submitted_at IS NOT NULL THEN a.submitted_resume ELSE rv.snapshot END AS resume_snapshot
    FROM application_interviews i JOIN applications a ON a.id = i.application_id
    LEFT JOIN resume_versions rv ON rv.id = a.resume_version_id
    WHERE i.id = ? AND i.application_id = ?`).get(interviewId, applicationId) as
      StoredRoundContext | undefined;
  if (!row) throw new InterviewReviewError("面试轮次记录不存在", 404);
  return row;
}

function modelRoundContext(row: StoredRoundContext): RoundContext {
  if (row.resume_snapshot === null) return { ...row, resume_snapshot: "" };
  try {
    const snapshot = JSON.parse(row.resume_snapshot) as ResumeSnapshot;
    // 与其他模型入口一致：先校验原始职业字段，再格式化；提交复核也不能静默丢弃损坏字段。
    assertResumeModelModules(snapshot.modules);
    return { ...row, resume_snapshot: formatResumeContext(snapshot.modules) };
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) throw new ResumeContextError();
    throw error;
  }
}

function roundContext(applicationId: number, interviewId: number): RoundContext {
  return modelRoundContext(readRound(applicationId, interviewId));
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

function readRecapSourceContext(recapId: number): InterviewRecapSourceContext | null {
  return (getDb().prepare("SELECT company, role, round_name, jd FROM application_interview_recap_contexts WHERE recap_id = ?")
    .get(recapId) as InterviewRecapSourceContext | undefined) ?? null;
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
  return { ...row, application_id: applicationId, questions: JSON.parse(row.questions), result, source_context: readRecapSourceContext(row.id), exports: {
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

export function getInterviewReview(applicationId: number, interviewId: number, recapId?: number): InterviewReviewResponse {
  const storedContext = readRound(applicationId, interviewId);
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
  let inputHash: string | null = null;
  let materialError: string | null = null;
  try {
    inputHash = hashReviewInput(modelRoundContext(storedContext), questions);
  } catch (error) {
    if (!(error instanceof ResumeContextError)) throw error;
    materialError = error.message;
  }
  return { questions, input_hash: inputHash, material_error: materialError, latest, selected, history };
}

export function exportInterviewReview(applicationId: number, interviewId: number, recapId: unknown, action: unknown) {
  if (typeof recapId !== "number" || !Number.isSafeInteger(recapId) || recapId <= 0) throw new InterviewReviewError("无效的复盘记录 ID");
  if (action !== "mistakes" && action !== "drills" && action !== "resume_suggestions") throw new InterviewReviewError("无效的复盘操作");
  const confirmedRecapId = recapId;
  const kind: ReviewExportAction = action;
  return inTransaction(() => {
    readRound(applicationId, interviewId);
    const row = getDb().prepare("SELECT * FROM application_interview_recaps WHERE id = ? AND interview_id = ?")
      .get(recapId, interviewId) as RecapRow | undefined;
    if (!row) throw new InterviewReviewError("复盘记录不存在", 404);
    const recap = mapRecap(row, applicationId);
    const sourceContext = recap.source_context;
    // 旧版本未保存岗位资料；保持可导出，但不能用今天的资料冒充当时的来源。
    const sourceLabel = sourceContext ? `${sourceContext.company} · ${sourceContext.round_name}` : `真实面试复盘 #${recapId}（生成时岗位资料未保存）`;
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
          exportId, sourceLabel, source.question, source.answer,
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
          .run(sourceContext?.jd ?? "", sourceContext ? `真实面试 · ${sourceLabel}` : sourceLabel, timestamp);
        drillId = Number(inserted.lastInsertRowid);
        const insertQuestion = db.prepare("INSERT INTO drill_questions (drill_id, idx, question) VALUES (?, ?, ?)");
        recap.result.drills.forEach((item, index) => insertQuestion.run(drillId, index + 1, item.question));
        saveTarget(exportId, drillId);
      }
    } else {
      // readRound 已在当前写事务中校验投递与轮次，无需逐项重载投递详情。
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

export function saveInterviewQuestions(applicationId: number, interviewId: number, input: unknown, expectedHash: unknown) {
  const questions = normalizeQuestions(input);
  if (typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/.test(expectedHash)) throw new InterviewReviewError("逐题记录版本无效");
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

function validText(value: unknown, maxChars = REVIEW_RESULT_MAX_TEXT_CHARS): value is string {
  return typeof value === "string" && value.trim().length > 0 && hasQuestionContent(value) && value.length <= maxChars;
}

export function parseInterviewReviewResult(raw: string, questions: readonly InterviewReviewQuestion[]): InterviewReviewResult {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new InterviewReviewError("AI 未返回有效复盘结果，请重试", 502); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InterviewReviewError("AI 未返回有效复盘结果，请重试", 502);
  const source = value as Record<string, unknown>;
  const exactKeys = (record: Record<string, unknown>, keys: readonly string[]) =>
    Object.keys(record).length === keys.length && keys.every((key) => Object.hasOwn(record, key));
  if (!exactKeys(source, ["mistakes", "drills", "resume_suggestions"])) throw new InterviewReviewError("AI 未返回有效复盘结果，请重试", 502);
  function entries(key: keyof InterviewReviewResult, fields: readonly string[], maxTextChars = REVIEW_RESULT_MAX_TEXT_CHARS) {
    const rows = source[key];
    if (!Array.isArray(rows) || rows.length > 20) throw new InterviewReviewError("AI 未返回有效复盘结果，请重试", 502);
    const questionIndexes = new Set<number>();
    return rows.map((item): Record<string, unknown> => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new InterviewReviewError("AI 未返回有效复盘结果，请重试", 502);
      const entry = item as Record<string, unknown>;
      if (!exactKeys(entry, ["question_index", ...fields])) throw new InterviewReviewError("AI 未返回有效复盘结果，请重试", 502);
      if (!Number.isSafeInteger(entry.question_index) || (entry.question_index as number) < 1 || (entry.question_index as number) > questions.length ||
          !fields.every((field) => validText(entry[field], maxTextChars))) throw new InterviewReviewError("AI 未返回有效复盘结果，请重试", 502);
      const questionIndex = entry.question_index as number;
      if (questionIndexes.has(questionIndex)) throw new InterviewReviewError("AI 未返回有效复盘结果，请重试", 502);
      questionIndexes.add(questionIndex);
      return entry;
    });
  }
  const originalQuestions = new Set(questions.map((item) => questionComparisonKey(item.question)));
  const generatedQuestions = new Set<string>();
  const drills = entries("drills", ["question"], STANDALONE_DRILL_QUESTION_MAX_CHARS).map((item) => {
    const question = (item.question as string).trim();
    if (!hasQuestionContent(question)) {
      throw new InterviewReviewError("AI 追练题不能只有标点或不可见字符，请重试", 502);
    }
    const comparisonKey = questionComparisonKey(question);
    if (originalQuestions.has(comparisonKey) || generatedQuestions.has(comparisonKey)) {
      throw new InterviewReviewError("AI 追练题与原题或其他追练题重复，请重试", 502);
    }
    generatedQuestions.add(comparisonKey);
    return { question_index: item.question_index as number, question };
  });
  return {
    mistakes: entries("mistakes", ["gap", "improved_answer"]).map((item) => ({
      question_index: item.question_index as number,
      gap: (item.gap as string).trim(),
      improved_answer: (item.improved_answer as string).trim(),
    })),
    drills,
    resume_suggestions: entries("resume_suggestions", ["suggestion"], REVIEW_RESUME_SUGGESTION_MAX_CHARS).map((item) => ({
      question_index: item.question_index as number,
      suggestion: (item.suggestion as string).trim(),
    })),
  };
}

export function buildInterviewReviewMessages(context: {
  company: string;
  role: string;
  jd: string;
  resume_snapshot: string;
}, questions: InterviewReviewQuestion[]): SafeMessage[] {
  const parts: PromptPart[] = [
    { trust: "trusted", text: "【公司】\n" }, { trust: "untrusted", tag: "company", text: context.company },
    { trust: "trusted", text: "\n【岗位】\n" }, { trust: "untrusted", tag: "role", text: context.role },
    { trust: "trusted", text: "\n【岗位要求】\n" }, { trust: "untrusted", tag: "job_description", text: context.jd },
    { trust: "trusted", text: "\n【投递简历快照】\n" }, { trust: "untrusted", tag: "resume_snapshot", text: context.resume_snapshot },
  ];
  questions.forEach((item, index) => {
    parts.push({ trust: "trusted", text: `\n【第 ${index + 1} 题】\n回忆的题目：` }, { trust: "untrusted", tag: "interview_question", text: item.question },
      { trust: "trusted", text: "\n回忆的回答（可能不完整，空白表示未记录）：" }, { trust: "untrusted", tag: "candidate_answer", text: item.answer },
      { trust: "trusted", text: "\n卡在哪里（候选人自述）：" }, { trust: "untrusted", tag: "stuck_point", text: item.stuck },
      { trust: "trusted", text: "\n对方反馈（候选人转述，可能不完整）：" }, { trust: "untrusted", tag: "interviewer_feedback", text: item.feedback });
  });
  return [{ role: "user", parts }];
}

export async function confirmInterviewReview(applicationId: number, interviewId: number, expectedHash: unknown, signal?: AbortSignal) {
  if (typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/.test(expectedHash)) throw new InterviewReviewError("逐题记录版本无效");
  if (signal?.aborted) throw new InterviewReviewError("请求已取消", 499);
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
      raw = await safeChat("summary", { feature: LLM_FEATURES.realInterviewReview }, INTERVIEW_REVIEW_SYSTEM_PROMPT,
        buildInterviewReviewMessages(context, questions), {
          signal,
          requireJson: "strict"
        });
    } catch (error) {
      if (signal?.aborted) throw new InterviewReviewError("请求已取消", 499);
      if (error instanceof ModelInputBudgetError) throw new InterviewReviewError(error.message);
      throw new InterviewReviewError("AI 生成失败，请检查模型设置后重试", 502);
    }
    if (signal?.aborted) throw new InterviewReviewError("请求已取消", 499);
    const result = parseInterviewReviewResult(raw, questions);
    return inTransaction(() => {
      const currentContext = roundContext(applicationId, interviewId);
      if (JSON.stringify(currentContext) !== JSON.stringify(context) || hashReviewInput(currentContext, readQuestions(interviewId)) !== expectedHash) {
        throw new InterviewReviewError("面试或投递资料已变化，请刷新后重新确认", 409);
      }
      const duplicate = latestRecap(interviewId, applicationId);
      if (duplicate?.input_hash !== expectedHash) {
        const recapId = getDb().prepare(`INSERT INTO application_interview_recaps (interview_id, input_hash, questions, result, created_at)
          VALUES (?, ?, ?, ?, ?)`).run(interviewId, expectedHash, JSON.stringify(questions), JSON.stringify(result), now());
        getDb().prepare(`INSERT INTO application_interview_recap_contexts (recap_id, company, role, round_name, jd)
          VALUES (?, ?, ?, ?, ?)`).run(recapId.lastInsertRowid, context.company, context.role, context.round_name, context.jd);
      }
      return getInterviewReview(applicationId, interviewId);
    });
  } finally {
    release();
  }
}
