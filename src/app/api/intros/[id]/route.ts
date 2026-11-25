import { parseCanonicalPositiveId } from "@/lib/id-parsing";
import { clearEntityLlmLabels } from "@/lib/llm-label-cleanup";
import { withRouteErrorHandling } from "@/lib/api-route";
import { NextResponse } from "next/server";
import { getDb, inTransaction } from "@/lib/db";
import { loadIntroRecord } from "@/lib/intro-store";
export type { IntroVersionRow } from "@/lib/intro-store";

async function handleGet(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const introId = parseCanonicalPositiveId(id);
  if (!Number.isSafeInteger(introId) || introId <= 0) {
    return NextResponse.json({ error: "无效的记录 ID" }, { status: 400 });
  }
  const data = loadIntroRecord(introId);
  if (!data) return NextResponse.json({ error: "记录不存在" }, { status: 404 });
  return NextResponse.json(data);
}

async function handleDelete(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const introId = parseCanonicalPositiveId(id);
  if (!Number.isSafeInteger(introId) || introId <= 0) {
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
