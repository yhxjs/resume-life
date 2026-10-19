import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import { getDb, inTransaction, now } from "@/lib/db";
import { logServerError, requestIdFrom } from "@/lib/server-errors";
import { errorMessage } from "@/lib/error-message";

async function handleGet() {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT c.id, c.name, c.created_at, COUNT(e.id) AS entry_count
       FROM notebook_categories c
       LEFT JOIN notebook_entries e ON e.category_id = c.id
       GROUP BY c.id
       ORDER BY c.id`
    )
    .all() as { id: number; name: string; created_at: string; entry_count: number }[];
  return NextResponse.json(rows);
}

async function handlePost(req: Request) {
  const parsedBody = await parseApiJson<unknown>(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as { name?: unknown } | null;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "请输入分类名称" }, { status: 400 });
  if (name.length > 30) return NextResponse.json({ error: "分类名称不能超过 30 个字" }, { status: 400 });

  const db = getDb();
  try {
    const result = inTransaction(() => db
      .prepare("INSERT INTO notebook_categories (name, created_at) VALUES (?, ?)")
      .run(name, now()));
    return NextResponse.json({ id: Number(result.lastInsertRowid), name }, { status: 201 });
  } catch (err) {
    const message = errorMessage(err);
    if (message.includes("UNIQUE")) {
      return NextResponse.json({ error: "已存在同名分类" }, { status: 409 });
    }
    const requestId = logServerError("notebook.categories.create", err, { requestId: requestIdFrom(req), status: 500 });
    return NextResponse.json({ error: "创建分类失败，请稍后重试", requestId }, { status: 500 });
  }
}

export const GET = withRouteErrorHandling("GET /api/notebook/categories", handleGet);
export const POST = withRouteErrorHandling("POST /api/notebook/categories", handlePost);
