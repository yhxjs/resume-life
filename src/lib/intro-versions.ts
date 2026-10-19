import { createHash } from "node:crypto";
import { dataGeneration, getDb, inTransaction } from "./db";
import type { IntroKind, IntroSentence } from "./intro";

export type IntroVersionSnapshot = { id: number; sentences: string; updated_at: string };

/** 修订绑定真实快照与恢复世代，不依赖时间戳精度，也无需修改已有备份格式。 */
export function introVersionRevision(version: IntroVersionSnapshot, generation: string | null = dataGeneration()): string {
  return createHash("sha256").update(JSON.stringify([
    generation, version.id, version.sentences, version.updated_at,
  ])).digest("hex");
}

/** 手动保存、生成和点评共用同一 CAS 写边界，冲突时不写入任何内容。 */
export function saveIntroVersion(introId: number, kind: IntroKind, baseRevision: string, sentences: IntroSentence[]):
  { status: 200; revision: string } | { status: 404 } | { status: 409 } {
  return inTransaction(() => {
    const db = getDb();
    const version = db.prepare("SELECT id, sentences, updated_at FROM intro_versions WHERE intro_id = ? AND kind = ?")
      .get(introId, kind) as IntroVersionSnapshot | undefined;
    if (!version) return { status: 404 };
    if (introVersionRevision(version) !== baseRevision) return { status: 409 };
    const previousTime = Date.parse(version.updated_at);
    const updatedAt = new Date(Math.max(Date.now(), Number.isFinite(previousTime) ? previousTime + 1 : 0)).toISOString();
    const serialized = JSON.stringify(sentences);
    db.prepare("UPDATE intro_versions SET sentences = ?, updated_at = ? WHERE id = ? AND intro_id = ? AND kind = ?")
      .run(serialized, updatedAt, version.id, introId, kind);
    return { status: 200, revision: introVersionRevision({ ...version, sentences: serialized, updated_at: updatedAt }) };
  });
}
