import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import { escapeLike, getDb, inTransaction, now } from "@/lib/db";
import { bankKindOf, MAX_BANK_IMPORT } from "@/lib/bank";
import { createCursorPage, parsePaginationParams } from "@/lib/cursor-pagination";

async function handleGet(req: Request) {
  const url = new URL(req.url);
  const page = parsePaginationParams(url.searchParams);
  if (!page.ok) return page.response;
  const { limit, idCursor: cursor } = page;
  const direction = (url.searchParams.get("direction") ?? "").trim();
  const kind = (url.searchParams.get("kind") ?? "").trim();
  const q = (url.searchParams.get("q") ?? "").trim();

  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (direction) {
    conditions.push("direction = ?");
    params.push(direction);
  }
  if (kind === "tech" || kind === "behavior") {
    conditions.push("kind = ?");
    params.push(kind);
  }
  if (q) {
    conditions.push("question LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(q)}%`);
  }
  if (cursor !== null) {
    conditions.push("id < ?");
    params.push(cursor);
  }
  params.push(limit + 1);

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, direction, kind, question, created_at FROM bank_entries
       ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
       ORDER BY id DESC
       LIMIT ?`
    )
    .all(...params) as {
    id: number;
    direction: string;
    kind: string;
    question: string;
    created_at: string;
  }[];
  return NextResponse.json(createCursorPage(rows, limit, (row) => String(row.id)));
}

/** 手动导入：粘贴文本按行拆题（每行一题），与方向、题型一起入库 */
async function handlePost(req: Request) {
  const parsedBody = await parseApiJson<unknown>(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as {
    direction?: unknown;
    kind?: unknown;
    text?: unknown;
  } | null;
  const direction = typeof body?.direction === "string" ? body.direction.trim() : "";
  const kind = bankKindOf(body?.kind);
  const text = typeof body?.text === "string" ? body.text : "";

  const questions = [
    ...new Set(
      text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    ),
  ];
  if (questions.length > MAX_BANK_IMPORT) {
    return NextResponse.json({ error: `每次最多导入 ${MAX_BANK_IMPORT} 道题，请分批导入` }, { status: 400 });
  }
  if (questions.length === 0) {
    return NextResponse.json({ error: "请粘贴题目，每行一题" }, { status: 400 });
  }

  const db = getDb();
  const ts = now();
  const inserted = inTransaction(() => {
    const statement = db.prepare(
      "INSERT INTO bank_entries (direction, kind, question, created_at) VALUES (?, ?, ?, ?)"
    );
    for (const q of questions) statement.run(direction, kind, q, ts);
    return questions.length;
  });
  return NextResponse.json({ count: inserted }, { status: 201 });
}

export const POST = withRouteErrorHandling("POST /api/bank", handlePost);
export const GET = withRouteErrorHandling("GET /api/bank", handleGet);
