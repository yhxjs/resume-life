import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import { getDb, inTransaction, now } from "@/lib/db";

export const GET = withRouteErrorHandling("GET /api/notebook/[id]", async (_req, { params }) => {
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) return NextResponse.json({ error: "无效的错题 ID" }, { status: 400 });
  const db = getDb();
  const row = db.prepare("SELECT id, question, answer, comment, reference FROM notebook_entries WHERE id = ?").get(id);
  return row ? NextResponse.json(row) : NextResponse.json({ error: "错题不存在或已删除" }, { status: 404 });
});

/** PATCH：调整错题分类（category_id 传 null 表示移到「未分类」） */
async function handlePatch(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const entryId = Number(id);
  if (!Number.isInteger(entryId)) {
    return NextResponse.json({ error: "无效的错题 ID" }, { status: 400 });
  }
  const parsedBody = await parseApiJson<unknown>(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data;
  if (
    body === null
    || typeof body !== "object"
    || Array.isArray(body)
    || !Object.prototype.hasOwnProperty.call(body, "category_id")
  ) {
    return NextResponse.json({ error: "无效的分类" }, { status: 400 });
  }

  let categoryId: number | null = null;
  const rawCategoryId = (body as { category_id: unknown }).category_id;
  if (rawCategoryId !== null) {
    if (typeof rawCategoryId !== "number" || !Number.isSafeInteger(rawCategoryId) || rawCategoryId <= 0) {
      return NextResponse.json({ error: "无效的分类" }, { status: 400 });
    }
    categoryId = rawCategoryId;
  }

  const db = getDb();
  if (categoryId !== null) {
    const cat = db.prepare("SELECT id FROM notebook_categories WHERE id = ?").get(categoryId);
    if (!cat) return NextResponse.json({ error: "分类不存在" }, { status: 400 });
  }
  const result = inTransaction(() => db
    .prepare("UPDATE notebook_entries SET category_id = ?, updated_at = ? WHERE id = ?")
    .run(categoryId, now(), entryId));
  if (result.changes === 0) return NextResponse.json({ error: "错题不存在" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

async function handleDelete(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const entryId = Number(id);
  if (!Number.isInteger(entryId)) {
    return NextResponse.json({ error: "无效的错题 ID" }, { status: 400 });
  }
  const db = getDb();
  const result = inTransaction(() => db.prepare("DELETE FROM notebook_entries WHERE id = ?").run(entryId));
  if (result.changes === 0) return NextResponse.json({ error: "错题不存在" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export const PATCH = withRouteErrorHandling("PATCH /api/notebook/[id]", handlePatch);
export const DELETE = withRouteErrorHandling("DELETE /api/notebook/[id]", handleDelete);
