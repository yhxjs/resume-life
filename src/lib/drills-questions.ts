import { getDb } from "@/lib/db";

import { extractJson } from "@/lib/llm";

export const MAX_DRILL_QUESTIONS = 20;

/** 解析 LLM 返回的题目列表：字符串项 kind 留空，对象项归一化 kind（漏标不强行当作八股），题目去重 */
export function parseQuestionItems(raw: string): { question: string; kind: string }[] {
  const questions: { question: string; kind: string }[] = [];
  const seen = new Set<string>();
  const parsed = extractJson<{ questions?: unknown }>(raw);
  if (!Array.isArray(parsed.questions)) return questions;
  for (const item of parsed.questions) {
    if (typeof item === "string" && item.trim()) {
      if (!seen.has(item.trim())) {
        seen.add(item.trim());
        questions.push({ question: item.trim(), kind: "" });
      }
      continue;
    }
    const o = item as { question?: unknown; kind?: unknown };
    if (typeof o?.question === "string" && o.question.trim()) {
      const text = o.question.trim();
      if (!seen.has(text)) {
        seen.add(text);
        questions.push({
          question: text,
          kind: o.kind === "tech" || o.kind === "behavior" ? o.kind : "",
        });
      }
    }
  }
  return questions;
}

export function insertQuestions(drillId: number, items: { question: string; kind: string }[]) {
  const db = getDb();
  const insert = db.prepare(
    "INSERT INTO drill_questions (drill_id, idx, question, kind) VALUES (?, ?, ?, ?)"
  );
  items.forEach((item, i) => insert.run(drillId, i + 1, item.question.trim(), item.kind));
}
