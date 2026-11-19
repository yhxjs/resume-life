import type { PromptPart } from "@/lib/safe-llm";

/** 首次总评与评估重试只传原始题答；旧评分留在服务端汇总，旧点评不作证据。 */
export function answeredInterviewReportParts(turns: readonly {
  idx: number;
  kind: string;
  question: string;
  answer: string;
}[]): PromptPart[] {
  return turns.flatMap((turn, index): PromptPart[] => [
    ...(index > 0 ? [{ trust: "trusted", text: "\n\n" } as const] : []),
    { trust: "trusted", text: "【原始问答记录】\n元数据：" },
    { trust: "untrusted", tag: "turn_metadata", text: JSON.stringify({ idx: turn.idx, kind: turn.kind }) },
    { trust: "trusted", text: "\n题目：" },
    { trust: "untrusted", tag: "interview_question", text: turn.question },
    { trust: "trusted", text: "\n回答：" },
    { trust: "untrusted", tag: "candidate_answer", text: turn.answer },
  ]);
}

/** 总评只使用候选人的反问原文，不把旧评分或模拟回答当成能力证据。 */
export function reverseInterviewReportParts(raw: string): PromptPart[] {
  if (!raw) return [];
  let record: unknown;
  try { record = JSON.parse(raw); }
  catch { return []; }
  if (!record || typeof record !== "object" || Array.isArray(record) ||
      !("question" in record) || typeof record.question !== "string" || !record.question.trim()) return [];
  return [
    { trust: "trusted", text: "\n\n【候选人反问原问题】\n仅供理解本次提问关注点；未提供旧评级或模拟回答，不作为技术作答、既有经历或公司制度的证据。\n" },
    { trust: "untrusted", tag: "reverse_interview", text: record.question },
  ];
}
