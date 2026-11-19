"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { confirmDialog } from "@/components/common/confirm-dialog";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import { Loading, LoadError, SectionTitle } from "@/components/common/ui-bits";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import { parseJargonDecoderResult, type JargonDecoderResult, type DecodedItem } from "@/lib/jargon-decoder";
import {
  btnDanger,
  btnGhost,
  btnPrimary,
  cardCls,
  textErr,
  wellCls,
  badgePrimary,
  badgeAccent,
  badgeDanger,
} from "@/lib/ui";
import { errorMessage } from "@/lib/error-message";

type DecodingDetail = {
  id: number;
  source_text: string;
  result: JargonDecoderResult | null;
  created_at: string;
};

function readDecoding(value: unknown, id: string): DecodingDetail {
  if (!value || typeof value !== "object") throw new Error("报告响应不完整，请重新读取");
  const data = value as DecodingDetail;
  if (!Number.isSafeInteger(data.id) || data.id <= 0 || data.id !== Number(id) ||
    typeof data.source_text !== "string" || typeof data.created_at !== "string") {
    throw new Error("报告响应不完整或记录不符，请重新读取");
  }
  if (data.result === null) return data;
  const result = parseJargonDecoderResult(JSON.stringify(data.result));
  if (!result) throw new Error("报告响应不完整，请重新读取");
  return { ...data, result };
}

function RiskLevelBadge({ level }: { level: DecodedItem["riskLevel"] }) {
  if (level === null) {
    return <span className="text-xs text-muted">风险未评估</span>;
  }
  if (level === "high") {
    return <span className={badgeDanger}>风险信号较强</span>;
  }
  if (level === "medium") {
    return <span className={badgeAccent}>存在待核实信号</span>;
  }
  return <span className={badgePrimary}>风险信号较弱</span>;
}

function RiskMeter({ label, value, note }: { label: string; value: number | null; note: string }) {
  const color =
    value === null
      ? "bg-line"
      : value >= 7
      ? "bg-danger"
      : value >= 4
      ? "bg-accent"
      : "bg-primary";

  return (
    <div role="group" aria-label={label} className="space-y-1.5 rounded-lg border border-line bg-surface/50 p-3">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-ink">{label}</span>
        <span className="font-mono font-bold text-ink">{value === null ? "未评估" : `${value} / 10`}</span>
      </div>
      <div role={value === null ? undefined : "meter"} aria-label={label}
        aria-valuemin={value === null ? undefined : 1} aria-valuemax={value === null ? undefined : 10}
        aria-valuenow={value ?? undefined} className="h-2 w-full overflow-hidden rounded-full bg-line/60">
        <div
          className={`h-full rounded-full transition-all ${color}`}
          style={{ width: `${Math.min(100, (value ?? 0) * 10)}%` }}
        />
      </div>
      <p className="text-[11px] text-faint leading-tight">
        {value === null ? "未提供有效评分" : value >= 7 ? "风险信号较强" : value >= 4 ? "存在待核实信号" : "文本风险信号较弱"}；{note}
      </p>
    </div>
  );
}

export default function JargonDecoderDetailPage() {
  const params = useParams<{ id: string }>();
  return <DecodingReport key={params.id} decodingId={params.id} />;
}

function DecodingReport({ decodingId }: { decodingId: string }) {
  const router = useRouter();
  const [data, setData] = useState<DecodingDetail | null>(null);
  const [loadError, setLoadError] = useState("");
  const { copiedText, copy, copyError, copying } = useCopyFeedback();
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [actionError, setActionError] = useState("");
  const [phase, setPhase] = useState<"idle" | "confirming" | "deleting" | "checking" | "unknown" | "deleted">("idle");
  const active = useRef(false);
  const command = useRef(false);
  const checking = useRef(false);
  const request = useRef<AbortController | null>(null);

  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      request.current?.abort();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    jsonFetch<unknown>(`/api/tools/jargon-decodings/${decodingId}`, { signal: controller.signal, cache: "no-store" })
      .then((value) => {
        if (cancelled) return;
        setData(readDecoding(value, decodingId));
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(errorMessage(err));
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [decodingId, loadAttempt]);

  function deleted() {
    setPhase("deleted");
    router.push("/tools/decoder");
  }

  async function checkDeletion(cause: string) {
    if (!active.current || checking.current) return;
    checking.current = true;
    setPhase("checking");
    setActionError("");
    const controller = new AbortController();
    request.current = controller;
    try {
      const value = await jsonFetch<unknown>(`/api/tools/jargon-decodings/${decodingId}`, { signal: controller.signal, cache: "no-store" });
      if (!active.current) return;
      setData(readDecoding(value, decodingId));
      setActionError(`${cause}；已重新读取，记录目前仍存在，请核对后再决定是否删除。`);
      command.current = false;
      setPhase("idle");
    } catch (err) {
      if (!active.current) return;
      if (err instanceof HttpError && err.status === 404) {
        deleted();
        return;
      }
      setActionError(`删除结果尚未确认：${errorMessage(err)}。请先重新读取删除状态。`);
      setPhase("unknown");
    } finally {
      checking.current = false;
    }
  }

  async function remove() {
    if (!data || !active.current || command.current) return;
    command.current = true;
    const controller = new AbortController();
    request.current = controller;
    setPhase("confirming");
    const confirmed = await confirmDialog({ title: "删除记录", message: `暗号解码报告 #${data.id}「${data.result?.targetSummary || "未保存报告标题"}」，保存于 ${data.created_at}。将删除本份原始输入和解码报告，其他报告保留。确定删除？`, danger: true, signal: controller.signal });
    if (!active.current || controller.signal.aborted || request.current !== controller) return;
    if (!confirmed) {
      request.current = null;
      command.current = false;
      setPhase("idle");
      return;
    }
    setActionError("");
    setPhase("deleting");
    try {
      const result = await jsonFetch<{ ok?: unknown }>(`/api/tools/jargon-decodings/${decodingId}`, { method: "DELETE", signal: controller.signal });
      if (!active.current) return;
      if (!result || result.ok !== true) throw new Error("删除响应不完整");
    } catch (err) {
      if (!active.current) return;
      if (err instanceof HttpError && err.status === 404) {
        deleted();
      } else if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 408) {
        setActionError(errorMessage(err));
        command.current = false;
        setPhase("idle");
      } else {
        await checkDeletion(errorMessage(err));
      }
      return;
    }
    deleted();
  }

  if (loadError && !data) return <LoadError message={loadError} onRetry={() => { setLoadError(""); setLoadAttempt((attempt) => attempt + 1); }} />;
  if (!data) return <Loading />;

  const result = data.result;

  return (
    <div className="mx-auto min-w-0 max-w-5xl space-y-8 [overflow-wrap:anywhere]">
      {actionError && <p role="alert" className="text-sm text-danger">{actionError}</p>}
      {phase === "unknown" && <button type="button" className={btnPrimary} onClick={() => { void checkDeletion("上次删除响应异常"); }}>重新读取删除状态</button>}
      {(phase === "checking" || phase === "deleting" || phase === "deleted") && <p role="status" className="text-sm text-muted">{phase === "checking" ? "正在核对删除状态…" : phase === "deleted" ? "记录已不存在，正在返回列表…" : "正在删除报告…"}</p>}
      {/* 头部导航与操作栏 */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line pb-5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Link
              href="/tools/decoder"
              className="text-xs text-primary hover:underline flex items-center gap-1 font-medium"
            >
              ← 返回解码器列表
            </Link>
            <span className="text-xs text-faint">/</span>
            <span className="text-xs text-muted font-mono">报告 #{data.id}</span>
          </div>
          <h1 className="mt-1 font-serif text-2xl sm:text-3xl font-bold text-ink flex flex-wrap items-center gap-2">
            <span>{result?.targetSummary || "面试黑话与暗号解码报告"}</span>
            <span className="rounded-full border border-primary/25 bg-primary-soft px-3 py-0.5 text-xs font-mono font-medium text-primary">
              文本线索分析
            </span>
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs text-faint">
          <span>{new Date(data.created_at).toLocaleString()}</span>
          <button
            type="button"
            onClick={remove}
            disabled={phase !== "idle" && phase !== "confirming"}
            className="text-danger hover:underline ml-2 disabled:opacity-50"
          >
            删除报告
          </button>
        </div>
      </div>

      {/* 原始输入折叠展开 */}
      <details className="group">
        <summary className="cursor-pointer text-xs text-muted transition-colors hover:text-ink flex items-center gap-1">
          <span className="group-open:rotate-90 transition-transform text-faint">▶</span>
          <span>查看原始 JD / 输入文本</span>
        </summary>
        <div role="region" aria-label="原始输入文本" className={`mt-2 max-h-56 overflow-y-auto whitespace-pre-wrap font-mono text-xs text-muted ${wellCls}`}>
          {data.source_text}
        </div>
      </details>

      {result === null ? (
        <div className={`p-6 text-center ${cardCls}`}>
          <p className={`text-sm ${textErr}`}>该报告内容无法解析，原始输入与记录仍已保留。可返回重试，或展开原始文本核对内容。</p>
          <div className="mt-4">
            <Link href="/tools/decoder" className={btnGhost}>
              返回重试
            </Link>
          </div>
        </div>
      ) : (
        <div className="space-y-8">
          {/* 综合神总结与风险看板 */}
          <div className={`p-5 sm:p-6 space-y-5 border-l-4 border-primary ${cardCls}`}>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-line/70 pb-4">
              <div className="space-y-1">
                <div className="text-xs font-semibold text-primary uppercase tracking-wider">
                  🔎 重点核实方向
                </div>
                <p className="font-serif text-lg sm:text-xl font-bold text-ink leading-relaxed">
                  “{result.punchline}”
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-3 bg-surface rounded-xl border border-line p-3">
                <div className="text-right">
                  <div className="text-[11px] text-faint">文本风险信号分</div>
                  <div className="text-xs font-medium text-muted">
                    {result.overallRiskScore === null
                      ? "未评估"
                      : result.overallRiskScore >= 75
                      ? "信号较强"
                      : result.overallRiskScore >= 50
                      ? "待核实"
                      : "信号较弱"}
                  </div>
                </div>
                <div
                  className={`flex h-12 w-12 items-center justify-center rounded-lg font-mono text-xl font-extrabold ${
                    result.overallRiskScore === null
                      ? "bg-line text-muted"
                      : result.overallRiskScore >= 75
                      ? "bg-danger text-on-danger"
                      : result.overallRiskScore >= 50
                      ? "bg-accent text-bg"
                      : "bg-primary text-on-primary"
                  }`}
                >
                  {result.overallRiskScore ?? "—"}
                </div>
              </div>
            </div>

            {/* 4 维度风险小仪表 */}
            <div>
              <div className="text-xs font-medium text-muted mb-2.5">
                📊 四维文本风险信号（分数不代表实际风险概率，低分不等于已确认安全）
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                <RiskMeter
                  label="加班过劳指数"
                  value={result.riskRatings.overtime}
                  note="核实实际工时、值班频率与补偿安排"
                />
                <RiskMeter
                  label="业务动荡指数"
                  value={result.riskRatings.stability}
                  note="核实近期方向调整、排期与考核变化"
                />
                <RiskMeter
                  label="资源匮乏指数"
                  value={result.riskRatings.resources}
                  note="核实人员、工具与跨团队支持"
                />
                <RiskMeter
                  label="管理内耗指数"
                  value={result.riskRatings.management}
                  note="核实职责、决策与冲突处理机制"
                />
              </div>
            </div>
          </div>

          {/* 公司与团队风格诊断 */}
          <section className="space-y-3">
            <SectionTitle>🏢 文本中的团队线索</SectionTitle>
            <div className={`p-5 space-y-3.5 ${cardCls}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-bold text-ink">风格线索：</span>
                <span className="text-sm font-medium text-primary bg-primary-soft border border-primary/20 rounded-md px-2.5 py-0.5">
                  {result.companyProfile.teamStyle}
                </span>
              </div>

              {result.companyProfile.riskFlags.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <span className="text-xs text-muted">待核实标签：</span>
                  {result.companyProfile.riskFlags.map((flag, i) => (
                    <span
                      key={i}
                      className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-2 py-0.5 text-xs text-ink"
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-danger" />
                      {flag}
                    </span>
                  ))}
                </div>
              )}

              <p className="text-xs text-muted leading-relaxed border-t border-line/60 pt-3">
                {result.companyProfile.cultureSummary}
              </p>
            </div>
          </section>

          {/* 暗号逐条深度穿透 */}
          <section className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <SectionTitle>🕵️ 逐条解释与沟通建议</SectionTitle>
              <span className="text-xs text-faint">
                识别出 {result.items.length} 个文本线索
              </span>
            </div>

            <div className="space-y-4">
              {result.items.map((item, idx) => (
                <div
                  key={idx}
                  className={`p-5 space-y-4 transition-all hover:shadow-card-float ${cardCls}`}
                >
                  {/* 条目标题与分类标签 */}
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/70 pb-3">
                    <div className="flex min-w-0 flex-wrap items-center gap-2.5">
                      <span className="font-serif text-base font-bold text-ink">
                        #{idx + 1} {item.keyword}
                      </span>
                      <span className="text-xs text-muted">[{item.riskCategory}]</span>
                    </div>
                    <RiskLevelBadge level={item.riskLevel} />
                  </div>

                  {/* 字面含义与可能解释分别展示，不把推测提升为已知事实 */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                    <div className="rounded-lg border border-line bg-surface/70 p-3 space-y-1">
                      <div className="font-semibold text-muted flex items-center gap-1.5">
                        <span>📢 字面含义</span>
                      </div>
                      <p className="text-ink leading-relaxed">{item.surfaceMeaning}</p>
                    </div>

                    <div className="rounded-lg border border-danger/25 bg-danger-wash p-3 space-y-1">
                      <div className="font-semibold text-danger flex items-center gap-1.5">
                        <span>💡 可能解释与待核实条件</span>
                      </div>
                      <p className="text-ink font-medium leading-relaxed">
                        {item.hiddenMeaning}
                      </p>
                    </div>
                  </div>

                  {/* 踩坑场景警示 */}
                  {item.warning && (
                    <div className="text-xs bg-surface-2 rounded-lg p-3 text-muted flex items-start gap-2 border border-line/60">
                      <span className="text-accent shrink-0">⚠️ 条件成立时的影响：</span>
                      <span className="leading-relaxed">{item.warning}</span>
                    </div>
                  )}

                  {/* 面试应对潜规则 */}
                  <div className="rounded-lg border border-line bg-card p-3.5 space-y-1.5 text-xs">
                    <div className="font-semibold text-ink flex items-center gap-1.5">
                      <span>🛡️ 沟通建议</span>
                      <span className="text-faint font-normal">
                        （如实表达诉求与边界）
                      </span>
                    </div>
                    <p className="text-muted leading-relaxed font-sans">
                      {item.interviewRule}
                    </p>
                  </div>

                  {/* 反客为主的反向提问 */}
                  {item.counterQuestions.length > 0 && (
                    <div className="rounded-lg border border-primary/20 bg-primary-soft/40 p-3.5 space-y-2 text-xs">
                      <div className="font-semibold text-primary flex items-center gap-1.5">
                        <span>🔎 核实问题</span>
                        <span className="text-faint font-normal">
                          （询问具体条件与实例）
                        </span>
                      </div>
                      <ul className="space-y-1.5">
                        {item.counterQuestions.map((q, qIdx) => (
                          <li
                            key={qIdx}
                            className="flex flex-wrap items-start justify-between gap-3 text-ink bg-card/80 border border-line/60 rounded p-2"
                          >
                            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words leading-relaxed">👉 {q}</span>
                            <button
                              type="button"
                              onClick={() => void copy(q)}
                              disabled={copying}
                              className="shrink-0 text-primary hover:underline font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {copiedText === q ? "已复制 ✓" : "复制"}
                            </button>
                            {copyError?.text === q && <p role="alert" className="basis-full text-danger">{copyError.message}</p>}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>

          {/* 王牌反向提问避坑锦囊（汇总精选） */}
          {result.goldenQuestions.length > 0 && (
            <section className="space-y-3">
              <SectionTitle>📋 优先核实的问题</SectionTitle>
              <div className={`p-5 space-y-3 border-2 border-primary/40 ${cardCls}`}>
                <p className="text-xs text-muted leading-relaxed">
                  在面试尾声面试官问“你还有什么想问我的吗？”时，挑出 1-2
                  个与你最相关的问题，核实具体条件、近期实例和适用范围；回答仍需结合书面约定与其他信息判断：
                </p>

                <div className="space-y-2.5 pt-1">
                  {result.goldenQuestions.map((gq, i) => (
                    <div
                      key={i}
                      className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-line bg-surface p-3 text-xs text-ink transition-colors hover:border-primary/50"
                    >
                      <div className="min-w-0 flex-1 flex items-start gap-2 whitespace-pre-wrap break-words leading-relaxed">
                        <span className="font-mono font-bold text-primary shrink-0">
                          Q{i + 1}.
                        </span>
                        <span>{gq}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => void copy(gq)}
                        disabled={copying}
                        className="shrink-0 text-primary hover:underline font-medium whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {copiedText === gq ? "已复制 ✓" : "复制提问"}
                      </button>
                      {copyError?.text === gq && <p role="alert" className="basis-full text-danger">{copyError.message}</p>}
                    </div>
                  ))}
                </div>
              </div>
            </section>
          )}

          {/* 底部按钮栏 */}
          <div className="flex flex-wrap items-center justify-between gap-3 pt-4 border-t border-line">
            <Link href="/tools/decoder" className={btnGhost}>
              ← 返回解码器首页
            </Link>
            <button type="button" onClick={remove} disabled={phase !== "idle" && phase !== "confirming"} className={`${btnDanger} disabled:opacity-50`}>
              删除本份报告
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
