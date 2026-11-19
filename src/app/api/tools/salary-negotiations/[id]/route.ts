import { parseCanonicalPositiveId } from "@/lib/id-parsing";
import { clearEntityLlmLabels } from "@/lib/llm-label-cleanup";
import { withRouteErrorHandling } from "@/lib/api-route";
import { NextResponse } from "next/server";
import { getDb, inTransaction } from "@/lib/db";
import { NegotiationHistoryError, readSalaryNegotiationHistory } from "@/lib/salary-negotiation-history";
import { readSalaryNegotiationSnapshot } from "@/lib/salary-negotiation-snapshot";

type RouteParams = { params: Promise<{ id: string }> };

async function handleGet(_req: Request, { params }: RouteParams) {
  const { id: rawId } = await params;
  const id = parseCanonicalPositiveId(rawId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return NextResponse.json({ error: "无效的演练 ID" }, { status: 400 });
  }

  const snapshot = readSalaryNegotiationSnapshot(id);
  if (!snapshot) {
    return NextResponse.json({ error: "谈判演练记录不存在" }, { status: 404 });
  }
  const { negotiation: neg, turns: turnRows, revision } = snapshot;

  try {
    const detail = readSalaryNegotiationHistory({
      ...neg, revision, report: neg.report ? JSON.parse(neg.report) : null,
      turns: turnRows.map((turn) => ({ ...turn,
        hr_mindset: JSON.parse(turn.hr_mindset), mentor_analysis: JSON.parse(turn.mentor_analysis),
      })),
    }, id);
    return NextResponse.json({ ...detail, revision });
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof NegotiationHistoryError) {
      return NextResponse.json({ error: new NegotiationHistoryError().message }, { status: 422 });
    }
    throw error;
  }
}

async function handleDelete(_req: Request, { params }: RouteParams) {
  const { id: rawId } = await params;
  const id = parseCanonicalPositiveId(rawId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return NextResponse.json({ error: "无效的演练 ID" }, { status: 400 });
  }

  const db = getDb();
  inTransaction(() => {
    clearEntityLlmLabels(db, "negotiation", id);
    return db.prepare("DELETE FROM salary_negotiations WHERE id = ?").run(id);
  });
  return NextResponse.json({ ok: true });
}

export const DELETE = withRouteErrorHandling("DELETE /api/tools/salary-negotiations/[id]", handleDelete);
export const GET = withRouteErrorHandling("GET /api/tools/salary-negotiations/[id]", handleGet);
