import { withRouteErrorHandling } from "@/lib/api-route";
import { NextResponse } from "next/server";
import { getDb, inTransaction } from "@/lib/db";
import { parseJdPortraitResult } from "@/lib/jd-portrait";

/** 加载画像记录；result JSON 损坏时 result 为 null（详情页提示数据异常） */
function loadJdPortrait(id: number) {
  const db = getDb();
  const row = db
    .prepare("SELECT id, jd, result, created_at FROM jd_portraits WHERE id = ?")
    .get(id) as
    | { id: number; jd: string; result: string; created_at: string }
    | undefined;
  if (!row) return null;
  return { ...row, result: parseJdPortraitResult(row.result) };
}

async function handleGet(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const portraitId = Number(id);
  if (!Number.isInteger(portraitId)) {
    return NextResponse.json({ error: "无效的记录 ID" }, { status: 400 });
  }
  const data = loadJdPortrait(portraitId);
  if (!data) return NextResponse.json({ error: "记录不存在" }, { status: 404 });
  return NextResponse.json(data);
}

async function handleDelete(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const portraitId = Number(id);
  if (!Number.isInteger(portraitId)) {
    return NextResponse.json({ error: "无效的记录 ID" }, { status: 400 });
  }
  const db = getDb();
  const result = inTransaction(() => db.prepare("DELETE FROM jd_portraits WHERE id = ?").run(portraitId));
  if (result.changes === 0) return NextResponse.json({ error: "记录不存在" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export const GET = withRouteErrorHandling("GET /api/tools/jd-portraits/[id]", handleGet);
export const DELETE = withRouteErrorHandling("DELETE /api/tools/jd-portraits/[id]", handleDelete);
