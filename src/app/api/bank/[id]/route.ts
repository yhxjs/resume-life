import { clearEntityLlmLabels } from "@/lib/llm-label-cleanup";
import { withRouteErrorHandling } from "@/lib/api-route";
import { NextResponse } from "next/server";
import { getDb, inTransaction } from "@/lib/db";

async function handleDelete(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const entryId = Number(id);
  if (!Number.isInteger(entryId)) {
    return NextResponse.json({ error: "无效的题目 ID" }, { status: 400 });
  }
  const db = getDb();
  const result = inTransaction(() => {
    clearEntityLlmLabels(db, "bank_entry", entryId);
    return db.prepare("DELETE FROM bank_entries WHERE id = ?").run(entryId);
  });
  if (result.changes === 0) return NextResponse.json({ error: "题目不存在" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export const DELETE = withRouteErrorHandling("DELETE /api/bank/[id]", handleDelete);
