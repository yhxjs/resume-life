"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Empty, Loading, LoadError, SectionTitle, StatTile } from "@/components/common/ui-bits";
import { jsonFetch } from "@/lib/fetcher";
import { errorMessage } from "@/lib/error-message";
import { LLM_FEATURES, type EntityType, type LlmFeature } from "@/lib/llm-source";
import { resolveUsageRange, type UsageRangePreset } from "@/lib/llm-usage-range";
import type { LlmDailyUsage, LlmFeatureUsage, LlmModelUsage } from "@/lib/llm-call-log";
import { btnGhost, cardCls, inputCls } from "@/lib/ui";
import { LlmDailyTrendChart, LlmDistributionChart } from "./llm-usage-charts";

type Summary = {
  calls: number; failed: number; cancelled: number; retries: number;
  inputTokens: number; outputTokens: number; cachedTokens: number;
  usageReportedCalls: number; cacheReportedCalls: number;
  daily: LlmDailyUsage[];
  byFeature: LlmFeatureUsage[];
  byModel: LlmModelUsage[];
};

type LogRow = {
  id: number; createdAt: string; feature: string;
  entityType: string; entityId: number | null; entityLabel: string;
  model: string; status: "ok" | "failed" | "cancelled"; errorCode: string;
  attempts: number; durationMs: number;
  inputTokens: number | null; outputTokens: number | null; cachedTokens: number | null;
};

type LogPage = { items: LogRow[]; nextCursor: string | null };

const PRESETS: { key: UsageRangePreset; label: string }[] = [
  { key: "month", label: "本月" },
  { key: "7d", label: "近 7 天" },
  { key: "30d", label: "近 30 天" },
  { key: "all", label: "全部" },
];

const ENTITY_LABELS: Record<EntityType, string> = {
  resume: "简历", interview: "面试", interview_series: "连打", project: "项目",
  intro: "自我介绍", drill: "练习", bank_entry: "题库", defense: "排雷",
  negotiation: "谈判", jd_portrait: "JD 画像", jargon_decoding: "黑话解码",
  gap_remedy: "空窗期", template: "模板",
};

function formatTokens(value: number | null): string {
  return value === null ? "—" : value.toLocaleString("zh-CN");
}

function entityText(row: LogRow): string {
  if (row.entityId === null) return "—";
  // 日志行的 entityType 来自 API 的 string；单次窄化以索引类型化映射，未知类型回退原始字符串。
  const prefix = ENTITY_LABELS[row.entityType as EntityType] ?? row.entityType;
  return row.entityLabel ? `${prefix} #${row.entityId} ${row.entityLabel}` : `${prefix} #${row.entityId}`;
}

function localTime(iso: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function LlmUsagePanel() {
  const [preset, setPreset] = useState<UsageRangePreset>("month");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [feature, setFeature] = useState<LlmFeature | "">("");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [rows, setRows] = useState<LogRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 请求代次：query 变化时自增，用于丢弃「加载更多」的旧范围响应 */
  const generationRef = useRef(0);
  const [loadAttempt, setLoadAttempt] = useState(0);

  const query = useCallback((): string => {
    const range = resolveUsageRange(
      preset,
      new Date(),
      preset === "custom" ? { from: customFrom, to: customTo } : undefined
    );
    const params = new URLSearchParams();
    params.set("timeZone", Intl.DateTimeFormat().resolvedOptions().timeZone);
    if (range.from) params.set("from", range.from);
    if (range.to) params.set("to", range.to);
    if (feature) params.set("feature", feature);
    return params.toString();
  }, [preset, customFrom, customTo, feature]);

  useEffect(() => {
    let cancelled = false;
    generationRef.current += 1;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const base = query();
        const [nextSummary, page] = await Promise.all([
          jsonFetch<Summary>(`/api/settings/llm-usage${base ? `?${base}` : ""}`),
          jsonFetch<LogPage>(`/api/settings/llm-logs${base ? `?${base}&` : "?"}limit=20`),
        ]);
        if (cancelled) return;
        setSummary(nextSummary);
        setRows(page.items);
        setNextCursor(page.nextCursor);
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [query, loadAttempt]);

  async function loadMore() {
    if (!nextCursor) return;
    const generation = generationRef.current;
    setLoadingMore(true);
    try {
      const base = query();
      const page = await jsonFetch<LogPage>(
        `/api/settings/llm-logs${base ? `?${base}&` : "?"}limit=20&cursor=${nextCursor}`
      );
      // query 已变（新范围的第 1 页已落地）：丢弃旧范围的追加与游标
      if (generation !== generationRef.current) return;
      setRows((prev) => [...prev, ...page.items]);
      setNextCursor(page.nextCursor);
    } catch (err) {
      if (generation !== generationRef.current) return;
      setError(errorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  }

  const cacheRate =
    summary && summary.cacheReportedCalls > 0 && summary.inputTokens > 0
      ? `${((summary.cachedTokens / summary.inputTokens) * 100).toFixed(1)}%`
      : "—";
  const cacheHint = summary
    ? summary.cacheReportedCalls > 0
      ? `${summary.cacheReportedCalls} 次上报`
      : "上游未返回缓存数据"
    : undefined;
  const retryHint = summary && summary.retries > 0 ? ` · 重试 ${summary.retries} 次` : "";

  return (
    <div className="space-y-6">
      <div className={`${cardCls} p-4 space-y-3`}>
        <div className="flex flex-wrap items-center gap-2">
          {PRESETS.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setPreset(item.key)}
              aria-pressed={preset === item.key}
              className={`rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors ${
                preset === item.key
                  ? "border-primary bg-primary-soft text-primary"
                  : "border-line bg-card text-muted hover:bg-surface"
              }`}
            >
              {item.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setPreset("custom")}
            aria-pressed={preset === "custom"}
            className={`rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors ${
              preset === "custom"
                ? "border-primary bg-primary-soft text-primary"
                : "border-line bg-card text-muted hover:bg-surface"
            }`}
          >
            自定义
          </button>
        </div>

        {preset === "custom" && (
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-40">
              <input
                type="date"
                aria-label="起始日期"
                className={inputCls}
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
              />
            </div>
            <span className="text-xs text-muted">至</span>
            <div className="w-40">
              <input
                type="date"
                aria-label="结束日期"
                className={inputCls}
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
              />
            </div>
          </div>
        )}

        <label className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-muted">来源筛选</span>
          <div className="w-40">
            <select
              className={inputCls}
              value={feature}
              onChange={(e) => setFeature(e.target.value as LlmFeature | "")}
            >
              <option value="">全部来源</option>
              {Object.entries(LLM_FEATURES).map(([key, label]) => (
                <option key={key} value={label}>{label}</option>
              ))}
            </select>
          </div>
        </label>
      </div>

      {error && (
        <LoadError message={error} onRetry={() => { setError(null); setLoading(true); setLoadAttempt((attempt) => attempt + 1); }} />
      )}

      {loading ? (
        <Loading />
      ) : summary === null ? null : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              label="调用次数"
              value={(summary?.calls ?? 0).toLocaleString("zh-CN")}
              hint={
                summary && (summary.failed > 0 || summary.cancelled > 0)
                  ? `失败 ${summary.failed + summary.cancelled}（中断 ${summary.cancelled}）${retryHint}`
                  : `全部成功${retryHint}`
              }
              highlight
            />
            <StatTile
              label="输入 tokens"
              value={formatTokens(summary?.usageReportedCalls ? summary.inputTokens : null)}
              hint={
                summary && summary.usageReportedCalls < summary.calls
                  ? `${summary.usageReportedCalls} 次上报，${summary.calls - summary.usageReportedCalls} 次未上报`
                  : `${summary?.usageReportedCalls ?? 0} 次上报`
              }
            />
            <StatTile
              label="输出 tokens"
              value={formatTokens(summary?.usageReportedCalls ? summary.outputTokens : null)}
              hint={`${summary?.usageReportedCalls ?? 0} 次上报`}
            />
            <StatTile label="缓存命中率" value={cacheRate} hint={cacheHint} />
          </div>

          <div className="grid gap-6 lg:grid-cols-12">
            <div className="lg:col-span-7 xl:col-span-8">
              <LlmDailyTrendChart daily={summary.daily ?? []} />
            </div>
            <div className="lg:col-span-5 xl:col-span-4">
              <LlmDistributionChart
                byFeature={summary.byFeature ?? []}
                byModel={summary.byModel ?? []}
              />
            </div>
          </div>

          <div className={`${cardCls} p-4`}>
            <SectionTitle right={<span className="text-xs text-faint">已加载 {rows.length} 条</span>}>
              调用日志
            </SectionTitle>
            {rows.length === 0 ? (
              <Empty>该时间范围内没有调用记录</Empty>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-line text-left text-muted">
                      <th className="py-2 pr-3 font-medium">时间</th>
                      <th className="py-2 pr-3 font-medium">来源</th>
                      <th className="py-2 pr-3 font-medium">对象</th>
                      <th className="py-2 pr-3 font-medium">模型</th>
                      <th className="py-2 pr-3 font-medium">状态</th>
                      <th className="py-2 pr-3 text-right font-medium">输入</th>
                      <th className="py-2 pr-3 text-right font-medium">输出</th>
                      <th className="py-2 pr-3 text-right font-medium">缓存</th>
                      <th className="py-2 text-right font-medium">耗时</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {rows.map((row) => (
                      <tr key={row.id} className="hover:bg-surface">
                        <td className="py-2 pr-3 font-mono tabular-nums text-faint">{localTime(row.createdAt)}</td>
                        <td className="py-2 pr-3 text-ink">{row.feature}</td>
                        <td className="py-2 pr-3 text-muted">{entityText(row)}</td>
                        <td className="py-2 pr-3 font-mono text-faint">{row.model}</td>
                        <td className="py-2 pr-3">
                          <span className={row.status === "ok" ? "text-primary" : "text-danger"}>
                            {row.status === "ok" ? "成功" : row.status === "cancelled" ? "已中断" : "失败"}
                          </span>
                          {row.attempts > 0 && <span className="ml-1 text-faint">·重试 {row.attempts}</span>}
                        </td>
                        <td className="py-2 pr-3 text-right font-mono tabular-nums">{formatTokens(row.inputTokens)}</td>
                        <td className="py-2 pr-3 text-right font-mono tabular-nums">{formatTokens(row.outputTokens)}</td>
                        <td className="py-2 pr-3 text-right font-mono tabular-nums">{formatTokens(row.cachedTokens)}</td>
                        <td className="py-2 text-right font-mono tabular-nums text-faint">{row.durationMs} ms</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {nextCursor && (
              <div className="mt-4 flex justify-center">
                <button className={btnGhost} onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? "加载中…" : "加载更多"}
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
