import { dataGeneration, getDb } from "./db";
import { isIntroKind, readStoredIntroSentences, type IntroKind, type IntroSentence } from "./intro";
import { introVersionRevision, type IntroVersionSnapshot } from "./intro-versions";

export type IntroVersionRow = { kind: IntroKind; sentences: IntroSentence[]; revision: string; read_error?: string; raw_sentences?: string };

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
