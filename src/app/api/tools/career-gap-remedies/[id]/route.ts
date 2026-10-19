import { withRouteErrorHandling } from "@/lib/api-route";
import { NextResponse } from "next/server";
import { getDb, inTransaction } from "@/lib/db";
import { parseRemedyResult } from "@/lib/career-gap-remedy";

async function handleGet(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const numId = Number(id);
  if (!Number.isFinite(numId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  const db = getDb();
  const row = db
    .prepare(
      "SELECT id, scenario_type, raw_story, target_role, persona_style, result, created_at FROM resignation_gap_remedies WHERE id = ?"
    )
    .get(numId) as
    | {
        id: number;
        scenario_type: string;
        raw_story: string;
        target_role: string;
        persona_style: string;
        result: string;
        created_at: string;
      }
    | undefined;

  if (!row) {
    return NextResponse.json({ error: "Record not found" }, { status: 404 });
  }

  return NextResponse.json({
    id: row.id,
    scenario_type: row.scenario_type,
    raw_story: row.raw_story,
    target_role: row.target_role,
    persona_style: row.persona_style,
    result: parseRemedyResult(row.result),
    created_at: row.created_at,
  });
}

async function handleDelete(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const numId = Number(id);
  if (!Number.isFinite(numId)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  const db = getDb();
  inTransaction(() => db.prepare("DELETE FROM resignation_gap_remedies WHERE id = ?").run(numId));
  return NextResponse.json({ ok: true });
}

export const GET = withRouteErrorHandling("GET /api/tools/career-gap-remedies/[id]", handleGet);
export const DELETE = withRouteErrorHandling("DELETE /api/tools/career-gap-remedies/[id]", handleDelete);
