import { validateGeneratedNegotiationTurn } from "./salary-negotiation";
import { isNegotiationHistoryRevision, readSalaryNegotiationHistory, type SalaryNegotiationHistory } from "./salary-negotiation-history";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("谈薪操作响应不完整");
  return value as Record<string, unknown>;
}

/** 完成回包只能合并到提交时已读的版本；并发元数据变化也须回读完整存档。 */
function committedRevision(result: Record<string, unknown>, before: SalaryNegotiationHistory): string {
  if (!isNegotiationHistoryRevision(result.base_revision) || result.base_revision !== before.revision ||
    !isNegotiationHistoryRevision(result.revision) || result.revision === before.revision) {
    throw new Error("谈薪操作响应与已读取的存档版本不符，请重新读取");
  }
  return result.revision;
}

/** 新回合必须属于提交时的记录、下一回合和原答；旧历史不套用新生成限制。 */
export function readNegotiationTurnResponse(value: unknown, before: SalaryNegotiationHistory, message: string): SalaryNegotiationHistory {
  const turn = record(value);
  const revision = committedRevision(turn, before);
  const nextTurnNo = (before.turns.at(-1)?.turn_no ?? 0) + 1;
  // API 回合还含身份与存档元数据；模型字段的严格协议只检查生成内容。
  const generated = validateGeneratedNegotiationTurn({
    hr_response: turn.hr_response, hr_tactics: turn.hr_tactics,
    hr_mindset: turn.hr_mindset, mentor_analysis: turn.mentor_analysis,
  });
  if (turn.negotiation_id !== before.id || turn.turn_no !== nextTurnNo || turn.user_message !== message ||
    typeof turn.created_at !== "string" || !turn.created_at.trim() || !generated) {
    throw new Error("谈薪回合响应与本次提交不符或评估不完整");
  }
  return readSalaryNegotiationHistory({ ...before, revision, turns: [...before.turns, turn] }, before.id);
}

/** 结束接口也可能返回旧存档，保留历史评分和文本，仅核对身份、状态及引用。 */
export function readNegotiationFinalizeResponse(value: unknown, before: SalaryNegotiationHistory): SalaryNegotiationHistory {
  const result = record(value);
  const revision = committedRevision(result, before);
  if (result.id !== before.id || result.status !== "finished" || typeof result.final_package !== "string" ||
    typeof result.finished_at !== "string" || !result.report) throw new Error("谈薪复盘响应与当前记录不符或不完整");
  return readSalaryNegotiationHistory({ ...before, revision, status: result.status, final_package: result.final_package,
    finished_at: result.finished_at, report: result.report }, before.id);
}

/** 只认提交快照之后新增的匹配原话，不以旧回合的同文内容认领本次请求。 */
export function hasNewSavedNegotiationTurn(before: SalaryNegotiationHistory, saved: SalaryNegotiationHistory, message: string): boolean {
  const { turns: beforeTurns, ...beforeContext } = readSalaryNegotiationHistory(before, before.id);
  const { turns: savedTurns, ...savedContext } = readSalaryNegotiationHistory(saved, before.id);
  // 新增回合必然推进版本；恢复识别只比较实际背景与既有回合，不把令牌当背景。
  if (JSON.stringify({ ...beforeContext, revision: null }) !== JSON.stringify({ ...savedContext, revision: null }) || savedTurns.length <= beforeTurns.length ||
    JSON.stringify(savedTurns.slice(0, beforeTurns.length)) !== JSON.stringify(beforeTurns)) return false;
  return savedTurns[beforeTurns.length]?.turn_no === (beforeTurns.at(-1)?.turn_no ?? 0) + 1 &&
    savedTurns[beforeTurns.length]?.user_message === message;
}
