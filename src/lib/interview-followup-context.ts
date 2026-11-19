import { getDb } from "@/lib/db";
import type { PromptPart } from "@/lib/safe-llm";

export type InterviewFollowupContextTurn = { idx: number; kind: string; question: string; answer: string };

/** 追问题的指代可能来自更早的回答；只读取本场当前题之前的已答原始记录。 */
export function interviewFollowupContextParts(interviewId: number, turn: { idx: number; kind: string }): PromptPart[] {
  if (turn.kind !== "followup") return [];
  const history = getDb().prepare(`SELECT idx, kind, question, answer FROM interview_turns
    WHERE interview_id = ? AND idx < ? AND answered_at != '' ORDER BY idx, id`)
    .all(interviewId, turn.idx) as InterviewFollowupContextTurn[];
  return buildInterviewFollowupContextParts(history);
}

/** 输入为已筛选、已排序的本场此前已答题；生产与合成评测共用原始题答编码。 */
export function buildInterviewFollowupContextParts(history: readonly InterviewFollowupContextTurn[]): PromptPart[] {
  if (!history.length) return [{
    trust: "trusted",
    text: "\n\n【追问上下文范围】未找到本场此前的已答记录；指代不清时说明信息不足，不猜测缺失的方案或经历。\n",
  }];
  return [
    { trust: "trusted", text: "\n\n【追问上下文：仅本场此前已答的原始题答，用于理解指代，不是本题作答】\n" },
    ...history.flatMap((item): PromptPart[] => [
      { trust: "untrusted", tag: "followup_context_question", text: JSON.stringify({ idx: item.idx, kind: item.kind, question: item.question }) },
      { trust: "trusted", text: "\n" },
      { trust: "untrusted", tag: "followup_context_answer", text: item.answer },
      { trust: "trusted", text: "\n" },
    ]),
  ];
}
