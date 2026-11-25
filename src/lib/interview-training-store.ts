import { getDb, inTransaction } from "./db";
import { assertBackupFieldBytes, assertBackupRecordBytes } from "./backup-limits";
import { InterviewCommandError } from "./interview-commands/errors";
import { readInterviewRetryHistory, type TurnRetry } from "./interview-retry-history";
import { syncNotebookSnapshot } from "./notebook";
import type { ReverseInterviewData } from "./interview";

/** Callers compare their generation source in this same transaction before appending. */
export function appendInterviewRetry(interviewId: number, turnId: number, retry: TurnRetry) {
  return inTransaction(() => {
    const db = getDb(), latest = db.prepare("SELECT * FROM interview_turns WHERE id=? AND interview_id=?").get(turnId, interviewId) as
      (Record<string, unknown> & { retries: string; reference: string }) | undefined;
    if (!latest) return null;
    const history = readInterviewRetryHistory(latest.retries);
    if (!history) throw new InterviewCommandError("重答历史数据损坏，已保留原记录", 422);
    const existing = history.retries.find(item => item.id === retry.id);
    if (existing) {
      if (existing.answer !== retry.answer) throw new InterviewCommandError("该提交编号已用于其他回答", 409);
      return { retry: existing, updatedRetries: history.retries, updatedReference: latest.reference };
    }
    const encoded = JSON.stringify([...history.stored, retry]), row = { ...latest, retries: encoded };
    for (const value of Object.values(row)) if (typeof value === "string") assertBackupFieldBytes(Buffer.byteLength(value, "utf8"));
    assertBackupRecordBytes(Buffer.byteLength(`${JSON.stringify({ kind: "row", table: "interview_turns", data: row })}\n`, "utf8"));
    db.prepare("UPDATE interview_turns SET retries=? WHERE id=? AND interview_id=?").run(encoded, turnId, interviewId);
    return { retry, updatedRetries: [...history.retries, retry], updatedReference: latest.reference };
  });
}

export function storeInterviewReference(interviewId: number, turnId: number, reference: string) {
  return inTransaction(() => {
    const db = getDb(), turn = db.prepare("SELECT answer,comment,scores FROM interview_turns WHERE id=? AND interview_id=?").get(turnId, interviewId) as
      { answer: string; comment: string; scores: string } | undefined;
    if (!turn) return { changes: 0 };
    const updated = db.prepare("UPDATE interview_turns SET reference=? WHERE id=? AND interview_id=?").run(reference, turnId, interviewId);
    if (updated.changes === 1) syncNotebookSnapshot(db, "interview", turnId, { ...turn, reference });
    return updated;
  });
}

export function storeInterviewReverse(interviewId: number, status: string, data: ReverseInterviewData) {
  return getDb().prepare("UPDATE interviews SET reverse_interview=? WHERE id=? AND report='' AND reverse_interview='' AND status=?")
    .run(JSON.stringify(data), interviewId, status).changes === 1;
}
