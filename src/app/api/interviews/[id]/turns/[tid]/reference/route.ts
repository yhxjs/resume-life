import { parseCanonicalPositiveId } from "@/lib/id-parsing";
import { withRouteErrorHandling } from "@/lib/api-route";
import { checkModelField, ModelInputBudgetError } from "@/lib/llm-input-budget";
import { NextResponse } from "next/server";
import { getDb, inTransaction } from "@/lib/db";
import { LlmConfigError } from "@/lib/llm";
import { parseInterviewReference } from "@/lib/model-protocol";
import { captureInterviewResumeContext } from "@/lib/interview-resume-context";
import { safeChat, LLM_FEATURES } from "@/lib/safe-llm";
import { errorMessage } from "@/lib/error-message";
import { storeInterviewReference } from "@/lib/interview-training-store";
import { interviewFollowupContextParts } from "@/lib/interview-followup-context";
import { buildInterviewReferenceMessages, INTERVIEW_REFERENCE_PROMPT } from "@/lib/interview-reference-llm";

async function handlePost(
  req: Request,
  { params }: { params: Promise<{ id: string; tid: string }> }
) {
  const { id, tid } = await params;
  const interviewId = parseCanonicalPositiveId(id);
  const turnId = parseCanonicalPositiveId(tid);
  if (!Number.isSafeInteger(interviewId) || interviewId <= 0 || !Number.isSafeInteger(turnId) || turnId <= 0) {
    return NextResponse.json({ error: "无效的 ID" }, { status: 400 });
  }

  const db = getDb();
  const interviewQuery = db.prepare("SELECT id, resume_id, resume_version_id, jd, style FROM interviews WHERE id = ?");
  const interview = interviewQuery.get(interviewId) as
    | { id: number; resume_id: number; resume_version_id: number | null; jd: string; style: string }
    | undefined;
  if (!interview) return NextResponse.json({ error: "面试不存在" }, { status: 404 });

  const turnQuery = db.prepare(
    "SELECT id, idx, kind, question, answer, comment, reference, scores FROM interview_turns WHERE id = ? AND interview_id = ?"
  );
  const turn = turnQuery.get(turnId, interviewId) as
    | {
        id: number;
        idx: number;
        kind: string;
        question: string;
        answer: string;
        comment: string;
        reference: string;
        scores: string;
      }
    | undefined;
  if (!turn) return NextResponse.json({ error: "题目不存在" }, { status: 404 });
  const followupParts = interviewFollowupContextParts(interviewId, turn);

  // 如果已有参考答案，可直接返回，但支持显式生成/重新生成
  const resumeMaterial = captureInterviewResumeContext(interview.resume_id, interview.resume_version_id, "（简历未提供或已删除）");
  const resumeContext = resumeMaterial.text;

  let reference = "";
  try {
    checkModelField(interview.jd, "岗位要求（JD）");
    const raw = await safeChat("question", { feature: LLM_FEATURES.interviewReference, entity: { type: "interview", id: interviewId } }, INTERVIEW_REFERENCE_PROMPT,
      buildInterviewReferenceMessages({ jd: interview.jd, resumeContext, followupParts, turn: { idx: turn.idx, question: turn.question }, answer: turn.answer }),
      { signal: req.signal, requireJson: "strict" });
    reference = parseInterviewReference(raw);
  } catch (err) {
    const message = err instanceof LlmConfigError ? err.message : errorMessage(err);
    return NextResponse.json({ error: message }, { status: err instanceof ModelInputBudgetError ? 413 : 502 });
  }

  if (!reference) {
    return NextResponse.json({ error: "参考答案生成失败，请重试" }, { status: 502 });
  }

  // 写入数据库
  const updated = inTransaction(() => {
    if (JSON.stringify(interviewQuery.get(interviewId)) !== JSON.stringify(interview) ||
        JSON.stringify(turnQuery.get(turnId, interviewId)) !== JSON.stringify(turn) ||
        !resumeMaterial.isCurrent() ||
        JSON.stringify(interviewFollowupContextParts(interviewId, turn)) !== JSON.stringify(followupParts)) {
      return { changes: 0 };
    }
    return storeInterviewReference(interviewId, turnId, reference);
  });
  if (updated.changes === 0) {
    const exists = db.prepare("SELECT 1 FROM interview_turns WHERE id = ? AND interview_id = ?").get(turnId, interviewId);
    return NextResponse.json({ error: exists ? "面试资料、题目或追问上下文已更新，请刷新后重试" : "题目不存在" }, { status: exists ? 409 : 404 });
  }

  return NextResponse.json({ reference });
}

export const POST = withRouteErrorHandling(
  "POST /api/interviews/[id]/turns/[tid]/reference",
  handlePost
);
