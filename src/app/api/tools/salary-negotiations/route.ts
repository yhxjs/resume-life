import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import { getDb, inTransaction, now } from "@/lib/db";
import { extractJson, LlmConfigError } from "@/lib/llm";
import {
  COMPANY_TIER_OPTIONS,
  HR_STYLE_OPTIONS,
  validateGeneratedNegotiationOpening,
  type HrStyle,
} from "@/lib/salary-negotiation";
import {
  SALARY_NEGOTIATION_OPENING_PROMPT,
  buildOpeningUserPrompt,
  NegotiationBudgetError,
} from "@/lib/salary-negotiation-llm";
import { safeChat, LLM_FEATURES } from "@/lib/safe-llm";
import { errorMessage } from "@/lib/error-message";
import { createCursorPage, parsePaginationParams } from "@/lib/cursor-pagination";

async function handleGet(req: Request) {
  const searchParams = new URL(req.url).searchParams;
  const pagination = parsePaginationParams(searchParams);
  if (!pagination.ok) return pagination.response;
  const { limit, idCursor: cursor } = pagination;
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT
         sn.id,
         sn.target_company_tier,
         sn.target_role,
         sn.expected_salary,
         sn.current_or_competing_offer,
         sn.hr_style,
         sn.status,
         sn.initial_offer,
         sn.final_package,
         sn.created_at,
         sn.finished_at,
         COUNT(snt.id) AS turns_count
       FROM salary_negotiations sn
       LEFT JOIN salary_negotiation_turns snt ON snt.negotiation_id = sn.id
       ${cursor === null ? "" : "WHERE sn.id < ?"}
       GROUP BY sn.id
       ORDER BY sn.id DESC
       LIMIT ?`
    )
    .all(...(cursor === null ? [limit + 1] : [cursor, limit + 1])) as {
    id: number;
    target_company_tier: string;
    target_role: string;
    expected_salary: string;
    current_or_competing_offer: string;
    hr_style: string;
    status: string;
    initial_offer: string;
    final_package: string;
    created_at: string;
    finished_at: string;
    turns_count: number;
  }[];

  const page = createCursorPage(rows, limit, (row) => String(row.id));
  page.total = (db.prepare("SELECT COUNT(*) AS total FROM salary_negotiations").get() as { total: number }).total;
  return NextResponse.json(page);
}

async function handlePost(req: Request) {
  const parsedBody = await parseApiJson<unknown>(req);
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.data as {
    target_company_tier?: unknown;
    target_role?: unknown;
    expected_salary?: unknown;
    current_or_competing_offer?: unknown;
    hr_style?: unknown;
  } | null;

  const targetRole = typeof body?.target_role === "string" ? body.target_role.trim() : "";
  const expectedSalary = typeof body?.expected_salary === "string" ? body.expected_salary.trim() : "";
  if (!targetRole || !expectedSalary) {
    return NextResponse.json({ error: "目标岗位与期望薪资不能为空" }, { status: 400 });
  }

  const rawTier = typeof body?.target_company_tier === "string" ? body.target_company_tier.trim() : "top_tech";
  const tierMatch = COMPANY_TIER_OPTIONS.find((t) => t.key === rawTier);
  const targetCompanyTier = tierMatch ? `${tierMatch.label}（${tierMatch.desc}）` : rawTier;

  const currentOrCompeting =
    typeof body?.current_or_competing_offer === "string" ? body.current_or_competing_offer.trim() : "";

  const rawStyle = (typeof body?.hr_style === "string" ? body.hr_style.trim() : "standard") as HrStyle;
  const hrStyle: HrStyle = ["pressure", "standard", "emotional"].includes(rawStyle) ? rawStyle : "standard";
  const styleMatch = HR_STYLE_OPTIONS.find((s) => s.key === hrStyle) ?? HR_STYLE_OPTIONS[1]!;
  const hrStyleDesc = `${styleMatch.label}：${styleMatch.persona}。弱点与突破口：${styleMatch.weakness}`;

  let rawLlmOutput: string;
  try {
    buildOpeningUserPrompt({
      targetCompanyTier,
      targetRole,
      expectedSalary,
      currentOrCompetingOffer: currentOrCompeting,
      hrStyleDesc,
    });
    rawLlmOutput = await safeChat(
      "evaluate",
      { feature: LLM_FEATURES.negotiationStart },
      SALARY_NEGOTIATION_OPENING_PROMPT,
      [
        {
          role: "user",
          parts: [
            { trust: "trusted", text: "【目标公司类型】\n" },
            { trust: "untrusted", tag: "target_company", text: targetCompanyTier },
            { trust: "trusted", text: "\n【目标岗位及职级】\n" },
            { trust: "untrusted", tag: "target_role", text: targetRole },
            { trust: "trusted", text: "\n【求职者期望薪资】\n" },
            { trust: "untrusted", tag: "expected_salary", text: expectedSalary },
            { trust: "trusted", text: "\n【求职者现有或竞品 Offer 筹码】\n" },
            {
              trust: "untrusted",
              tag: "competing_offer",
              text: currentOrCompeting || "暂无特别说明",
            },
            { trust: "trusted", text: `\n【HR 风格偏好及人设】\n${hrStyleDesc}\n\n请根据以上背景，生成这场 Offer 薪酬博弈的开局（HR 初始出招 + 心理防线 + 军师解盘）。` },
          ],
        },
      ],
      { signal: req.signal, requireJson: true }
    );
  } catch (err) {
    const message = err instanceof LlmConfigError ? err.message : errorMessage(err);
    return NextResponse.json({ error: message }, { status: err instanceof NegotiationBudgetError ? 400 : 502 });
  }

  type OpeningParsed = {
    initial_offer?: unknown;
    hr_response?: unknown;
    hr_tactics?: unknown;
    hr_mindset?: unknown;
    mentor_analysis?: unknown;
  };

  let parsed: OpeningParsed;
  try {
    parsed = extractJson<OpeningParsed>(rawLlmOutput);
  } catch (err) {
    return NextResponse.json(
      { error: `AI 初始出招格式解析失败：${errorMessage(err)}` },
      { status: 502 }
    );
  }

  const generated = validateGeneratedNegotiationOpening(parsed);
  if (!generated) return NextResponse.json({ error: "AI 初始出招缺少必要字段，请重试" }, { status: 502 });
  const { initial_offer: initialOffer, hr_response: hrResponse, hr_tactics: hrTactics, hr_mindset: hrMindset, mentor_analysis: mentorAnalysis } = generated;

  const createdAt = now();

  const newId = inTransaction(() => {
    const db = getDb();
    const negRes = db
      .prepare(
        `INSERT INTO salary_negotiations (
          target_company_tier,
          target_role,
          expected_salary,
          current_or_competing_offer,
          hr_style,
          status,
          initial_offer,
          final_package,
          report,
          created_at
        ) VALUES (?, ?, ?, ?, ?, 'ongoing', ?, '', '', ?)`
      )
      .run(rawTier, targetRole, expectedSalary, currentOrCompeting, hrStyle, initialOffer, createdAt);

    const negotiationId = Number(negRes.lastInsertRowid);

    db.prepare(
      `INSERT INTO salary_negotiation_turns (
        negotiation_id,
        turn_no,
        user_message,
        hr_response,
        hr_tactics,
        hr_mindset,
        mentor_analysis,
        created_at
      ) VALUES (?, 1, '', ?, ?, ?, ?, ?)`
    ).run(
      negotiationId,
      hrResponse,
      hrTactics,
      JSON.stringify(hrMindset),
      JSON.stringify(mentorAnalysis),
      createdAt
    );

    return negotiationId;
  });

  return NextResponse.json({ id: newId }, { status: 201 });
}

export const GET = withRouteErrorHandling("GET /api/tools/salary-negotiations", handleGet);
export const POST = withRouteErrorHandling("POST /api/tools/salary-negotiations", handlePost);
