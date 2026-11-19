import { SALARY_CREATION_STORAGE_KEY } from "./browser-draft-keys";
import { documentDataGeneration } from "./api-fetch";
import { INITIAL_DATA_GENERATION } from "./data-generation-contract";
import { isSalaryCreationRequestId } from "./salary-creation-contract";
import type { SalaryNegotiationStartInput } from "@/hooks/use-salary-negotiation-creation";

export { SALARY_CREATION_STORAGE_KEY };
type PendingCreation = { requestId: string; snapshot: SalaryNegotiationStartInput };
const generation = () => documentDataGeneration() ?? INITIAL_DATA_GENERATION;
const snapshotKeys = ["target_company_tier", "target_role", "expected_salary", "current_or_competing_offer", "hr_style"] as const;
const invalid = () => new Error("创建恢复信息损坏，请先核对历史记录");
const changed = () => new Error("创建恢复信息已改变，请刷新页面核对当前记录");

function readEnvelope(raw: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw invalid(); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.generation !== "string") throw invalid();
  return record;
}
function readPending(value: Record<string, unknown>): PendingCreation {
  const input = value.snapshot;
  if (!isSalaryCreationRequestId(value.requestId) || !input || typeof input !== "object" || Array.isArray(input)) throw invalid();
  const snapshot = input as Record<string, unknown>;
  if (!snapshotKeys.every(key => typeof snapshot[key] === "string") || Object.keys(snapshot).length !== snapshotKeys.length ||
    !(snapshot.target_role as string).trim() || !(snapshot.expected_salary as string).trim() ||
    !["pressure", "standard", "emotional"].includes(snapshot.hr_style as string)) throw invalid();
  return { requestId: value.requestId, snapshot: snapshot as SalaryNegotiationStartInput };
}

/** 仅在当前标签页暂存提交背景；刷新后只能按编号只读核对，不能自动重发。 */
export function readPendingSalaryCreation(raw: string | null = sessionStorage.getItem(SALARY_CREATION_STORAGE_KEY)): PendingCreation | null {
  if (raw === null) return null;
  const value = readEnvelope(raw);
  if (value.generation !== generation()) {
    sessionStorage.removeItem(SALARY_CREATION_STORAGE_KEY);
    return null;
  }
  return readPending(value);
}
export function savePendingSalaryCreation(value: PendingCreation): void {
  sessionStorage.setItem(SALARY_CREATION_STORAGE_KEY, JSON.stringify({ version: 1, generation: generation(), ...value }));
}
/** 完成、拒绝及人工另建都只能清理刚核对过的原记录，不能静默跳过不匹配。 */
export function clearPendingSalaryCreation(expected: PendingCreation | { raw: string | null }): void {
  const raw = sessionStorage.getItem(SALARY_CREATION_STORAGE_KEY);
  if ("raw" in expected) {
    if (raw !== expected.raw) throw changed();
  } else {
    if (raw === null) throw changed();
    const value = readEnvelope(raw);
    if (value.generation !== generation()) throw changed();
    const pending = readPending(value);
    if (pending.requestId !== expected.requestId || snapshotKeys.some(key => pending.snapshot[key] !== expected.snapshot[key])) throw changed();
  }
  sessionStorage.removeItem(SALARY_CREATION_STORAGE_KEY);
}
