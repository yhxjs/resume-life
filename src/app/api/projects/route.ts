import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import { getDb, inTransaction, now } from "@/lib/db";

async function handleGet() {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.summary_updated_at, p.updated_at,
              COUNT(m.id) AS material_count
       FROM projects p
       LEFT JOIN project_materials m ON m.project_id = p.id
       GROUP BY p.id
       ORDER BY p.updated_at DESC`
    )
    .all() as {
    id: number;
    name: string;
    summary_updated_at: string;
    updated_at: string;
    material_count: number;
  }[];
  return NextResponse.json(rows);
}

async function handlePost(req: Request) {
  const parsedBody = await parseApiJson<unknown>(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as unknown;
  const rawName = body && typeof body === "object" ? (body as Record<string, unknown>).name : undefined;
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "项目名称不能为空" }, { status: 400 });
  }
  const db = getDb();
  const ts = now();
  const result = inTransaction(() => db
    .prepare("INSERT INTO projects (name, created_at, updated_at) VALUES (?, ?, ?)")
    .run(name, ts, ts));
  return NextResponse.json({ id: Number(result.lastInsertRowid), name }, { status: 201 });
}

export const GET = withRouteErrorHandling("GET /api/projects", handleGet);
export const POST = withRouteErrorHandling("POST /api/projects", handlePost);
