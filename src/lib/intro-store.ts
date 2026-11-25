import { dataGeneration, getDb, inTransaction, now } from "./db";
import { isIntroKind, readStoredIntroSentences, validateGeneratedIntroVersions, type IntroKind, type IntroSentence, type IntroVersionData } from "./intro";
import { introVersionRevision, type IntroVersionSnapshot } from "./intro-versions";
import { resolveResumeVersionId, ResumeVersionError } from "./resume-versions";
import { loadIntroResumeContext } from "./intro-resume-context";
import { ApplicationInputError } from "./applications";

export type IntroVersionRow = { kind: IntroKind; sentences: IntroSentence[]; revision: string; read_error?: string; raw_sentences?: string };

/** Web and external generation create both versions atomically from the same published source. */
export function createIntroRecord(input: { resumeId: number; versionId: number; jd: string; resumeContext: string; versions: IntroVersionData[] }) {
  const versions = validateGeneratedIntroVersions({ versions: input.versions });
  if (!versions || !input.jd.trim()) throw new ApplicationInputError("自我介绍须包含有效岗位要求及完整双版本");
  return inTransaction(() => {
    resolveResumeVersionId(input.resumeId, input.versionId);
    if (loadIntroResumeContext(input.resumeId, input.versionId) !== input.resumeContext) {
      throw new ResumeVersionError("参考简历或所选发布版本已变化，请重新读取", 409);
    }
    const db = getDb(), timestamp = now();
    const id = Number(db.prepare("INSERT INTO intros (resume_id, resume_version_id, jd, created_at) VALUES (?, ?, ?, ?)")
      .run(input.resumeId, input.versionId, input.jd, timestamp).lastInsertRowid);
    const insert = db.prepare("INSERT INTO intro_versions (intro_id, kind, sentences, updated_at) VALUES (?, ?, ?, ?)");
    for (const version of versions) insert.run(id, version.kind, JSON.stringify(version.sentences), timestamp);
    return id;
  });
}

/** Web 与 MCP 读取同一原稿；异常版本保留原文，不用生成时的长度限制裁剪历史。 */
export function loadIntroRecord(id: number) {
  const db = getDb();
  const intro = db.prepare(`SELECT i.id, i.resume_id, i.resume_version_id, i.jd, i.created_at,
    COALESCE(json_extract(rv.snapshot, '$.title'), r.title) AS resume_title,
    rv.version AS resume_version, rv.name AS resume_version_name
    FROM intros i JOIN resumes r ON r.id=i.resume_id LEFT JOIN resume_versions rv ON rv.id=i.resume_version_id WHERE i.id=?`)
    .get(id) as { id: number; resume_id: number; resume_version_id: number | null; jd: string; created_at: string; resume_title: string;
      resume_version: number | null; resume_version_name: string | null } | undefined;
  if (!intro) return null;
  const rows = db.prepare("SELECT id, kind, sentences, updated_at FROM intro_versions WHERE intro_id=? ORDER BY id")
    .all(id) as (IntroVersionSnapshot & { kind: string })[];
  const generation = dataGeneration(db);
  const versions: IntroVersionRow[] = [];
  for (const row of rows) {
    if (!isIntroKind(row.kind)) continue;
    const stored = readStoredIntroSentences(row.sentences);
    versions.push({ kind: row.kind, sentences: stored.sentences, revision: introVersionRevision(row, generation),
      ...(stored.error ? { read_error: stored.error, raw_sentences: row.sentences } : {}) });
  }
  return { ...intro, versions };
}
