import { withRouteErrorHandling } from "@/lib/api-route";
import { checkModelField, ModelInputBudgetError } from "@/lib/llm-input-budget";
import { NextResponse } from "next/server";
import { acquireCommandLock, getDb, inTransaction } from "@/lib/db";
import { extractJson, LlmConfigError } from "@/lib/llm";
import { loadResumeContext } from "@/lib/resumes";
import { ResumeNotFoundError } from "@/lib/resume-errors";
import {
  normalizeEvaluatorReport,
  safeScores,
  type EvaluatorReport,
  type ScoreMap,
} from "@/lib/scores";
import { interviewStyleOf } from "@/lib/interview";
import { safeChat, LLM_FEATURES, type PromptPart } from "@/lib/safe-llm";
import { errorMessage } from "@/lib/error-message";

async function handlePost(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const interviewId = Number(id);
  if (!Number.isInteger(interviewId)) {
    return NextResponse.json({ error: "无效的面试 ID" }, { status: 400 });
  }
  const release = acquireCommandLock(`interview-answer:${interviewId}`);
  if (!release) return NextResponse.json({ error: "本场面试正在处理回答或报告，请稍后重试" }, { status: 409 });
  try {
    if (req.signal.aborted) return NextResponse.json({ error: "请求已取消" }, { status: 499 });
    const db = getDb();
    const interviewQuery = db.prepare("SELECT id, resume_id, resume_version_id, jd, rounds, style, status, report, evaluator_report, reverse_interview FROM interviews WHERE id = ?");
    const interview = interviewQuery.get(interviewId) as
      | {
          id: number;
          resume_id: number; resume_version_id: number | null;
          jd: string;
          rounds: number;
          style: string;
          status: string;
          report: string;
          evaluator_report: string;
          reverse_interview: string;
        }
      | undefined;
    if (!interview) return NextResponse.json({ error: "面试不存在" }, { status: 404 });
    if (interview.evaluator_report) {
      try {
        const existing = normalizeEvaluatorReport(JSON.parse(interview.evaluator_report));
        if (existing) return NextResponse.json({ evaluator_report: existing });
      } catch { /* 缺失或损坏的面试官评估允许独立重试。 */ }
    }

    const turnsQuery = db.prepare(
      "SELECT idx, kind, question, answer, comment, scores FROM interview_turns WHERE interview_id = ? AND answered_at != '' ORDER BY idx, id"
    );
    const turns = turnsQuery.all(interviewId) as {
      idx: number;
      kind: string;
      question: string;
      answer: string;
      comment: string;
      scores: string;
    }[];
    if (turns.length === 0) {
      return NextResponse.json({ error: "还没有任何作答，无法生成录用评估报表" }, { status: 400 });
    }

    const scoreMaps: ScoreMap[] = [];
    const turnParts: PromptPart[] = [];
    turns.forEach((t, index) => {
      const scores = safeScores(t.scores);
      if (scores) scoreMaps.push(scores);
      if (index > 0) turnParts.push({ trust: "trusted", text: "\n\n" });
      turnParts.push(
        { trust: "trusted", text: "【问答记录】\n元数据：" },
        {
          trust: "untrusted",
          tag: "turn_metadata",
          text: JSON.stringify({ idx: t.idx, kind: t.kind, scores }),
        },
        { trust: "trusted", text: "\n题目：" },
        { trust: "untrusted", tag: "interview_question", text: t.question },
        { trust: "trusted", text: "\n回答：" },
        { trust: "untrusted", tag: "candidate_answer", text: t.answer },
        { trust: "trusted", text: "\n点评：" },
        { trust: "untrusted", tag: "model_comment", text: t.comment },
      );
    });

    let resumeContext = "";
    try {
      resumeContext = loadResumeContext(interview.resume_id, interview.resume_version_id);
    } catch (error) {
      if (!(error instanceof ResumeNotFoundError)) throw error;
      resumeContext = "（简历已删除）";
    }

    let reverseContext = "";
    if (interview.reverse_interview) {
      try {
        const rev = JSON.parse(interview.reverse_interview);
        if (rev?.question) {
          reverseContext = `【面试尾声反问环节（加分参考）】\n候选人提问：${rev.question}\n提问水平评分：${rev.evaluation?.score ?? "-"}分（评级：${rev.evaluation?.level ?? "-"}）\n面试官点评：${rev.evaluation?.feedback ?? ""}`;
        }
      } catch {
        reverseContext = "";
      }
    }

    const styleInfo = interviewStyleOf(interview.style);

    let raw = "";
    try {
      checkModelField(interview.jd, "岗位要求（JD）");
      raw = await safeChat("evaluate", { feature: LLM_FEATURES.interviewEvaluatorReport, entity: { type: "interview", id: interviewId } }, `你是本次面试的面试官（${styleInfo.label}风格）兼用人部门技术负责人。模拟面试已完成，你需要生成一份【面试官视角】提交给 HR 的真实录用评估报表（Internal Interview Feedback Sheet）。
要求：
- 语言客观真实、犀利交底、切中要害，写出面试官在台面下的真实考量，杜绝空话套话。
- 录用建议（recommendation）严格限定在：Strong Hire（强烈推荐录用/极力争取）、Hire（建议录用/达标）、Lean No（纠结/可录可不录/建议看备选或加面）、No Hire（不予录用/未达标/有硬伤）。
- 职级对标（level）统一采用阿里 P 级标准（如：P5 核心开发、P6 资深工程师、P7 技术专家/架构师、P8 高级专家）。
- level_justification：详细说明判定此职级的核心依据与能力边界（比如为什么给P6而不是P7，缺少了哪些层面的深度或系统权衡）。
- summary_for_hr：呈报 HR 招聘业务伙伴的一段关键定调总结（2-4句）。
- hire_reasons：建议录用的核心支撑理由/亮点清单（数组，每项1-2句）。
- concerns_and_risks：潜在顾虑与风险点清单（数组，如技术死角、沟通风格、真实经历水分等）。
- placement_suggestion：建议定岗方向及若入职试用期需重点考察/帮扶的目标。
- evidence_quotes：从实际问答中摘录 1~3 个最具代表性的实录观察（包含 turn_idx、topic 考察点、observation 现场观察与内心判断）。

输出严格的 JSON 格式：
{
  "recommendation": "Strong Hire" | "Hire" | "Lean No" | "No Hire",
  "level": "如 P6 (资深前端工程师)",
  "level_justification": "定级依据说明",
  "summary_for_hr": "呈报HR的核心定调",
  "hire_reasons": ["亮点1", "亮点2"],
  "concerns_and_risks": ["风险1", "风险2"],
  "placement_suggestion": "团队定岗与试用期建议",
  "evidence_quotes": [
    { "turn_idx": 1, "topic": "考察主题", "observation": "面试官实录观察" }
  ]
}
只输出合法 JSON，不要包含任何额外 Markdown 或解释文字。`, [
        {
          role: "user",
          parts: [
            { trust: "trusted", text: "【岗位要求】\n" },
            { trust: "untrusted", tag: "job_description", text: interview.jd },
            { trust: "trusted", text: "\n\n【候选人简历】\n" },
            { trust: "untrusted", tag: "candidate_resume", text: resumeContext },
            { trust: "trusted", text: "\n\n【全部问答】\n" },
            ...turnParts,
            ...(reverseContext
              ? [
                  { trust: "trusted", text: "\n\n" } as const,
                  { trust: "untrusted", tag: "reverse_interview", text: reverseContext } as const,
                ]
              : []),
          ],
        },
      ], { signal: req.signal, requireJson: true });
    } catch (err) {
      if (req.signal.aborted) return NextResponse.json({ error: "请求已取消" }, { status: 499 });
      const message = err instanceof LlmConfigError ? err.message : errorMessage(err);
      return NextResponse.json({ error: message }, { status: err instanceof ModelInputBudgetError ? 413 : 502 });
    }

    let evaluatorReport: EvaluatorReport | null = null;
    try {
      const parsed = extractJson<Record<string, unknown>>(raw);
      evaluatorReport = normalizeEvaluatorReport(parsed);
    } catch {
      evaluatorReport = null;
    }

    if (!evaluatorReport) {
      return NextResponse.json({ error: "AI 生成录用评估报表结果异常，请重试" }, { status: 502 });
    }

    const status = inTransaction(() => {
      if (req.signal.aborted) return 499;
      if (JSON.stringify(interviewQuery.get(interviewId)) !== JSON.stringify(interview) ||
          JSON.stringify(turnsQuery.all(interviewId)) !== JSON.stringify(turns)) return 409;
      db.prepare("UPDATE interviews SET evaluator_report = ? WHERE id = ?").run(JSON.stringify(evaluatorReport), interviewId);
      return 200;
    });
    if (status !== 200) {
      return NextResponse.json({ error: status === 499 ? "请求已取消" : "面试状态或问答已变更，请刷新后重试评估" }, { status });
    }

    return NextResponse.json({ evaluator_report: evaluatorReport });
  } finally {
    release();
  }
}

export const POST = withRouteErrorHandling("POST /api/interviews/[id]/evaluator-report", handlePost);
