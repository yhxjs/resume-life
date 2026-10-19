import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import { getDb, inTransaction, now } from "@/lib/db";
import { normalizeStyle, type CustomTemplate } from "@/lib/templates";
import { readCustomTemplate } from "@/lib/custom-templates";

type Row = { id: number; name: string; style: string; created_at: string; updated_at: string };

async function handleGet() {
  const db = getDb();
  const rows = db
    .prepare("SELECT id, name, style, created_at, updated_at FROM resume_templates ORDER BY id")
    .all() as Row[];
  return NextResponse.json({ items: rows.map(readCustomTemplate) });
}

async function handlePost(req: Request) {
  const parsedBody = await parseApiJson<unknown>(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as Record<string, unknown> | null;
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "模板名称不能为空" }, { status: 400 });
  if (name.length > 30) return NextResponse.json({ error: "模板名称不能超过 30 字" }, { status: 400 });
  const style = normalizeStyle(body?.style);
  if (!style) return NextResponse.json({ error: "样式参数无效" }, { status: 400 });

  const db = getDb();
  const ts = now();
  const result = inTransaction(() => db
    .prepare("INSERT INTO resume_templates (name, style, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(name, JSON.stringify(style), ts, ts));
  const id = Number(result.lastInsertRowid);
  return NextResponse.json(
    { id, name, style, created_at: ts, updated_at: ts } satisfies CustomTemplate,
    { status: 201 }
  );
}

export const GET = withRouteErrorHandling("GET /api/templates", handleGet);
export const POST = withRouteErrorHandling("POST /api/templates", handlePost);
