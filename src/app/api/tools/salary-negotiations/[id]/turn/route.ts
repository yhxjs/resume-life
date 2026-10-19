import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import { acquireCommandLock, getDb, inTransaction, now } from "@/lib/db";
import { extractJson, LlmConfigError } from "@/lib/llm";
import {
  COMPANY_TIER_OPTIONS,
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

type RouteParams = { params: Promise<{ id: string }> };

async function handlePost(req: Request, { params }: RouteParams) {
  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "无效的演练 ID" }, { status: 400 });
  }

  const parsedBody = await parseApiJson<unknown>(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as { user_message?: unknown } | null;
  const userMessage = typeof body?.user_message === "string" ? body.user_message.trim() : "";
  if (!userMessage) {
    return NextResponse.json({ error: "说服话术不能为空" }, { status: 400 });
  }
  if (userMessage.length > MAX_NEGOTIATION_MESSAGE_CHARS) {
    return NextResponse.json({ error: `单条发言不得超过 ${MAX_NEGOTIATION_MESSAGE_CHARS} 字符` }, { status: 400 });
  }

  const db = getDb();
  const neg = db
    .prepare(
      `SELECT id, target_company_tier, target_role, expected_salary, current_or_competing_offer, hr_style, status
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
      }
    | undefined;

  if (!neg) {
    return NextResponse.json({ error: "谈判记录不存在" }, { status: 404 });
  }
  if (neg.status !== "ongoing") {
    return NextResponse.json({ error: "该谈判已结束封板，无法继续发送回合话术" }, { status: 400 });
  }

  const turns = db
    .prepare(
      `SELECT turn_no, user_message, hr_response
       FROM salary_negotiation_turns
       WHERE negotiation_id = ?
       ORDER BY turn_no ASC`
    )
    .all(id) as { turn_no: number; user_message: string; hr_response: string }[];

  const tierMatch = COMPANY_TIER_OPTIONS.find((t) => t.key === neg.target_company_tier);
  const targetCompanyTier = tierMatch ? `${tierMatch.label}（${tierMatch.desc}）` : neg.target_company_tier;

  const hrStyle: HrStyle = ["pressure", "standard", "emotional"].includes(neg.hr_style)
    ? (neg.hr_style as HrStyle)
    : "standard";
  const styleMatch = HR_STYLE_OPTIONS.find((s) => s.key === hrStyle) ?? HR_STYLE_OPTIONS[1]!;
  const hrStyleDesc = `${styleMatch.label}：${styleMatch.persona}。弱点与突破口：${styleMatch.weakness}`;

  try {
    buildTurnHistoryMessages({
      targetCompanyTier,
      targetRole: neg.target_role,
      expectedSalary: neg.expected_salary,
      currentOrCompetingOffer: neg.current_or_competing_offer,
      hrStyleDesc,
      turns,
      newUserMessage: userMessage,
    });
  } catch (err) {
    if (err instanceof NegotiationBudgetError) return NextResponse.json({ error: err.message }, { status: 400 });
    throw err;
  }

  const messages: SafeMessage[] = [
    {
      role: "user",
      parts: [
        { trust: "trusted", text: "【谈判背景】\n目标公司：" },
        { trust: "untrusted", tag: "target_company", text: targetCompanyTier },
        { trust: "trusted", text: "\n目标岗位：" },
        { trust: "untrusted", tag: "target_role", text: neg.target_role },
        { trust: "trusted", text: "\n期望薪资：" },
        { trust: "untrusted", tag: "expected_salary", text: neg.expected_salary },
        { trust: "trusted", text: "\n手头筹码或竞品：" },
        {
          trust: "untrusted",
          tag: "competing_offer",
          text: neg.current_or_competing_offer || "无特别说明",
        },
        { trust: "trusted", text: `\nHR 风格人设：${hrStyleDesc}` },
      ],
    },
  ];
  for (const turn of turns) {
    if (turn.user_message) {
      messages.push({
        role: "user",
        parts: [
          { trust: "untrusted", tag: "negotiation_turn", text: String(turn.turn_no) },
          { trust: "trusted", text: "\n" },
          { trust: "untrusted", tag: "candidate_message", text: turn.user_message },
        ],
      });
    }
    messages.push({
      role: "assistant",
      parts: [
        { trust: "untrusted", tag: "negotiation_turn", text: String(turn.turn_no) },
        { trust: "trusted", text: "\n" },
        { trust: "untrusted", tag: "hr_response", text: turn.hr_response },
      ],
    });
  }
  messages.push({
    role: "user",
    parts: [
      { trust: "trusted", text: "【求职者本轮最新说辞】\n" },
      { trust: "untrusted", tag: "candidate_message", text: userMessage },
      { trust: "trusted", text: "\n\n请生成 HR 的即时回应、HR 心理防线变化与军师拆解。" },
    ],
  });

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
        { signal: req.signal, requireJson: true }
      );
    } catch (err) {
      const message = err instanceof LlmConfigError ? err.message : errorMessage(err);
      return NextResponse.json({ error: message }, { status: 502 });
    }

    type TurnParsed = {
      hr_response?: unknown;
      hr_tactics?: unknown;
      hr_mindset?: unknown;
      mentor_analysis?: unknown;
    };

    let parsed: TurnParsed;
    try {
      parsed = extractJson<TurnParsed>(rawLlmOutput);
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
      const current = db.prepare(`UPDATE salary_negotiations SET status = status WHERE id = ? AND status = 'ongoing'
        AND (SELECT COUNT(*) FROM salary_negotiation_turns WHERE negotiation_id = ?) = ?
        AND NOT EXISTS (SELECT 1 FROM salary_negotiation_turns WHERE negotiation_id = ? AND turn_no >= ?)`)
        .run(id, id, turns.length, id, nextTurnNo);
      if (current.changes !== 1) return null;
      return db
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
    });
    if (!insertRes) return NextResponse.json({ error: "谈判状态或回合已变更，请刷新后重试" }, { status: 409 });

    const newTurn: NegotiationTurnData = {
      id: Number(insertRes.lastInsertRowid),
      negotiation_id: id,
      turn_no: nextTurnNo,
      user_message: userMessage,
      hr_response: hrResponse,
      hr_tactics: hrTactics,
      hr_mindset: hrMindset,
      mentor_analysis: mentorAnalysis,
      created_at: createdAt,
    };

    return NextResponse.json(newTurn, { status: 201 });
  } finally {
    release();
  }
}

export const POST = withRouteErrorHandling("POST /api/tools/salary-negotiations/[id]/turn", handlePost);
