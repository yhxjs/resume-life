import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import { getDb, inTransaction, now } from "@/lib/db";
import { createSalaryNegotiation } from "@/lib/career-tool-store";
import { LlmConfigError } from "@/lib/llm";
import {
  describeNegotiationCompany,
  describeNegotiationHrStyle,
  HR_STYLE_OPTIONS,
  validateGeneratedNegotiationOpening,
} from "@/lib/salary-negotiation";
import {
  SALARY_NEGOTIATION_OPENING_PROMPT,
  buildOpeningMessages,
  NegotiationBudgetError,
} from "@/lib/salary-negotiation-llm";
import { safeChat, LLM_FEATURES } from "@/lib/safe-llm";
import { errorMessage } from "@/lib/error-message";
import { createCursorPage, parsePaginationParams } from "@/lib/cursor-pagination";
import { claimSalaryCreationRequest, completeSalaryCreationRequest, failSalaryCreationRequest, isSalaryCreationRequestId } from "@/lib/salary-creation-requests";

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
  const requestId = req.headers.get("Idempotency-Key");
  if (requestId !== null && !isSalaryCreationRequestId(requestId)) {
    return NextResponse.json({ error: "创建请求编号无效" }, { status: 400 });
  }
  const parsedBody = await parseApiJson<unknown>(req);
  if (!parsedBody.ok) return parsedBody.response;
  if (!parsedBody.data || typeof parsedBody.data !== "object" || Array.isArray(parsedBody.data)) {
    return NextResponse.json({ error: "谈薪创建请求必须是 JSON 对象" }, { status: 400 });
  }
  const body = parsedBody.data as {
    target_company_tier?: unknown;
    target_role?: unknown;
    expected_salary?: unknown;
    current_or_competing_offer?: unknown;
    hr_style?: unknown;
  };
  for (const field of ["target_company_tier", "target_role", "expected_salary", "current_or_competing_offer", "hr_style"] as const) {
    if (body[field] !== undefined && typeof body[field] !== "string") {
      return NextResponse.json({ error: "谈薪企业、岗位、期望薪资、现有筹码和 HR 风格必须是字符串" }, { status: 400 });
    }
  }

  const targetRole = typeof body?.target_role === "string" ? body.target_role.trim() : "";
  const expectedSalary = typeof body?.expected_salary === "string" ? body.expected_salary.trim() : "";
  if (!targetRole || !expectedSalary) {
    return NextResponse.json({ error: "目标岗位与期望薪资不能为空" }, { status: 400 });
  }

  const rawTier = typeof body?.target_company_tier === "string" ? body.target_company_tier.trim() : "top_tech";
  const targetCompanyTier = describeNegotiationCompany(rawTier);

  const currentOrCompeting =
    typeof body?.current_or_competing_offer === "string" ? body.current_or_competing_offer.trim() : "";

  const rawStyle = typeof body.hr_style === "string" ? body.hr_style.trim() : "standard";
  const styleMatch = HR_STYLE_OPTIONS.find((s) => s.key === rawStyle);
  if (!styleMatch) return NextResponse.json({ error: "无效的 HR 风格" }, { status: 400 });
  const hrStyle = styleMatch.key;
  const hrStyleDesc = describeNegotiationHrStyle(styleMatch);

  if (requestId) {
    const claimed = claimSalaryCreationRequest(requestId, [rawTier, targetRole, expectedSalary, currentOrCompeting, hrStyle]);
    if (claimed.status === "succeeded") return NextResponse.json({ id: claimed.id });
    if (claimed.status === "conflict") return NextResponse.json({ error: "同一创建请求编号不能用于不同背景" }, { status: 409 });
    if (claimed.status === "pending") return NextResponse.json({ error: "该创建请求仍在处理中，请按请求编号读取结果，不要重复提交" }, { status: 409 });
    if (claimed.status === "deleted") return NextResponse.json({ error: "该请求创建的演练已删除，不会重新创建" }, { status: 410 });
    if (claimed.status === "failed") return NextResponse.json({ error: "该创建请求已失败，请核对历史后显式发起新请求" }, { status: 422 });
  }

  let completed = false;
  try {
    let rawLlmOutput: string;
    try {
      const messages = buildOpeningMessages({
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
        messages,
        {
          signal: req.signal,
          requireJson: "strict"
        }
      );
    } catch (err) {
      const message = err instanceof LlmConfigError ? err.message : errorMessage(err);
      return NextResponse.json({ error: message }, { status: err instanceof NegotiationBudgetError ? 400 : 502 });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLlmOutput);
    } catch (err) {
      return NextResponse.json(
        { error: `AI 初始出招格式解析失败：${errorMessage(err)}` },
        { status: 502 }
      );
    }

    const generated = validateGeneratedNegotiationOpening(parsed);
    if (!generated) return NextResponse.json({ error: "AI 初始出招缺少必要字段，请重试" }, { status: 502 });
    const createdAt = now();

    const newId = inTransaction(() => {
      req.signal.throwIfAborted();
      const negotiationId = createSalaryNegotiation({ targetCompanyTier: rawTier, targetRole, expectedSalary,
        currentOrCompetingOffer: currentOrCompeting, hrStyle }, generated, createdAt);

      if (requestId) completeSalaryCreationRequest(requestId, negotiationId);
      return negotiationId;
    });

    completed = true;
    return NextResponse.json({ id: newId }, { status: 201 });
  } finally {
    // 已成功的回执不变；故障不会让同一编号自动重调模型。恢复世代改变时不触碰新库。
    if (requestId && !completed) failSalaryCreationRequest(requestId);
  }
}

export const GET = withRouteErrorHandling("GET /api/tools/salary-negotiations", handleGet);
export const POST = withRouteErrorHandling("POST /api/tools/salary-negotiations", handlePost);
