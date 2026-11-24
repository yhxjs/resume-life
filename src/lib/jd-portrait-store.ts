import { getDb, inTransaction, now } from "./db";
import { linkPreparationResource, resolvePreparationApplication } from "./application-preparation";
import type { JdPortraitResult } from "./jd-portrait";

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
