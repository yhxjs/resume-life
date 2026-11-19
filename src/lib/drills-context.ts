import { getDb } from "@/lib/db";

import { serializeBankQuestion } from "@/lib/drill-question-llm";

import { measureWrappedUntrustedData } from "@/lib/prompt-safety";
import { questionComparisonKey } from "@/lib/question-normalization";

import { ModelInputBudgetError } from "@/lib/llm-input-budget";

import type { PromptPart } from "@/lib/safe-llm";
import { buildInterviewRemediationQuestionParts, buildInterviewRemediationTurnParts } from "@/lib/drill-remediation-llm";

type BankEntry = { id: number; kind: string; question: string };
type InterviewTurnContext = {
  id: number;
  idx: number;
  kind: string;
  answer: string;
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

/** 完整原题用于去重，包含未作答题；不能截掉尾部后声称已避开全部原题。 */
export function loadInterviewQuestionContext(interviewId: number, maxChars: number): {
  parts: PromptPart[];
  questions: Set<string>;
} {
  const emptyParts = buildInterviewRemediationQuestionParts([]);
  let usedChars = promptPartsLength(emptyParts);
  if (usedChars > maxChars) throw new ModelInputBudgetError("完整原题清单超过追练输入预算，无法可靠避免重复原题");
  const db = getDb();
  const entries: string[] = [];
  const questionRecords: { idx: number; kind: string; question: string }[] = [];
  const questions = new Set<string>();
  let cursor = 0;
  const tag = "interview_original_questions";
  const wrapperChars = measureWrappedUntrustedData(tag, "");
  while (true) {
    const rows = db.prepare(
      "SELECT id, idx, kind, question FROM interview_turns WHERE interview_id = ? AND id > ? ORDER BY id LIMIT ?"
    ).all(interviewId, cursor, 50) as { id: number; idx: number; kind: string; question: string }[];
    if (rows.length === 0) break;
    for (const turn of rows) {
      if (!(turn.id > cursor)) throw new Error("Cursor must advance strictly");
      cursor = turn.id;
      const entry = JSON.stringify({ idx: turn.idx, kind: turn.kind, question: turn.question });
      usedChars += measureWrappedUntrustedData(tag, entry) - wrapperChars + (entries.length ? 1 : 0);
      if (usedChars > maxChars) throw new ModelInputBudgetError("完整原题清单超过追练输入预算，无法可靠避免重复原题");
      entries.push(entry);
      questionRecords.push({ idx: turn.idx, kind: turn.kind, question: turn.question });
      questions.add(questionComparisonKey(turn.question));
    }
  }
  return { parts: buildInterviewRemediationQuestionParts(questionRecords), questions };
}

/** 题干已由完整原题清单提供；只按原答计预算，旧评分与点评不挤占作答证据。 */
export function loadInterviewTurnParts(interviewId: number, maxChars: number): PromptPart[] {
  const db = getDb();
  const records: { parts: PromptPart[]; chars: number }[] = [];
  const omitted: PromptPart = { trust: "trusted", text: "\n\n【材料范围】受输入预算限制，后续问答未提供；不能将省略内容视为候选人未回答或不会。" };
  const omittedChars = promptPartsLength([omitted]);
  let cursor = 0;
  let usedChars = 0;

  while (true) {
    const rows = db
      .prepare(
        "SELECT id, idx, kind, answer FROM interview_turns WHERE interview_id = ? AND answered_at != '' AND id > ? ORDER BY id LIMIT ?",
      )
      .all(interviewId, cursor, 50) as InterviewTurnContext[];
    if (rows.length === 0) break;

    for (const turn of rows) {
      if (!(turn.id > cursor)) throw new Error("Cursor must advance strictly");
      cursor = turn.id;
      const turnParts = buildInterviewRemediationTurnParts([{ idx: turn.idx, kind: turn.kind, answer: turn.answer }]);
      if (records.length > 0) turnParts.unshift({ trust: "trusted", text: "\n\n" });
      const nextChars = promptPartsLength(turnParts);
      if (usedChars + nextChars > maxChars) {
        // 只有确认发生省略后才为范围提示腾空间，按整条原答回退，不截断原文。
        while (records.length > 0 && usedChars + omittedChars > maxChars) {
          usedChars -= records.pop()!.chars;
        }
        return [
          ...records.flatMap((record) => record.parts),
          ...(omittedChars <= maxChars ? [omitted] : []),
        ];
      }
      records.push({ parts: turnParts, chars: nextChars });
      usedChars += nextChars;
    }
  }

  return records.flatMap((record) => record.parts);
}

/** 逐行 JSON 保留题目归属；按编码和标签转义后的预算选取完整记录。 */
export async function loadBankContext(direction?: string, maxChars = 60_000): Promise<string> {
  if (maxChars <= 0) return "";
  const db = getDb();
  const trimmed = direction?.trim() ?? "";
  const chunks: string[] = [];
  const wrapperChars = measureWrappedUntrustedData("question_bank", "");
  let cursor = 0;
  let usedChars = 0;
  while (usedChars < maxChars) {
    const rows = trimmed
      ? db
          .prepare(
            "SELECT id, kind, question FROM bank_entries WHERE direction = ? AND id > ? ORDER BY id LIMIT ?",
          )
          .all(trimmed, cursor, 50) as BankEntry[]
      : db
          .prepare("SELECT id, kind, question FROM bank_entries WHERE id > ? ORDER BY id LIMIT ?")
          .all(cursor, 50) as BankEntry[];
    if (rows.length === 0) break;
    for (const entry of rows) {
      if (!(entry.id > cursor)) throw new Error("Cursor must advance strictly");
      cursor = entry.id;
      const record = serializeBankQuestion(entry);
      const text = `${chunks.length === 0 ? "" : "\n"}${record}`;
      const chars = measureWrappedUntrustedData("question_bank", text) - wrapperChars;
      if (usedChars + chars > maxChars) return chunks.join("");
      chunks.push(text);
      usedChars += chars;
    }
  }
  return chunks.join("");
}
