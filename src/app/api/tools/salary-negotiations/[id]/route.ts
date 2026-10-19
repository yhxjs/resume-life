import { clearEntityLlmLabels } from "@/lib/llm-label-cleanup";
import { withRouteErrorHandling } from "@/lib/api-route";
import { NextResponse } from "next/server";
import { getDb, inTransaction } from "@/lib/db";
import {
  normalizeHrMindset,
  normalizeMentorAnalysis,
  normalizeNegotiationReport,
  type NegotiationTurnData,
  type SalaryNegotiationDetail,
} from "@/lib/salary-negotiation";

type RouteParams = { params: Promise<{ id: string }> };

async function handleGet(_req: Request, { params }: RouteParams) {
  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "无效的演练 ID" }, { status: 400 });
  }

  const db = getDb();
  const neg = db
    .prepare(
      `SELECT
         id,
         target_company_tier,
         target_role,
         expected_salary,
         current_or_competing_offer,
         hr_style,
         status,
         initial_offer,
         final_package,
         report,
         created_at,
         finished_at
       FROM salary_negotiations
       WHERE id = ?`
    )
    .get(id) as
    | {
        id: number;
        target_company_tier: string;
        target_role: string;
        expected_salary: string;
        current_or_competing_offer: string;
        hr_style: string;
        status: string;
        initial_offer: string;
        final_package: string;
        report: string;
        created_at: string;
        finished_at: string;
      }
    | undefined;

  if (!neg) {
    return NextResponse.json({ error: "谈判演练记录不存在" }, { status: 404 });
  }

  const turnRows = db
    .prepare(
      `SELECT
         id,
         negotiation_id,
         turn_no,
         user_message,
         hr_response,
         hr_tactics,
         hr_mindset,
         mentor_analysis,
         created_at
       FROM salary_negotiation_turns
       WHERE negotiation_id = ?
       ORDER BY turn_no ASC`
    )
    .all(id) as {
    id: number;
    negotiation_id: number;
    turn_no: number;
    user_message: string;
    hr_response: string;
    hr_tactics: string;
    hr_mindset: string;
    mentor_analysis: string;
    created_at: string;
  }[];

  const turns: NegotiationTurnData[] = turnRows.map((r) => {
    let mindsetRaw: unknown = null;
    let mentorRaw: unknown = null;
    try {
      mindsetRaw = JSON.parse(r.hr_mindset);
    } catch {
      // 容错
    }
    try {
      mentorRaw = JSON.parse(r.mentor_analysis);
    } catch {
      // 容错
    }

    return {
      id: r.id,
      negotiation_id: r.negotiation_id,
      turn_no: r.turn_no,
      user_message: r.user_message,
      hr_response: r.hr_response,
      hr_tactics: r.hr_tactics,
      hr_mindset: normalizeHrMindset(mindsetRaw),
      mentor_analysis: normalizeMentorAnalysis(mentorRaw),
      created_at: r.created_at,
    };
  });

  let reportParsed: unknown = null;
  if (neg.report) {
    try {
      reportParsed = JSON.parse(neg.report);
    } catch {
      // 容错
    }
  }

  const detail: SalaryNegotiationDetail = {
    id: neg.id,
    target_company_tier: neg.target_company_tier,
    target_role: neg.target_role,
    expected_salary: neg.expected_salary,
    current_or_competing_offer: neg.current_or_competing_offer,
    hr_style: neg.hr_style as SalaryNegotiationDetail["hr_style"],
    status: neg.status as SalaryNegotiationDetail["status"],
    initial_offer: neg.initial_offer,
    final_package: neg.final_package,
    report: normalizeNegotiationReport(reportParsed),
    created_at: neg.created_at,
    finished_at: neg.finished_at,
    turns,
  };

  return NextResponse.json(detail);
}

async function handleDelete(_req: Request, { params }: RouteParams) {
  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isFinite(id) || id <= 0) {
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
