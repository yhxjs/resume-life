import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import { getDb, inTransaction } from "@/lib/db";
import { logServerError, requestIdFrom } from "@/lib/server-errors";

function isUniqueError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("UNIQUE");
}

async function handlePatch(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const categoryId = Number(id);
  if (!Number.isInteger(categoryId)) {
    return NextResponse.json({ error: "无效的分类 ID" }, { status: 400 });
  }
  const parsedBody = await parseApiJson<unknown>(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as { name?: unknown } | null;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "请输入分类名称" }, { status: 400 });
  if (name.length > 30) return NextResponse.json({ error: "分类名称不能超过 30 个字" }, { status: 400 });

  const db = getDb();
  try {
    const result = inTransaction(() => db
      .prepare("UPDATE notebook_categories SET name = ? WHERE id = ?")
      .run(name, categoryId));
    if (result.changes === 0) return NextResponse.json({ error: "分类不存在" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (isUniqueError(err)) {
      return NextResponse.json({ error: "已存在同名分类" }, { status: 409 });
    }
    const requestId = logServerError("notebook.categories.update", err, {
      requestId: requestIdFrom(req), status: 500, context: { resourceId: categoryId },
    });
    return NextResponse.json({ error: "更新分类失败，请稍后重试", requestId }, { status: 500 });
  }
}

async function handleDelete(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const categoryId = Number(id);
  if (!Number.isInteger(categoryId)) {
    return NextResponse.json({ error: "无效的分类 ID" }, { status: 400 });
  }
  const db = getDb();
  const result = inTransaction(() => db.prepare("DELETE FROM notebook_categories WHERE id = ?").run(categoryId));
  if (result.changes === 0) return NextResponse.json({ error: "分类不存在" }, { status: 404 });
  return NextResponse.json({ ok: true });
}

export const DELETE = withRouteErrorHandling("DELETE /api/notebook/categories/[id]", handleDelete);
export const PATCH = withRouteErrorHandling("PATCH /api/notebook/categories/[id]", handlePatch);
