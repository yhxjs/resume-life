import { parseCanonicalPositiveId } from "@/lib/id-parsing";
import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import { acquireCommandLock, getDb, inTransaction, now } from "@/lib/db";
import { LlmConfigError } from "@/lib/llm";
import {
  describeNegotiationCompany,
  describeNegotiationHrStyle,
  HR_STYLE_OPTIONS,
  validateGeneratedNegotiationTurn,
  type HrStyle,
  type NegotiationTurnData,
} from "@/lib/salary-negotiation";
import {
  SALARY_NEGOTIATION_TURN_PROMPT,
  buildTurnHistoryMessages,
  MAX_NEGOTIATION_MESSAGE_CHARS,
  NegotiationBudgetError,
} from "@/lib/salary-negotiation-llm";
import { safeChat, LLM_FEATURES, type SafeMessage } from "@/lib/safe-llm";
import { errorMessage } from "@/lib/error-message";
import { negotiationContextMatches } from "@/lib/salary-negotiation-context";
import { isSalaryNegotiationRevision, readSalaryNegotiationSnapshot } from "@/lib/salary-negotiation-snapshot";

type RouteParams = { params: Promise<{ id: string }> };

async function handlePost(req: Request, { params }: RouteParams) {
  const { id: rawId } = await params;
  const id = parseCanonicalPositiveId(rawId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return NextResponse.json({ error: "无效的演练 ID" }, { status: 400 });
  }

  const parsedBody = await parseApiJson<unknown>(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as { user_message?: unknown; expected_revision?: unknown } | null;
  const userMessage = typeof body?.user_message === "string" ? body.user_message.trim() : "";
  if (!userMessage) {
    return NextResponse.json({ error: "说服话术不能为空" }, { status: 400 });
  }
  if (userMessage.length > MAX_NEGOTIATION_MESSAGE_CHARS) {
    return NextResponse.json({ error: `单条发言不得超过 ${MAX_NEGOTIATION_MESSAGE_CHARS} 字符` }, { status: 400 });
  }
  if (!isSalaryNegotiationRevision(body?.expected_revision)) {
    return NextResponse.json({ error: "谈判记录版本无效，请重新读取" }, { status: 400 });
  }

  const db = getDb();
  const snapshot = readSalaryNegotiationSnapshot(id);
  if (!snapshot) {
    return NextResponse.json({ error: "谈判记录不存在" }, { status: 404 });
  }
  if (snapshot.revision !== body.expected_revision) {
    return NextResponse.json({ error: "谈判资料或回合已变更，请重新读取后确认" }, { status: 409 });
  }
  const { negotiation: neg, turns } = snapshot;
  if (neg.status !== "ongoing") {
    return NextResponse.json({ error: "该谈判已结束封板，无法继续发送回合话术" }, { status: 400 });
  }

  const targetCompanyTier = describeNegotiationCompany(neg.target_company_tier);

  const hrStyle: HrStyle = ["pressure", "standard", "emotional"].includes(neg.hr_style)
    ? (neg.hr_style as HrStyle)
    : "standard";
  const styleMatch = HR_STYLE_OPTIONS.find((s) => s.key === hrStyle) ?? HR_STYLE_OPTIONS[1]!;
  const hrStyleDesc = describeNegotiationHrStyle(styleMatch);

  let messages: SafeMessage[];
  try {
    messages = buildTurnHistoryMessages({
      targetCompanyTier,
      targetRole: neg.target_role,
      expectedSalary: neg.expected_salary,
      currentOrCompetingOffer: neg.current_or_competing_offer,
      hrStyleDesc,
      initialOffer: neg.initial_offer,
      turns,
      newUserMessage: userMessage,
    });
  } catch (err) {
    if (err instanceof NegotiationBudgetError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }

  const release = acquireCommandLock(`salary-negotiation:${id}`);
  if (!release) return NextResponse.json({ error: "正在处理当前谈判，请稍后重试" }, { status: 409 });
  try {
    let rawLlmOutput: string;
    try {
      rawLlmOutput = await safeChat(
        "evaluate",
        { feature: LLM_FEATURES.negotiationTurn, entity: { type: "negotiation", id } },
        SALARY_NEGOTIATION_TURN_PROMPT,
        messages,
        {
          signal: req.signal,
          requireJson: "strict"
        }
      );
    } catch (err) {
      const message = err instanceof LlmConfigError ? err.message : errorMessage(err);
      return NextResponse.json({ error: message }, { status: 502 });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLlmOutput);
    } catch (err) {
      return NextResponse.json(
        { error: `AI 回合响应解析失败：${errorMessage(err)}` },
        { status: 502 }
      );
    }

    // 模型结果必须包含完整评价后才可入库。
    const generated = validateGeneratedNegotiationTurn(parsed);
    if (!generated) return NextResponse.json({ error: "AI 回合响应缺少必要字段，请重试" }, { status: 502 });
    const { hr_response: hrResponse, hr_tactics: hrTactics, hr_mindset: hrMindset, mentor_analysis: mentorAnalysis } = generated;

    const nextTurnNo = Math.max(0, ...turns.map((turn) => turn.turn_no)) + 1;
    const createdAt = now();

    const insertRes = inTransaction(() => {
      req.signal.throwIfAborted();
      if (!negotiationContextMatches({ phase: "turn", negotiation: neg, turns })) return null;
      const base = readSalaryNegotiationSnapshot(id);
      if (!base) return null;
      const current = db.prepare(`UPDATE salary_negotiations SET status = status WHERE id = ? AND status = 'ongoing'
        AND (SELECT COUNT(*) FROM salary_negotiation_turns WHERE negotiation_id = ?) = ?
        AND NOT EXISTS (SELECT 1 FROM salary_negotiation_turns WHERE negotiation_id = ? AND turn_no >= ?)`)
        .run(id, id, turns.length, id, nextTurnNo);
      if (current.changes !== 1) return null;
      const inserted = db
        .prepare(
          `INSERT INTO salary_negotiation_turns (
            negotiation_id,
            turn_no,
            user_message,
            hr_response,
            hr_tactics,
            hr_mindset,
            mentor_analysis,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          nextTurnNo,
          userMessage,
          hrResponse,
          hrTactics,
          JSON.stringify(hrMindset),
          JSON.stringify(mentorAnalysis),
          createdAt
        );
      const saved = readSalaryNegotiationSnapshot(id);
      if (!saved) throw new Error("谈判回合保存后记录不存在");
      return { inserted, base_revision: base.revision, revision: saved.revision };
    });
    if (!insertRes) return NextResponse.json({ error: "谈判资料、状态或回合已变更，请刷新后重试" }, { status: 409 });

    const newTurn: NegotiationTurnData = {
      id: Number(insertRes.inserted.lastInsertRowid),
      negotiation_id: id,
      turn_no: nextTurnNo,
      user_message: userMessage,
      hr_response: hrResponse,
      hr_tactics: hrTactics,
      hr_mindset: hrMindset,
      mentor_analysis: mentorAnalysis,
      created_at: createdAt,
    };

    return NextResponse.json({ ...newTurn, base_revision: insertRes.base_revision, revision: insertRes.revision }, { status: 201 });
  } finally {
    release();
  }
}

export const POST = withRouteErrorHandling("POST /api/tools/salary-negotiations/[id]/turn", handlePost);
