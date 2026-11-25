import { getDb } from "@/lib/db";

import { ModelProtocolError } from "@/lib/model-protocol";
import { STANDALONE_DRILL_QUESTION_MAX_CHARS } from "@/lib/prompt-guidelines";
import { hasQuestionContent, questionComparisonKey } from "@/lib/question-normalization";

export const MAX_DRILL_QUESTIONS = 20;

/** 新生成题目必须整体有效，不通过丢项、去重或补空题型掩盖错误。 */
export function parseQuestionItems(raw: string, options: { maxCount: number; project?: boolean }): { question: string; kind: string }[] {
  const questions: { question: string; kind: string }[] = [];
  const seen = new Set<string>();
  const parsed = JSON.parse(raw) as { questions?: unknown } | null;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !Array.isArray(parsed.questions)) {
    throw new ModelProtocolError("AI 生成结果必须包含 questions 数组，请重试");
  }
  if (Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, "questions")) {
    throw new ModelProtocolError("AI 生成结果包含未声明字段，请重试");
  }
  if (parsed.questions.length < 1 || parsed.questions.length > Math.min(options.maxCount, MAX_DRILL_QUESTIONS)) {
    throw new ModelProtocolError("AI 生成的题目数量必须在 1 到本次请求上限之间，请重试");
  }
  for (const item of parsed.questions) {
    let text: unknown;
    let kind = "";
    if (options.project) {
      text = item;
    } else {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new ModelProtocolError("AI 岗位或追练题必须包含 question 与 kind，请重试");
      }
      const entry = item as Record<string, unknown>;
      if (Object.keys(entry).length !== 2 || !Object.hasOwn(entry, "question") || !Object.hasOwn(entry, "kind")) {
        throw new ModelProtocolError("AI 岗位或追练题包含未声明字段，请重试");
      }
      text = entry.question;
      if (entry.kind !== "tech" && entry.kind !== "behavior") {
        throw new ModelProtocolError("AI 题型 kind 必须为 tech 或 behavior，请重试");
      }
      kind = entry.kind;
    }
    if (typeof text !== "string" || !text.trim()) {
      throw new ModelProtocolError("AI 题目必须是非空文本，请重试");
    }
    const question = text.trim();
    if (question.length > STANDALONE_DRILL_QUESTION_MAX_CHARS) {
      throw new ModelProtocolError(`AI 题目不能超过 ${STANDALONE_DRILL_QUESTION_MAX_CHARS} 字符，请重试`);
    }
    if (!hasQuestionContent(question)) {
      throw new ModelProtocolError("AI 题目不能只有标点或不可见字符，请重试");
    }
    const comparisonKey = questionComparisonKey(question);
    if (seen.has(comparisonKey)) {
      throw new ModelProtocolError("AI 生成了重复题目，请重试");
    }
    seen.add(comparisonKey);
    questions.push({ question, kind });
  }
  return questions;
}

/** Generated questions are normalized by their parser; source snapshots stay literal here. */
export function insertQuestions(drillId: number, items: { question: string; kind: string }[]) {
  const db = getDb();
  const insert = db.prepare(
    "INSERT INTO drill_questions (drill_id, idx, question, kind) VALUES (?, ?, ?, ?)"
  );
  items.forEach((item, i) => insert.run(drillId, i + 1, item.question, item.kind));
}
