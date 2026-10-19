import { withRouteErrorHandling } from "@/lib/api-route";
import { NextResponse } from "next/server";
import { getDb, inTransaction } from "@/lib/db";
import { parseJargonDecoderResult } from "@/lib/jargon-decoder";

function loadDecoding(id: number) {
  const db = getDb();
  const row = db
    .prepare("SELECT id, source_text, result, created_at FROM jargon_decodings WHERE id = ?")
    .get(id) as
    | { id: number; source_text: string; result: string; created_at: string }
    | undefined;
  if (!row) return null;
  return { ...row, result: parseJargonDecoderResult(row.result) };
}

async function handleGet(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const decodingId = Number(id);
  if (!Number.isInteger(decodingId)) {
    return NextResponse.json({ error: "无效的记录 ID" }, { status: 400 });
  }
  const data = loadDecoding(decodingId);
  if (!data) return NextResponse.json({ error: "记录不存在" }, { status: 404 });
  return NextResponse.json(data);
}

async function handleDelete(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const decodingId = Number(id);
  if (!Number.isInteger(decodingId)) {
    return NextResponse.json({ error: "无效的记录 ID" }, { status: 400 });
  }
  const db = getDb();
  const result = inTransaction(() => db.prepare("DELETE FROM jargon_decodings WHERE id = ?").run(decodingId));
  if (result.changes === 0) return NextResponse.json({ error: "记录不存在" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export const GET = withRouteErrorHandling("GET /api/tools/jargon-decodings/[id]", handleGet);
export const DELETE = withRouteErrorHandling("DELETE /api/tools/jargon-decodings/[id]", handleDelete);
