import { withRouteErrorHandling } from "@/lib/api-route";
import { checkModelField, ModelInputBudgetError } from "@/lib/llm-input-budget";
import { NextResponse } from "next/server";
import { getDb, inTransaction } from "@/lib/db";
import { LlmConfigError } from "@/lib/llm";
import { parseInterviewReference } from "@/lib/model-protocol";
import { loadResumeContext } from "@/lib/resumes";
import { ResumeNotFoundError } from "@/lib/resume-errors";
import { safeChat, LLM_FEATURES } from "@/lib/safe-llm";
import { errorMessage } from "@/lib/error-message";
import { syncNotebookSnapshot } from "@/lib/notebook";

async function handlePost(
  req: Request,
  { params }: { params: Promise<{ id: string; tid: string }> }
) {
  const { id, tid } = await params;
  const interviewId = Number(id);
  const turnId = Number(tid);
  if (!Number.isInteger(interviewId) || !Number.isInteger(turnId)) {
    return NextResponse.json({ error: "无效的 ID" }, { status: 400 });
  }

  const db = getDb();
  const interview = db
    .prepare("SELECT id, resume_id, resume_version_id, jd, style FROM interviews WHERE id = ?")
    .get(interviewId) as
    | { id: number; resume_id: number; resume_version_id: number | null; jd: string; style: string }
    | undefined;
  if (!interview) return NextResponse.json({ error: "面试不存在" }, { status: 404 });

  const turn = db
    .prepare(
      "SELECT id, idx, kind, question, answer, comment, reference, scores FROM interview_turns WHERE id = ? AND interview_id = ?"
    )
    .get(turnId, interviewId) as
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

  // 如果已有参考答案，可直接返回，但支持显式生成/重新生成
  let resumeContext = "";
  try {
    resumeContext = loadResumeContext(interview.resume_id, interview.resume_version_id);
  } catch (error) {
    if (!(error instanceof ResumeNotFoundError)) throw error;
    resumeContext = "（简历未提供或已删除）";
  }

  const prompt = `你是资深面试辅导专家与大厂面试官。请基于候选人应聘的岗位要求、简历背景以及原问题和候选人的回答，生成一份高水平、示范性的「改进版参考答案」。
要求：
1. 结构清晰、层次分明（如 STAR 原则、原理+技术选型与权衡、数据成果）；
2. 紧扣该岗位真实考察点，语言专业可信，既展现扎实的技术深度或职业素养，又体现诚实自洽；
3. 输出格式为 JSON：
{
  "reference": "一段完整、专业、可以直接作为标杆学习的参考答案内容（可使用段落换行与标点增强可读性）"
}
只输出 JSON。`;

  let reference = "";
  try {
    checkModelField(interview.jd, "岗位要求（JD）");
    const raw = await safeChat("question", { feature: LLM_FEATURES.interviewReference, entity: { type: "interview", id: interviewId } }, prompt, [
      {
        role: "user",
        parts: [
          { trust: "trusted", text: "【岗位要求 JD】\n" },
          {
            trust: "untrusted",
            tag: "job_description",
            text: interview.jd || "（通用岗位）",
          },
          { trust: "trusted", text: "\n\n【候选人简历背景】\n" },
          { trust: "untrusted", tag: "candidate_resume", text: resumeContext },
          { trust: "trusted", text: "\n\n【面试题目】\n" },
          {
            trust: "untrusted",
            tag: "interview_question",
            text: JSON.stringify({ idx: turn.idx, question: turn.question }),
          },
          { trust: "trusted", text: "\n\n【候选人原答】\n" },
          {
            trust: "untrusted",
            tag: "candidate_answer",
            text: turn.answer || "（尚未作答）",
          },
          ...(turn.comment
            ? [
                { trust: "trusted", text: "\n【面试官点评】\n" } as const,
                { trust: "untrusted", tag: "model_comment", text: turn.comment } as const,
              ]
            : []),
        ],
      },
    ], { signal: req.signal });
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
    const res = db.prepare(
      "UPDATE interview_turns SET reference = ? WHERE id = ? AND interview_id = ? AND question = ? AND answer = ? AND comment = ? AND reference = ?"
    ).run(reference, turnId, interviewId, turn.question, turn.answer, turn.comment, turn.reference);
    if (res.changes === 1) {
      syncNotebookSnapshot(db, "interview", turnId, {
        reference,
        answer: turn.answer,
        comment: turn.comment,
        scores: turn.scores,
      });
    }
    return res;
  });
  if (updated.changes === 0) {
    const exists = db.prepare("SELECT 1 FROM interview_turns WHERE id = ? AND interview_id = ?").get(turnId, interviewId);
    return NextResponse.json({ error: exists ? "题目内容已更新，请刷新后重试" : "题目不存在" }, { status: exists ? 409 : 404 });
  }

  return NextResponse.json({ reference });
}

export const POST = withRouteErrorHandling(
  "POST /api/interviews/[id]/turns/[tid]/reference",
  handlePost
);
