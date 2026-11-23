import { createHash } from "node:crypto";
import { ApplicationInputError } from "./applications";
import { acquireCommandLock, getDb, inTransaction, now } from "./db";
import { loadProjectMaterial } from "./project-materials";
import { verifyScanEvidence } from "./repo-scanner/evidence";
import { challengeQuestion, CHALLENGE_MODES, MAX_EVIDENCE_RECOMMENDATIONS, selectEvidenceRange, type ChallengeMode } from "./evidence-challenge";
import { serializeEvidenceExcerpt } from "./project-evidence-excerpt";
import type { DocumentTableProvenance } from "./document-table-provenance";
import { STANDALONE_DRILL_QUESTION_MAX_CHARS } from "./prompt-guidelines";
import { insertQuestions, parseQuestionItems } from "./drills-questions";
import { loadProjectRow } from "./projects";
import { parseSummary } from "./summary";
import { projectSummaryEvidence } from "./project-summary-evidence";
import { safeChat, LLM_FEATURES } from "./safe-llm";
import { buildEvidenceRecommendationMessages, EVIDENCE_RECOMMENDATION_PROMPT } from "./project-evidence-llm";
import { assertDataGeneration } from "./data-generation";
import { LlmConfigError } from "./llm";
import { ModelInputBudgetError } from "./llm-input-budget";

function readBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApplicationInputError("请求体必须是对象");
  return value as Record<string, unknown>;
}

/** Resolve only server-verified evidence. Both creation paths attach this exact snapshot to every question. */
function resolveEvidenceSnapshot(projectId: number, body: Record<string, unknown>): string | null {
  const project = loadProjectRow(projectId);
  if (!project) return null;
  if ([body.materialId, body.scanFile, body.summaryKey].filter(value => value !== undefined).length !== 1) {
    throw new ApplicationInputError("请选择且只提供一种依据来源");
  }
  let content: string, locator: string, version: string, scope: string;
  let quote = "", location = "";
  let tableProvenance: DocumentTableProvenance | undefined;
  let excerpt = "";
  if (body.summaryKey !== undefined) {
    const section = projectSummaryEvidence(parseSummary(project.summary)).find(section => section.key === body.summaryKey);
    if (!section || section.content !== body.summaryContent) throw new ApplicationInputError("项目档案已变化或章节不存在，请刷新后重新选择");
    if (typeof body.summaryQuote !== "string" || !body.summaryQuote.trim() || body.summaryQuote.length > 280 || !section.content.includes(body.summaryQuote)) {
      throw new ApplicationInputError("请从已保存档案中连续摘取 1–280 字原文，不要改写");
    }
    content = section.content;
    quote = body.summaryQuote;
    const start = content.indexOf(quote) + 1;
    locator = `项目#${projectId} 已保存项目档案 · ${section.label}`;
    location = `第${start}–${start + quote.length - 1}字符`;
    version = createHash("sha256").update(JSON.stringify([projectId, section.key, content])).digest("hex").slice(0, 12);
    scope = "档案二手总结，待核实；不是源码或设计原文";
  } else if (body.materialId !== undefined) {
    if (typeof body.materialId !== "number" || !Number.isSafeInteger(body.materialId) || body.materialId < 1) throw new ApplicationInputError("材料编号无效");
    const material = loadProjectMaterial(projectId, body.materialId);
    if (!material || material.revision !== body.revision) throw new ApplicationInputError("材料已变化或不存在，请重新选择材料");
    content = material.content;
    tableProvenance = material.tableProvenance;
    locator = `材料#${material.id} ${material.title}`;
    version = material.revision.slice(0, 12);
    scope = "保存的提取文本；行号不代表原文档页码";
  } else {
    let file;
    try { file = verifyScanEvidence(body.scanFile, projectId); }
    catch (error) { throw new ApplicationInputError((error as Error).message); }
    content = file.content;
    locator = file.locator;
    version = `${file.capturedAt} / ${createHash("sha256").update(content).digest("hex").slice(0, 12)}`;
    scope = file.truncated ? "扫描前缀，后文未采集" : "扫描时文本，未核验当前仓库";
  }
  if (body.summaryKey === undefined) {
    let range;
    try { range = selectEvidenceRange(content, body.startLine as number, body.endLine as number); }
    catch (error) { throw new ApplicationInputError((error as Error).message); }
    quote = range.quote;
    if (body.materialId !== undefined) excerpt = serializeEvidenceExcerpt(content, range, tableProvenance);
    location = `L${body.startLine}–L${body.endLine}`;
  }
  return `依据快照：${locator} ${location}\n版本：${version}（${scope}）\n${excerpt || `原文摘录：\n${quote}`}`;
}

/** Resolve evidence and create the immutable question in one transaction. Identical retries reuse the drill. */
export function createEvidenceDrill(projectId: number, value: unknown) {
  const body = readBody(value);
  if (!CHALLENGE_MODES.includes(body.mode as ChallengeMode) || typeof body.baseline !== "string" || body.baseline.length > 80
    || typeof body.change !== "string" || body.change.length > 100 || (body.mode === "custom" && !body.change.trim())) {
    throw new ApplicationInputError("请选择追问类型；原条件最多 80 字，变化条件最多 100 字，自定义变化不能为空");
  }
  return inTransaction(() => {
    const db = getDb();
    const snapshot = resolveEvidenceSnapshot(projectId, body);
    if (snapshot === null) return null;
    const question = `${snapshot}\n\n${challengeQuestion({ mode: body.mode as ChallengeMode, baseline: body.baseline as string, change: body.change as string })}`;
    if (question.length > STANDALONE_DRILL_QUESTION_MAX_CHARS) throw new ApplicationInputError("依据与条件合计过长，请缩小行范围或精简条件后重试");
    const existing = db.prepare("SELECT d.id FROM drills d JOIN drill_questions q ON q.drill_id = d.id WHERE d.project_id = ? AND d.source = 'project' AND q.kind = 'evidence' AND q.question = ? ORDER BY d.id DESC LIMIT 1").get(projectId, question) as { id: number } | undefined;
    if (existing) return { id: existing.id, count: 1 };
    const inserted = db.prepare("INSERT INTO drills (source, project_id, focus, created_at) VALUES ('project', ?, '依据与条件变化', ?)").run(projectId, now());
    const id = Number(inserted.lastInsertRowid);
    insertQuestions(id, [{ question, kind: "evidence" }]);
    return { id, count: 1 };
  });
}

export class EvidenceRecommendationError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** Never hold a database transaction across a model call; revalidate the selected evidence before saving. */
export async function recommendEvidenceDrill(projectId: number, value: unknown, signal: AbortSignal) {
  const body = readBody(value);
  if (typeof body.count !== "number" || !Number.isSafeInteger(body.count) || body.count < 1 || body.count > MAX_EVIDENCE_RECOMMENDATIONS) {
    throw new ApplicationInputError(`生成数量须为 1–${MAX_EVIDENCE_RECOMMENDATIONS} 的整数`);
  }
  const count = body.count;
  signal.throwIfAborted();
  const snapshot = inTransaction(() => resolveEvidenceSnapshot(projectId, body));
  if (snapshot === null) return null;
  const separator = "\n\n智能推荐追问（新增场景均为假设）：\n";
  const questionBudget = STANDALONE_DRILL_QUESTION_MAX_CHARS - snapshot.length - separator.length;
  if (questionBudget < 80) throw new ApplicationInputError("依据定位与摘录过长，请缩小摘录后重试");
  const release = acquireCommandLock(`evidence-recommendation:${projectId}`);
  if (!release) throw new EvidenceRecommendationError("该项目正在生成推荐题，请等待完成", 409);
  try {
    let raw: string;
    try {
      raw = await safeChat("question", { feature: LLM_FEATURES.drillProject, entity: { type: "project", id: projectId } },
        EVIDENCE_RECOMMENDATION_PROMPT, buildEvidenceRecommendationMessages(snapshot, count, questionBudget),
        {
          signal,
          requireJson: "strict"
        });
    } catch (error) {
      signal.throwIfAborted();
      assertDataGeneration();
      if (error instanceof ModelInputBudgetError) throw new EvidenceRecommendationError(error.message, 413);
      throw new EvidenceRecommendationError(error instanceof LlmConfigError ? error.message : "智能推荐暂时未能完成，请稍后重试", 502);
    }
    signal.throwIfAborted();
    let questions: { question: string; kind: string }[];
    try {
      questions = parseQuestionItems(raw, { maxCount: body.count, project: true });
      if (questions.some(item => item.question.length > questionBudget)) throw new Error("question too long");
    } catch {
      throw new EvidenceRecommendationError("AI 返回的题目数量、长度或内容不符合要求，本次未保存，请重试", 502);
    }
    return inTransaction(() => {
      signal.throwIfAborted();
      // Includes deletion, material revisions, archive edits, receipt expiry and data-generation changes.
      if (resolveEvidenceSnapshot(projectId, body) !== snapshot) throw new ApplicationInputError("所选依据已变化或项目已删除，请刷新后重新生成");
      const inserted = getDb().prepare("INSERT INTO drills (source, project_id, focus, created_at) VALUES ('project', ?, '依据深挖 · 智能推荐', ?)").run(projectId, now());
      const id = Number(inserted.lastInsertRowid);
      insertQuestions(id, questions.map(item => ({ question: `${snapshot}${separator}${item.question}`, kind: "evidence" })));
      return { id, count: questions.length, questions: questions.map(item => item.question) };
    });
  } finally { release(); }
}
