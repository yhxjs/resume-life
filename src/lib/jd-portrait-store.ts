import { getDb, inTransaction, now } from "./db";
import { linkPreparationResource, resolvePreparationApplication } from "./application-preparation";
import { parseJdPortraitResult, type JdPortraitResult } from "./jd-portrait";

export function loadJdPortrait(id: number, preserveInvalid = false) {
  const row = getDb().prepare("SELECT id,jd,result,created_at FROM jd_portraits WHERE id=?").get(id) as
    { id: number; jd: string; result: string; created_at: string } | undefined;
  if (!row) return null;
  const result = parseJdPortraitResult(row.result);
  return { ...row, result, ...(preserveInvalid && result === null
    ? { read_error: "历史画像格式无效，保留原始结果供核对", raw_result: row.result } : {}) };
}

/** Recheck the destination and commit the portrait and its preparation link together for both clients. */
export function saveJdPortrait(jd: string, result: JdPortraitResult, applicationId: number | null): number {
  return inTransaction(() => {
    if (applicationId !== null) resolvePreparationApplication({ application_id: applicationId }, { jd });
    const saved = getDb().prepare("INSERT INTO jd_portraits (jd, result, created_at) VALUES (?, ?, ?)").run(jd, JSON.stringify(result), now());
    const id = Number(saved.lastInsertRowid);
    if (applicationId !== null) linkPreparationResource(applicationId, "portrait", id);
    return id;
  });
}
