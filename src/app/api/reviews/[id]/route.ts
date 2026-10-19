import { NextResponse } from "next/server";
import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { parsePaginationParams } from "@/lib/cursor-pagination";
import { getReviewDetail, ReviewError, saveReview } from "@/lib/spaced-repetition-cards";
import { getReviewDate } from "@/lib/spaced-repetition";
import type { ReviewGrade } from "@/lib/spaced-repetition-card-types";

type Context = { params: Promise<{ id: string }> };
const validId = (value: string) => /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0;

async function handleGet(req: Request, { params }: Context) {
  const { id } = await params;
  if (!validId(id)) return NextResponse.json({ error: "无效的复习 ID" }, { status: 400 });
  try {
    const search = new URL(req.url).searchParams;
    const today = getReviewDate(new Date(), search.get("time_zone") ?? undefined);
    const page = parsePaginationParams(search);
    if (!page.ok) return page.response;
    const detail = getReviewDetail(Number(id), page.limit, page.idCursor, today);
    return detail ? NextResponse.json(detail) : NextResponse.json({ error: "复习题目不存在" }, { status: 404 });
  } catch (error) {
    if (error instanceof RangeError) return NextResponse.json({ error: "分页参数或时区无效" }, { status: 400 });
    throw error;
  }
}

async function handlePost(req: Request, { params }: Context) {
  const { id } = await params;
  if (!validId(id)) return NextResponse.json({ error: "无效的复习 ID" }, { status: 400 });
  const parsed = await parseApiJson<unknown>(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data as { answer?: unknown; grade?: unknown; expected_review_count?: unknown; request_id?: unknown; time_zone?: unknown } | null;
  const answer = typeof body?.answer === "string" ? body.answer.trim() : "";
  const grade = body?.grade;
  if (answer.includes("\u0000")) return NextResponse.json({ error: "回答不能包含空字符" }, { status: 400 });
  if (!answer || answer.length > 20000 || (grade !== "again" && grade !== "hard" && grade !== "good" && grade !== "easy") ||
      !Number.isSafeInteger(body?.expected_review_count) || (body!.expected_review_count as number) < 0 ||
      typeof body?.request_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.request_id) ||
      (body.time_zone !== undefined && typeof body.time_zone !== "string")) {
    return NextResponse.json({ error: "请填写 1–20000 字的回答，并提交有效的自评和复习版本" }, { status: 400 });
  }
  const timeZone = body.time_zone as string | undefined;
  try { getReviewDate(new Date(), timeZone); } catch {
    return NextResponse.json({ error: "时区无效" }, { status: 400 });
  }
  try {
    return NextResponse.json(saveReview(Number(id), { answer, grade: grade as ReviewGrade, expected_review_count: body.expected_review_count as number, request_id: body.request_id, time_zone: timeZone }));
  } catch (error) {
    if (error instanceof ReviewError) return NextResponse.json({ error: error.message }, { status: error.status });
    throw error;
  }
}

export const GET = withRouteErrorHandling("GET /api/reviews/[id]", handleGet);
export const POST = withRouteErrorHandling("POST /api/reviews/[id]", handlePost);
