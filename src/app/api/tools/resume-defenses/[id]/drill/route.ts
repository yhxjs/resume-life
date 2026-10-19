import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import { LlmConfigError } from "@/lib/llm";
import {
  ModelProtocolError,
  parseDefenseDrillEvaluation,
} from "@/lib/model-protocol";
import { getDefenseReport, saveDefenseDrill } from "@/lib/resume-defense";
import {
  RESUME_DEFENSE_DRILL_SYSTEM_PROMPT,
} from "@/lib/resume-defense-llm";
import { logServerError, requestIdFrom } from "@/lib/server-errors";
import { safeChat, LLM_FEATURES } from "@/lib/safe-llm";
import { errorMessage } from "@/lib/error-message";

async function handlePost(
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
      return NextResponse.json({ error: "排雷报告不存在" }, { status: 404 });
    }

    const parsedBody = await parseApiJson<unknown>(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as {
      itemId?: unknown;
      question?: unknown;
      userAnswer?: unknown;
      defensePlan?: unknown;
    } | null;

    const itemId = typeof body?.itemId === "string" ? body.itemId.trim() : "";
    const question = typeof body?.question === "string" ? body.question.trim() : "";
    const userAnswer = typeof body?.userAnswer === "string" ? body.userAnswer.trim() : "";
    const defensePlan = typeof body?.defensePlan === "string" ? body.defensePlan.trim() : "";

    if (!itemId || !question) {
      return NextResponse.json({ error: "题目与项目信息不完整" }, { status: 400 });
    }

    if (!userAnswer) {
      return NextResponse.json({ error: "回答内容不能为空" }, { status: 400 });
    }

    const matchedItem = report.items.find((it) => it.id === itemId);
    const originalText = matchedItem ? matchedItem.originalText : "简历高危软肋";

    const selectedDefensePlan = defensePlan || matchedItem?.defensePlan.standardDefense;

    let raw: string;
    try {
      raw = await safeChat(
        "evaluate",
        { feature: LLM_FEATURES.defenseDrillGrade, entity: { type: "defense", id: numId } },
        RESUME_DEFENSE_DRILL_SYSTEM_PROMPT,
        [
          {
            role: "user",
            parts: [
              { trust: "trusted", text: "【简历原句】\n" },
              { trust: "untrusted", tag: "resume_excerpt", text: originalText },
              { trust: "trusted", text: "\n【面试官致命追问】\n" },
              { trust: "untrusted", tag: "interview_question", text: question },
              ...(selectedDefensePlan
                ? [
                    { trust: "trusted", text: "\n【参考防御方向】\n" } as const,
                    { trust: "untrusted", tag: "defense_plan", text: selectedDefensePlan } as const,
                  ]
                : []),
              { trust: "trusted", text: "\n【求职者回答】\n" },
              { trust: "untrusted", tag: "candidate_answer", text: userAnswer },
              { trust: "trusted", text: "\n\n请以毒舌大厂面试官身份对求职者的回答进行严格批改打分。" },
            ],
          },
        ],
        { signal: req.signal }
      );
    } catch (err) {
      const msg =
        err instanceof LlmConfigError
          ? err.message
          : errorMessage(err);
      return NextResponse.json({ error: msg }, { status: 502 });
    }

    let parsed;
    try {
      parsed = parseDefenseDrillEvaluation(raw);
    } catch (error) {
      if (error instanceof ModelProtocolError) {
        return NextResponse.json(
          { error: `AI 防御演练评价协议错误：${error.message}` },
          { status: 502 },
        );
      }
      throw error;
    }

    const saved = saveDefenseDrill({
      defenseId: numId,
      itemId,
      question,
      userAnswer,
      interviewerRoast: parsed.interviewer_roast,
      defenseScore: parsed.defense_score,
      defenseCritique: parsed.defense_critique,
      improvedAnswer: parsed.improved_answer,
    });

    return NextResponse.json(saved);
  } catch (err) {
    const requestId = logServerError("resume-defenses.drill.save", err, { requestId: requestIdFrom(req), status: 500 });
    return NextResponse.json(
      { error: "保存防御演练失败，请稍后重试", requestId },
      { status: 500 }
    );
  }
}

export const POST = withRouteErrorHandling("POST /api/tools/resume-defenses/[id]/drill", handlePost);
