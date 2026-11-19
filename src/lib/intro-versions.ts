import { createHash } from "node:crypto";
import { dataGeneration, getDb, inTransaction } from "./db";
import { readStoredIntroSentences, type IntroKind, type IntroSentence } from "./intro";
import { IntroResumeContextError, loadIntroResumeContext } from "./intro-resume-context";
import { ResumeNotFoundError } from "./resume-errors";

export type IntroVersionSnapshot = { id: number; sentences: string; updated_at: string };

/** 点评只使用 JD；重生成另绑定实际使用的简历版本和职业材料。 */
export type IntroModelContextSnapshot = {
  jd: string;
  resume?: { id: number; versionId: number | null; context: string };
};

/** 修订绑定真实快照与恢复世代，不依赖时间戳精度，也无需修改已有备份格式。 */
export function introVersionRevision(version: IntroVersionSnapshot, generation: string | null = dataGeneration()): string {
  return createHash("sha256").update(JSON.stringify([
    generation, version.id, version.sentences, version.updated_at,
  ])).digest("hex");
}

/** 手动保存、生成和点评共用同一 CAS 写边界，冲突时不写入任何内容。 */
export function saveIntroVersion(introId: number, kind: IntroKind, baseRevision: string, sentences: IntroSentence[], modelContext?: IntroModelContextSnapshot):
  { status: 200; revision: string } | { status: 404 } | { status: 409 } | { status: 422 } {
  return inTransaction(() => {
    const db = getDb();
    const version = db.prepare("SELECT id, sentences, updated_at FROM intro_versions WHERE intro_id = ? AND kind = ?")
      .get(introId, kind) as IntroVersionSnapshot | undefined;
    if (!version) return { status: 404 };
    if (introVersionRevision(version) !== baseRevision) return { status: 409 };
    // 普通保存不能把筛选后的部分句子当成完整原稿；只有显式模型操作可替换异常版本。
    if (!modelContext && readStoredIntroSentences(version.sentences).error) return { status: 422 };
    // 复核与写入共用事务，模型等待期间不持锁；手动保存继续只核对版本修订。
    if (modelContext) {
      const intro = db.prepare("SELECT resume_id, resume_version_id, jd FROM intros WHERE id = ?")
        .get(introId) as { resume_id: number; resume_version_id: number | null; jd: string } | undefined;
      if (!intro) return { status: 404 };
      if (intro.jd !== modelContext.jd) return { status: 409 };
      if (modelContext.resume) {
        const expected = modelContext.resume;
        if (intro.resume_id !== expected.id || (intro.resume_version_id ?? null) !== expected.versionId) return { status: 409 };
        try {
          if (loadIntroResumeContext(intro.resume_id, intro.resume_version_id) !== expected.context) return { status: 409 };
        } catch (error) {
          if (error instanceof ResumeNotFoundError || error instanceof IntroResumeContextError) return { status: 409 };
          throw error;
        }
      }
    }
    const previousTime = Date.parse(version.updated_at);
    const updatedAt = new Date(Math.max(Date.now(), Number.isFinite(previousTime) ? previousTime + 1 : 0)).toISOString();
    const serialized = JSON.stringify(sentences);
    db.prepare("UPDATE intro_versions SET sentences = ?, updated_at = ? WHERE id = ? AND intro_id = ? AND kind = ?")
      .run(serialized, updatedAt, version.id, introId, kind);
    return { status: 200, revision: introVersionRevision({ ...version, sentences: serialized, updated_at: updatedAt }) };
  });
}
