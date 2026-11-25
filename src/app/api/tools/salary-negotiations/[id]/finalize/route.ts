import { parseCanonicalPositiveId } from "@/lib/id-parsing";
import { withRouteErrorHandling } from "@/lib/api-route";
import { parseApiJson } from "@/lib/api-request";
import { NextResponse } from "next/server";
import { inTransaction, now, acquireCommandLock } from "@/lib/db";
import { storeSalaryReport } from "@/lib/career-tool-store";
import { LlmConfigError } from "@/lib/llm";
import {
  describeNegotiationCompany,
  validateGeneratedNegotiationReport,
} from "@/lib/salary-negotiation";
import { NegotiationHistoryError, readHistoricalReport } from "@/lib/salary-negotiation-history";
import {
  SALARY_NEGOTIATION_FINALIZE_PROMPT,
  buildFinalizeMessages,
  MAX_NEGOTIATION_MESSAGE_CHARS,
  NegotiationBudgetError,
} from "@/lib/salary-negotiation-llm";
import { safeChat, LLM_FEATURES } from "@/lib/safe-llm";
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
  if (!parsedBody.data || typeof parsedBody.data !== "object" || Array.isArray(parsedBody.data)) {
    return NextResponse.json({ error: "谈薪结束请求必须是 JSON 对象" }, { status: 400 });
  }
  const body = parsedBody.data as {
    final_words?: unknown;
    agreed_package?: unknown;
    expected_revision?: unknown;
  };
  if ((body.final_words !== undefined && typeof body.final_words !== "string") ||
    (body.agreed_package !== undefined && typeof body.agreed_package !== "string")) {
    return NextResponse.json({ error: "结束补充和最终方案必须是字符串" }, { status: 400 });
  }
  const finalWords = typeof body?.final_words === "string" ? body.final_words.trim() : "";
  const customPackage = typeof body?.agreed_package === "string" ? body.agreed_package.trim() : "";

  if (customPackage.length > MAX_NEGOTIATION_MESSAGE_CHARS) {
    return NextResponse.json({ error: `最终方案不得超过 ${MAX_NEGOTIATION_MESSAGE_CHARS} 字符` }, { status: 400 });
  }
  if (!isSalaryNegotiationRevision(body.expected_revision)) {
    return NextResponse.json({ error: "谈判记录版本无效，请重新读取" }, { status: 400 });
  }
  const release = acquireCommandLock(`salary-negotiation:${id}`);
  if (!release) return NextResponse.json({ error: "当前谈判正在处理其他操作，请稍后重试" }, { status: 409 });
  try {
    const snapshot = readSalaryNegotiationSnapshot(id);
    if (!snapshot) {
      return NextResponse.json({ error: "谈判记录不存在" }, { status: 404 });
    }
    if (snapshot.revision !== body.expected_revision) {
      return NextResponse.json({ error: "谈判资料或回合已变更，请重新读取后确认" }, { status: 409 });
    }
    const { negotiation: neg, turns } = snapshot;

    // 结束后的 POST 只读取存档；损坏或缺失报告不能借重试重新调用模型、覆盖历史。
    if (neg.status === "finished") {
      try {
        const report = readHistoricalReport(JSON.parse(neg.report), turns.map((turn) => turn.turn_no));
        if (!report) throw new NegotiationHistoryError();
        return NextResponse.json({ id, status: "finished", final_package: neg.final_package, finished_at: neg.finished_at, report,
          base_revision: snapshot.revision, revision: snapshot.revision });
      } catch (error) {
        if (error instanceof SyntaxError || error instanceof NegotiationHistoryError) {
          return NextResponse.json({ error: new NegotiationHistoryError().message }, { status: 422 });
        }
        throw error;
      }
    }

    const targetCompanyTier = describeNegotiationCompany(neg.target_company_tier);

    let rawLlmOutput: string;
    try {
      const messages = buildFinalizeMessages({
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
        agreedPackage: customPackage,
      });
      rawLlmOutput = await safeChat(
        "evaluate",
        { feature: LLM_FEATURES.negotiationFinalize, entity: { type: "negotiation", id } },
        SALARY_NEGOTIATION_FINALIZE_PROMPT,
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

    let report: ReturnType<typeof validateGeneratedNegotiationReport> = null;
    try {
      report = validateGeneratedNegotiationReport(
        JSON.parse(rawLlmOutput),
        turns.filter((turn) => turn.user_message.trim()).map((turn) => turn.turn_no),
      );
    } catch {
      // 无效 JSON 或结构不完整时由下方统一返回 502。
    }
    if (!report) {
      return NextResponse.json({ error: "生成复盘报告失败，请重试" }, { status: 502 });
    }

    const finishedAt = now();
    const finalPackageToSave = customPackage || report.final_package_summary;

    const updated = inTransaction(() => {
      req.signal.throwIfAborted();
      if (!negotiationContextMatches({ phase: "finalize", negotiation: neg, turns })) return null;
      const base = readSalaryNegotiationSnapshot(id);
      if (!base) return null;
      const written = storeSalaryReport(id, neg.status, turns.length, finalPackageToSave, report, finishedAt);
      if (written.changes === 0) return null;
      const saved = readSalaryNegotiationSnapshot(id);
      if (!saved) throw new Error("谈判复盘保存后记录不存在");
      return { base_revision: base.revision, revision: saved.revision };
    });
    if (!updated) {
      return NextResponse.json({ error: "谈判记录已变更，请刷新后重新生成复盘" }, { status: 409 });
    }

    return NextResponse.json({
      id,
      status: "finished",
      final_package: finalPackageToSave,
      finished_at: finishedAt,
      report,
      ...updated,
    });
  } finally {
    release();
  }
}

export const POST = withRouteErrorHandling("POST /api/tools/salary-negotiations/[id]/finalize", handlePost);
