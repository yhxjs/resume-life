import { createHash } from "node:crypto";
import { getDb, inTransaction, now } from "./db";

export { isSalaryCreationRequestId } from "./salary-creation-contract";

type Receipt = { input_hash: string; status: "pending" | "succeeded" | "failed"; negotiation_id: number | null };
export type SalaryCreationRequestState = { status: "pending" | "failed" | "deleted" } | { status: "succeeded"; id: number };

function receipt(id: string): Receipt | undefined {
  return getDb().prepare("SELECT input_hash,status,negotiation_id FROM salary_creation_requests WHERE request_id=?").get(id) as Receipt | undefined;
}
function state(row: Receipt): SalaryCreationRequestState {
  return row.status === "succeeded"
    ? row.negotiation_id === null ? { status: "deleted" } : { status: "succeeded", id: row.negotiation_id }
    : { status: row.status };
}
export function readSalaryCreationRequest(id: string): SalaryCreationRequestState | null {
  const row = receipt(id);
  return row ? state(row) : null;
}

/** BEGIN IMMEDIATE + 唯一键在模型调用前跨进程认领；同文的新编号仍是新练习。 */
export function claimSalaryCreationRequest(id: string, snapshot: readonly string[]): { status: "claimed" | "conflict" } | SalaryCreationRequestState {
  const hash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  return inTransaction(() => {
    const previous = receipt(id);
    if (previous) return previous.input_hash === hash ? state(previous) : { status: "conflict" };
    getDb().prepare("INSERT INTO salary_creation_requests (request_id,input_hash,status,created_at) VALUES (?,?,'pending',?)").run(id, hash, now());
    return { status: "claimed" };
  });
}

/** 与演练及开场插入共用外层事务，不能出现已保存却没有完成回执的窗口。 */
export function completeSalaryCreationRequest(id: string, negotiationId: number): void {
  const result = getDb().prepare("UPDATE salary_creation_requests SET status='succeeded',negotiation_id=? WHERE request_id=? AND status='pending'").run(negotiationId, id);
  if (result.changes !== 1) throw new Error("创建请求状态已改变，不能保存本次结果");
}
export function failSalaryCreationRequest(id: string): void {
  inTransaction(() => { getDb().prepare("UPDATE salary_creation_requests SET status='failed' WHERE request_id=? AND status='pending'").run(id); });
}
