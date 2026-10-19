import { clearEntityLlmLabels } from "@/lib/llm-label-cleanup";
import { withRouteErrorHandling } from "@/lib/api-route";
import { NextResponse } from "next/server";
import { dataGeneration, getDb, inTransaction } from "@/lib/db";
import { isIntroKind, type IntroKind, type IntroSentence } from "@/lib/intro";
import { introVersionRevision, type IntroVersionSnapshot } from "@/lib/intro-versions";

export type IntroVersionRow = { kind: IntroKind; sentences: IntroSentence[]; revision: string };

/**
 * 加载工坊记录与其两版内容；句子 JSON 损坏的版本以空句子列表呈现。
 *
 * 刻意不导出：route.ts 里除 HTTP 方法之外的导出会被 `next build` 当成路由段配置校验，
 * 报「OmitWithTag<...> 不满足 { [x: string]: never }」。这里只有本文件的 handler 用它。
 */
function loadIntro(id: number) {
  const db = getDb();
  const intro = db
    .prepare(
      `SELECT i.id, i.resume_id, i.resume_version_id, i.jd, i.created_at, COALESCE(json_extract(rv.snapshot, '$.title'), r.title) AS resume_title, rv.version AS resume_version, rv.name AS resume_version_name
       FROM intros i JOIN resumes r ON r.id = i.resume_id LEFT JOIN resume_versions rv ON rv.id = i.resume_version_id WHERE i.id = ?`
    )
    .get(id) as
    | { id: number; resume_id: number; resume_version_id: number | null; jd: string; created_at: string; resume_title: string }
    | undefined;
  if (!intro) return null;
  const rows = db
    .prepare("SELECT id, kind, sentences, updated_at FROM intro_versions WHERE intro_id = ?")
    .all(id) as (IntroVersionSnapshot & { kind: string })[];
  const generation = dataGeneration(db);
  const versions: IntroVersionRow[] = [];
  for (const row of rows) {
    if (!isIntroKind(row.kind)) continue;
    let sentences: IntroSentence[] = [];
    try {
      const parsed = JSON.parse(row.sentences) as unknown;
      if (Array.isArray(parsed)) {
        sentences = parsed.filter(
          (s): s is IntroSentence =>
            !!s && typeof s === "object" && typeof (s as Record<string, unknown>).text === "string"
        );
      }
    } catch {
      // 保留空列表，详情页提示数据异常
    }
    versions.push({ kind: row.kind, sentences, revision: introVersionRevision(row, generation) });
  }
  return { ...intro, versions };
}

async function handleGet(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const introId = Number(id);
  if (!Number.isInteger(introId)) {
    return NextResponse.json({ error: "无效的记录 ID" }, { status: 400 });
  }
  const data = loadIntro(introId);
  if (!data) return NextResponse.json({ error: "记录不存在" }, { status: 404 });
  return NextResponse.json(data);
}

async function handleDelete(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const introId = Number(id);
  if (!Number.isInteger(introId)) {
    return NextResponse.json({ error: "无效的记录 ID" }, { status: 400 });
  }
  const db = getDb();
  const result = inTransaction(() => {
    clearEntityLlmLabels(db, "intro", introId);
    return db.prepare("DELETE FROM intros WHERE id = ?").run(introId);
  });
  if (result.changes === 0) return NextResponse.json({ error: "记录不存在" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export const GET = withRouteErrorHandling("GET /api/intros/[id]", handleGet);
export const DELETE = withRouteErrorHandling("DELETE /api/intros/[id]", handleDelete);
