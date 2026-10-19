import { withRouteErrorHandling } from "@/lib/api-route";
import { NextResponse } from "next/server";
import { deleteDefenseReport, getDefenseDrills, getDefenseReport } from "@/lib/resume-defense";
import { logServerError, requestIdFrom } from "@/lib/server-errors";

async function handleGet(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const numId = Number(id);
    if (!Number.isInteger(numId) || numId <= 0) {
      return NextResponse.json({ error: "无效的报告 ID" }, { status: 400 });
    }

    const report = getDefenseReport(numId);
    if (!report) {
      return NextResponse.json({ error: "排雷报告不存在或已删除" }, { status: 404 });
    }

    const drills = getDefenseDrills(numId);

    return NextResponse.json({
      report,
      drills,
    });
  } catch (err) {
    const requestId = logServerError("resume-defenses.get", err, { requestId: requestIdFrom(req), status: 500 });
    return NextResponse.json(
      { error: "读取排雷报告失败，请稍后重试", requestId },
      { status: 500 }
    );
  }
}

async function handleDelete(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const numId = Number(id);
    if (!Number.isInteger(numId) || numId <= 0) {
      return NextResponse.json({ error: "无效的报告 ID" }, { status: 400 });
    }

    const ok = deleteDefenseReport(numId);
    if (!ok) {
      return NextResponse.json({ error: "排雷报告不存在或已删除" }, { status: 404 });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    const requestId = logServerError("resume-defenses.delete", err, { requestId: requestIdFrom(req), status: 500 });
    return NextResponse.json(
      { error: "删除排雷报告失败，请稍后重试", requestId },
      { status: 500 }
    );
  }
}

export const GET = withRouteErrorHandling("GET /api/tools/resume-defenses/[id]", handleGet);
export const DELETE = withRouteErrorHandling("DELETE /api/tools/resume-defenses/[id]", handleDelete);
