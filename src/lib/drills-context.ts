import { getDb } from "@/lib/db";

import { bankKindLabel } from "@/lib/bank";

import { collectByCharacterBudget } from "@/lib/budgeted-query";

import { measureWrappedUntrustedData } from "@/lib/prompt-safety";

import { safeScores } from "@/lib/scores";

import type { PromptPart } from "@/lib/safe-llm";

type BankEntry = { id: number; kind: string; question: string };
type InterviewTurnContext = {
  id: number;
  idx: number;
  kind: string;
  question: string;
  answer: string;
  comment: string;
  scores: string;
};

export function promptPartsLength(parts: readonly PromptPart[]): number {
  return parts.reduce(
    (total, part) => total + (
      part.trust === "trusted"
        ? part.text.length
        : measureWrappedUntrustedData(part.tag, part.text)
    ),
    0,
  );
}

export async function loadInterviewTurnParts(interviewId: number, maxChars: number): Promise<PromptPart[]> {
  const db = getDb();
  const result: PromptPart[] = [];
  let cursor = 0;
  let usedChars = 0;
  let index = 0;

  while (usedChars < maxChars) {
    const rows = db
      .prepare(
        "SELECT id, idx, kind, question, answer, comment, scores FROM interview_turns WHERE interview_id = ? AND answered_at != '' AND id > ? ORDER BY id LIMIT ?",
      )
      .all(interviewId, cursor, 50) as InterviewTurnContext[];
    if (rows.length === 0) break;

    for (const turn of rows) {
      if (!(turn.id > cursor)) throw new Error("Cursor must advance strictly");
      cursor = turn.id;
      const scores = safeScores(turn.scores);
      const turnParts: PromptPart[] = [
        ...(index > 0 ? [{ trust: "trusted", text: "\n\n" } as const] : []),
        { trust: "trusted", text: "【问答记录】\n元数据：" },
        {
          trust: "untrusted",
          tag: "turn_metadata",
          text: JSON.stringify({ idx: turn.idx, kind: turn.kind, scores }),
        },
        { trust: "trusted", text: "\n题目：" },
        { trust: "untrusted", tag: "interview_question", text: turn.question },
        { trust: "trusted", text: "\n回答：" },
        { trust: "untrusted", tag: "candidate_answer", text: turn.answer },
        { trust: "trusted", text: "\n点评：" },
        { trust: "untrusted", tag: "model_comment", text: turn.comment },
      ];
      const nextChars = promptPartsLength(turnParts);
      if (usedChars + nextChars > maxChars) return result;
      result.push(...turnParts);
      usedChars += nextChars;
      index += 1;
    }
  }

  return result;
}

/** 按字符预算和 id 游标加载题库参考文本 */
export async function loadBankContext(direction?: string, maxChars = 60_000): Promise<string> {
  const db = getDb();
  const trimmed = direction?.trim() ?? "";
  let index = 0;
  const chunks = await collectByCharacterBudget({
    maxChars,
    batchSize: 50,
    loadAfter: (cursor, limit) => trimmed
      ? db
          .prepare(
            "SELECT id, kind, question FROM bank_entries WHERE direction = ? AND id > ? ORDER BY id LIMIT ?",
          )
          .all(trimmed, cursor, limit) as BankEntry[]
      : db
          .prepare("SELECT id, kind, question FROM bank_entries WHERE id > ? ORDER BY id LIMIT ?")
          .all(cursor, limit) as BankEntry[],
    cursorOf: (entry) => entry.id,
    format: (entry) =>
      `${index++ === 0 ? "" : "\n"}${entry.id}|${bankKindLabel(entry.kind) || "八股"}|${entry.question}`,
  });
  return chunks.join("");
}
