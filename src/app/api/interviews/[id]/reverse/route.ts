import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { checkModelField, ModelInputBudgetError } from "@/lib/llm-input-budget";
import { NextResponse } from "next/server";
import { acquireCommandLock, getDb, inTransaction, now } from "@/lib/db";
import { LlmConfigError } from "@/lib/llm";
import { interviewStyleOf, type ReverseInterviewData } from "@/lib/interview";
import { loadResumeContext } from "@/lib/resumes";
import { ResumeNotFoundError } from "@/lib/resume-errors";
import { safeChat, LLM_FEATURES, type SafeMessage } from "@/lib/safe-llm";
import { errorMessage } from "@/lib/error-message";
import { parseReverseInterviewResponse, type ReverseInterviewResponse } from "@/lib/model-protocol";

const REVERSE_PROMPT = (persona: string) => `你是面试官（你的人设：${persona}）。面试主提问环节已结束，现在进入尾声的「候选人反问环节（Reverse Interview）」。
候选人针对岗位/团队/技术向你提出了一个问题。请完成两项任务：
1) 真实作答（answer）：以你的面试官人设、语气以及岗位实际情况真实回答候选人的提问。语气要符合人设（如压力面、技术专家面、HR面或温和面），内容要具体、有信息量、真诚专业，200-300字左右。
2) 评价候选人的提问水平（evaluation）：从专业面试官视角客观评价候选人该提问的质量与展现出的特质。
   - score: 1-10 整数打分（1-3分：提问空泛/只问待遇福利且缺乏业务思考；4-6分：常规提问，中规中矩；7-8分：切中岗位核心挑战/技术与团队运作；9-10分：体现出深刻的业务思考、架构视野与对岗位的深度兴趣）。
   - level: 字符串，评级（"卓越" | "优秀" | "良好" | "一般" | "有待提升"）。
   - insight: 1-2 句，分析候选人通过这个问题展现了什么特质/视角（如展现了对业务落地的关切、对技术深度的追求、还是缺乏准备）。
   - feedback: 2-3 句，对该提问的具体优点或不足进行犀利/中肯的点评。
   - suggestions: 1-2 句，给出如何将该提问提升得更有深度、更能在面试官心中加分的具体改写或思路建议。

请严格输出 JSON 格式：
{
  "answer": "面试官作答内容...",
  "evaluation": {
    "score": 8,
    "level": "优秀",
    "insight": "...",
    "feedback": "...",
    "suggestions": "..."
  }
}
只输出 JSON。`;

async function handlePost(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const interviewId = Number(id);
  if (!Number.isInteger(interviewId)) {
    return NextResponse.json({ error: "无效的面试 ID" }, { status: 400 });
  }

  const parsedBody = await parseApiJson<unknown>(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as { question?: unknown } | null;
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  if (!question) {
    return NextResponse.json({ error: "提问内容不能为空" }, { status: 400 });
  }

  const release = acquireCommandLock(`interview-answer:${interviewId}`);
  if (!release) return NextResponse.json({ error: "本场面试正在处理回答或报告，请稍后重试" }, { status: 409 });
  try {
    if (req.signal.aborted) return NextResponse.json({ error: "请求已取消" }, { status: 499 });
    const db = getDb();
    const interview = db
      .prepare("SELECT id, resume_id, resume_version_id, jd, rounds, style, status, report, reverse_interview FROM interviews WHERE id = ?")
      .get(interviewId) as
      | {
          id: number;
          resume_id: number; resume_version_id: number | null;
          jd: string;
          rounds: number;
          style: string;
          status: string;
          report: string;
          reverse_interview: string;
        }
      | undefined;

    if (!interview) return NextResponse.json({ error: "面试不存在" }, { status: 404 });
    if (interview.report) {
      return NextResponse.json({ error: "总结报告已生成，无法再进行反问" }, { status: 400 });
    }
    if (interview.reverse_interview) {
      return NextResponse.json({ error: "该场面试的反问环节已完成" }, { status: 400 });
    }

    let resumeContext = "";
    try {
      resumeContext = loadResumeContext(interview.resume_id, interview.resume_version_id);
    } catch (error) {
      if (!(error instanceof ResumeNotFoundError)) throw error;
      resumeContext = "（简历已删除）";
    }

    const turns = db
      .prepare(
        "SELECT idx, kind, question, answer FROM interview_turns WHERE interview_id = ? AND answered_at != '' ORDER BY idx"
      )
      .all(interviewId) as { idx: number; kind: string; question: string; answer: string }[];

    const messages: SafeMessage[] = [
      {
        role: "user",
        parts: [
          { trust: "trusted", text: "【岗位要求】\n" },
          { trust: "untrusted", tag: "job_description", text: interview.jd },
          { trust: "trusted", text: "\n\n【候选人简历】\n" },
          { trust: "untrusted", tag: "candidate_resume", text: resumeContext },
        ],
      },
    ];
    for (const turn of turns) {
      messages.push(
        {
          role: "assistant",
          parts: [
            { trust: "untrusted", tag: "interview_question", text: turn.question },
          ],
        },
        {
          role: "user",
          parts: [
            { trust: "untrusted", tag: "candidate_answer", text: turn.answer.slice(0, 150) },
          ],
        },
      );
    }
    messages.push({
      role: "user",
      parts: [
        { trust: "trusted", text: "【候选人的反问】\n" },
        { trust: "untrusted", tag: "candidate_question", text: question },
        { trust: "trusted", text: "\n\n请按人设作答并评估提问水平。" },
      ],
    });

    let raw = "";
    try {
      checkModelField(interview.jd, "岗位要求（JD）");
      checkModelField(question, "反问");
      raw = await safeChat(
        "evaluate",
        { feature: LLM_FEATURES.interviewReverse, entity: { type: "interview", id: interviewId } },
        REVERSE_PROMPT(interviewStyleOf(interview.style).persona),
        messages,
        { signal: req.signal, requireJson: true },
      );
    } catch (err) {
      if (req.signal.aborted) return NextResponse.json({ error: "请求已取消" }, { status: 499 });
      const message = err instanceof LlmConfigError ? err.message : errorMessage(err);
      return NextResponse.json({ error: message }, { status: err instanceof ModelInputBudgetError ? 413 : 502 });
    }

    let parsed: ReverseInterviewResponse;
    try {
      parsed = parseReverseInterviewResponse(raw);
    } catch (err) {
      return NextResponse.json(
        { error: `AI 反问评估异常：${errorMessage(err)}` },
        { status: 502 }
      );
    }

    const reverseData: ReverseInterviewData = {
      question,
      answer: parsed.answer,
      evaluation: parsed.evaluation,
      created_at: now(),
    };

    // 模型等待期间不持有事务；提交时用条件写入防止覆盖已封板或已完成的反问。
    const status = inTransaction(() => {
      if (req.signal.aborted) return 499;
      const result = db.prepare(
        "UPDATE interviews SET reverse_interview = ? WHERE id = ? AND report = '' AND reverse_interview = '' AND status = ?"
      ).run(JSON.stringify(reverseData), interviewId, interview.status);
      return result.changes === 1 ? 200 : 409;
    });
    if (status !== 200) {
      return NextResponse.json({ error: status === 499 ? "请求已取消" : "面试状态已变更，请刷新后重试" }, { status });
    }

    return NextResponse.json({
      ok: true,
      reverse: reverseData,
    });
  } finally {
    release();
  }
}

export const POST = withRouteErrorHandling("POST /api/interviews/[id]/reverse", handlePost);
