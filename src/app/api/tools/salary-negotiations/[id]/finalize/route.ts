import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import { getDb, inTransaction, now, acquireCommandLock } from "@/lib/db";
import { extractJson, LlmConfigError } from "@/lib/llm";
import {
  COMPANY_TIER_OPTIONS,
  validateGeneratedNegotiationReport,
  type NegotiationReport,
} from "@/lib/salary-negotiation";
import {
  SALARY_NEGOTIATION_FINALIZE_PROMPT,
  buildFinalizeUserPrompt,
  MAX_NEGOTIATION_MESSAGE_CHARS,
  NegotiationBudgetError,
} from "@/lib/salary-negotiation-llm";
import { safeChat, LLM_FEATURES } from "@/lib/safe-llm";
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
  const body = parsedBody.data as {
    final_words?: unknown;
    agreed_package?: unknown;
  };
  const finalWords = typeof body?.final_words === "string" ? body.final_words.trim() : "";
  const customPackage = typeof body?.agreed_package === "string" ? body.agreed_package.trim() : "";

  if (customPackage.length > MAX_NEGOTIATION_MESSAGE_CHARS) {
    return NextResponse.json({ error: `最终方案不得超过 ${MAX_NEGOTIATION_MESSAGE_CHARS} 字符` }, { status: 400 });
  }
  const release = acquireCommandLock(`salary-negotiation:${id}`);
  if (!release) return NextResponse.json({ error: "当前谈判正在处理其他操作，请稍后重试" }, { status: 409 });
  try {
    const db = getDb();
    const neg = db
      .prepare(
        `SELECT
           id,
           target_company_tier,
           target_role,
           expected_salary,
           current_or_competing_offer,
           hr_style,
           status,
           initial_offer,
           final_package,
           report
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
          initial_offer: string;
          final_package: string;
          report: string;
        }
      | undefined;

    if (!neg) {
      return NextResponse.json({ error: "谈判记录不存在" }, { status: 404 });
    }

    // 如果已经结束并已有报告，且无重新生成诉求，直接返回
    if (neg.status === "finished" && neg.report) {
      let cachedReport: NegotiationReport | null = null;
      try {
        cachedReport = JSON.parse(neg.report);
      } catch {
        // 容错
      }
      if (cachedReport) {
        return NextResponse.json({
          status: "finished",
          final_package: neg.final_package,
          report: cachedReport,
        });
      }
    }

    const turns = db
      .prepare(
        `SELECT turn_no, user_message, hr_response, hr_mindset, mentor_analysis
         FROM salary_negotiation_turns
         WHERE negotiation_id = ?
         ORDER BY turn_no ASC`
      )
      .all(id) as {
      turn_no: number;
      user_message: string;
      hr_response: string;
      hr_mindset: string;
      mentor_analysis: string;
    }[];

    const tierMatch = COMPANY_TIER_OPTIONS.find((t) => t.key === neg.target_company_tier);
    const targetCompanyTier = tierMatch ? `${tierMatch.label}（${tierMatch.desc}）` : neg.target_company_tier;

    let rawLlmOutput: string;
    try {
      const finalizePrompt = buildFinalizeUserPrompt({
        targetCompanyTier,
        targetRole: neg.target_role,
        expectedSalary: neg.expected_salary,
        currentOrCompetingOffer: neg.current_or_competing_offer,
        initialOffer: neg.initial_offer,
        turns: turns.map((t) => ({
          turn_no: t.turn_no,
          user_message: t.user_message,
          hr_response: t.hr_response,
          hr_mindset_str: t.hr_mindset,
          mentor_analysis_str: t.mentor_analysis,
        })),
        finalWords,
      });
      rawLlmOutput = await safeChat(
        "evaluate",
        { feature: LLM_FEATURES.negotiationFinalize, entity: { type: "negotiation", id } },
        SALARY_NEGOTIATION_FINALIZE_PROMPT,
        [
        {
          role: "user",
          parts: [
            { trust: "untrusted", tag: "negotiation_transcript", text: finalizePrompt },
            { trust: "trusted", text: "\n请全面复盘整场博弈，输出深度的终局复盘报告。" },
          ],
        },
        ],
        { signal: req.signal, requireJson: true }
      );
    } catch (err) {
      const message = err instanceof LlmConfigError ? err.message : errorMessage(err);
      return NextResponse.json({ error: message }, { status: err instanceof NegotiationBudgetError ? 400 : 502 });
    }

    let report: ReturnType<typeof validateGeneratedNegotiationReport> = null;
    try {
      report = validateGeneratedNegotiationReport(extractJson<unknown>(rawLlmOutput));
    } catch {
      // 无效 JSON 或结构不完整时由下方统一返回 502。
    }
    if (!report) {
      return NextResponse.json({ error: "生成复盘报告失败，请重试" }, { status: 502 });
    }

    const finishedAt = now();
    const finalPackageToSave = customPackage || report.final_package_summary;

    const updated = inTransaction(() => db.prepare(
      `UPDATE salary_negotiations
       SET status = 'finished',
           final_package = ?,
           report = ?,
           finished_at = ?
       WHERE id = ? AND status = ?
         AND (SELECT COUNT(*) FROM salary_negotiation_turns WHERE negotiation_id = ?) = ?`
    ).run(finalPackageToSave, JSON.stringify(report), finishedAt, id, neg.status, id, turns.length));
    if (updated.changes === 0) {
      return NextResponse.json({ error: "谈判记录已变更，请刷新后重新生成复盘" }, { status: 409 });
    }

    return NextResponse.json({
      status: "finished",
      final_package: finalPackageToSave,
      report,
    });
  } finally {
    release();
  }
}

export const POST = withRouteErrorHandling("POST /api/tools/salary-negotiations/[id]/finalize", handlePost);
