import { parseCanonicalPositiveId } from "@/lib/id-parsing";
import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import { acquireCommandLock } from "@/lib/db";
import { LlmConfigError } from "@/lib/llm";
import { ModelInputBudgetError } from "@/lib/llm-input-budget";
import {
  ModelProtocolError,
  parseDefenseDrillEvaluation,
} from "@/lib/model-protocol";
import { DefenseDrillSaveError, getDefenseDrill, getDefenseReport, saveDefenseDrill } from "@/lib/resume-defense";
import {
  buildResumeDefenseDrillMessages,
  RESUME_DEFENSE_DRILL_SYSTEM_PROMPT,
} from "@/lib/resume-defense-llm";
import { logServerError, requestIdFrom } from "@/lib/server-errors";
import { safeChat, LLM_FEATURES } from "@/lib/safe-llm";
import { errorMessage } from "@/lib/error-message";

async function handlePost(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  let release: (() => void) | null = null;
  try {
    const { id } = await params;
    const numId = parseCanonicalPositiveId(id);
    if (!Number.isSafeInteger(numId) || numId <= 0) {
      return NextResponse.json({ error: "无效的报告 ID" }, { status: 400 });
    }

    const report = getDefenseReport(numId);
    if (!report) {
      return NextResponse.json({ error: "排雷报告不存在" }, { status: 404 });
    }

    const parsedBody = await parseApiJson<unknown>(req);
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.data;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "请求体必须是 JSON 对象" }, { status: 400 });
    }
    const fields = body as Record<string, unknown>;
    if (["itemId", "question", "userAnswer", "defensePlan"].some(
      (field) => fields[field] !== undefined && typeof fields[field] !== "string",
    )) {
      return NextResponse.json({ error: "演练条目、问题、回答和参考方案必须是字符串" }, { status: 400 });
    }

    const itemId = typeof fields.itemId === "string" ? fields.itemId.trim() : "";
    const question = typeof fields.question === "string" ? fields.question.trim() : "";
    const userAnswer = typeof fields.userAnswer === "string" ? fields.userAnswer.trim() : "";
    const defensePlan = typeof fields.defensePlan === "string" ? fields.defensePlan.trim() : "";

    if (!itemId || !question) {
      return NextResponse.json({ error: "题目与项目信息不完整" }, { status: 400 });
    }

    if (!userAnswer) {
      return NextResponse.json({ error: "回答内容不能为空" }, { status: 400 });
    }

    const matchedItem = report.items.find((it) => it.id === itemId);
    if (!matchedItem) {
      return NextResponse.json({ error: "演练条目不存在，请刷新报告后重试" }, { status: 400 });
    }
    const originalText = matchedItem.originalText;

    // 同进程重复提交在模型前拒绝；保存事务仍复核跨进程写入和背景变化。
    release = acquireCommandLock(`defense-drill:${JSON.stringify([numId, itemId])}`);
    if (!release) {
      return NextResponse.json({ error: "该条演练正在评分，请稍后重试" }, { status: 409 });
    }

    const selectedDefensePlan = defensePlan || matchedItem.defensePlan.standardDefense;
    const saveGuard = {
      sourceContent: report.sourceContent.trim() ? report.sourceContent : "",
      originalText,
      ...(!defensePlan ? { defaultDefensePlan: matchedItem.defensePlan.standardDefense } : {}),
      previousDrill: getDefenseDrill(numId, itemId),
    };

    let raw: string;
    try {
      raw = await safeChat(
        "evaluate",
        { feature: LLM_FEATURES.defenseDrillGrade, entity: { type: "defense", id: numId } },
        RESUME_DEFENSE_DRILL_SYSTEM_PROMPT,
        buildResumeDefenseDrillMessages({ resumeSource: report.sourceContent, originalText, question, defensePlan: selectedDefensePlan, answer: userAnswer }),
        { signal: req.signal, requireJson: "strict" }
      );
    } catch (err) {
      const msg =
        err instanceof LlmConfigError
          ? err.message
          : errorMessage(err);
      return NextResponse.json({ error: msg }, { status: err instanceof ModelInputBudgetError ? 413 : 502 });
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
    }, saveGuard);

    return NextResponse.json(saved);
  } catch (err) {
    if (err instanceof DefenseDrillSaveError) return NextResponse.json({ error: err.message }, { status: err.status });
    const requestId = logServerError("resume-defenses.drill.save", err, { requestId: requestIdFrom(req), status: 500 });
    return NextResponse.json(
      { error: "保存防御演练失败，请稍后重试", requestId },
      { status: 500 }
    );
  } finally {
    release?.();
  }
}

export const POST = withRouteErrorHandling("POST /api/tools/resume-defenses/[id]/drill", handlePost);
