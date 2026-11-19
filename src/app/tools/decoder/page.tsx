"use client";

import { useId, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ToolHistoryDeletionFeedback } from "@/components/common/tool-history-deletion-feedback";
import { useToolHistoryDeletion } from "@/hooks/use-tool-history-deletion";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import { jsonFetch } from "@/lib/fetcher";
import { Loading, LoadError } from "@/components/common/ui-bits";
import { LoadingOverlay } from "@/components/common/loading-overlay";
import {
  PRESET_JARGONS,
  parseJargonDecoderResult,
  type DecodedItem,
} from "@/lib/jargon-decoder";
import {
  btnDanger,
  btnGhost,
  btnPrimary,
  cardCls,
  textareaTallCls,
  labelCls,
  textErr,
  wellCls,
  badgePrimary,
  badgeAccent,
  badgeDanger,
} from "@/lib/ui";
import { errorMessage } from "@/lib/error-message";
import { useCursorList } from "@/hooks/use-cursor-list";

type DecodingRecord = {
  id: number;
  source_text: string;
  result: string;
  created_at: string;
};

const SAMPLE_JD = `【高薪急聘】高级全栈业务开发工程师（核心业务线）
【岗位职责】
1. 深入理解业务，具备大局观，能够独立负责业务闭环，端到端交付高价值产出；
2. 拥抱变化，适应初创业务的敏捷节奏与快速试错迭代，快速响应市场挑战；
3. 负责核心系统架构设计，具备从 0 到 1 架构搭建经验，能快速搭起高可用中台。

【任职要求】
1. 本科及以上学历，3-5年互联网研发经验，技术栈不限但要求学习能力极强；
2. 抗压能力强，有强烈的自驱力与主人翁精神，在快节奏与紧急攻坚中保持战斗力；
3. 扁平化管理风格，良好的跨团队协同意识与沟通能力；
4. 弹性工作制，团队氛围好，大家像一家人，待遇从优，薪资面议空间巨大上不封顶。`;

function getRecordTitle(r: DecodingRecord): string {
  const parsed = parseJargonDecoderResult(r.result);
  if (parsed?.targetSummary) return parsed.targetSummary;
  const first = r.source_text.split("\n").find((l) => l.trim()) ?? "";
  return first.slice(0, 45) || "（无标题文本）";
}

function getRiskBadge(score: number | null) {
  if (score === null) return <span className="text-xs text-muted">风险未评估</span>;
  if (score >= 75) {
    return <span className={badgeDanger}>文本风险信号较强 ({score}分)</span>;
  }
  if (score >= 50) {
    return <span className={badgeAccent}>存在待核实信号 ({score}分)</span>;
  }
  return <span className={badgePrimary}>文本风险信号较弱 ({score}分)</span>;
}

export default function JargonDecoderPage() {
  const router = useRouter();
  const sourceId = useId();
  const { items: records, total, nextCursor, loadingMore, listError: loadError, failedCursor, loadMore, reload } = useCursorList<DecodingRecord>({
    queryKey: "jargon-decodings",
    buildUrl: (cursor) => `/api/tools/jargon-decodings?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    delay: 0,
  });
  const [text, setText] = useState("");
  const deletion = useToolHistoryDeletion("jargon-decodings", reload);
  const visibleRecords = records?.filter((record) => !deletion.deletedIds.has(record.id)) ?? null;
  const [decoding, setDecoding] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(false);
  const generation = useRef<AbortController | null>(null);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current?.abort(); generation.current = null; };
  }, []);

  // 经典暗号速查弹窗/抽屉状态
  const [inspectPreset, setInspectPreset] = useState<DecodedItem | null>(null);
  const { copiedText: copiedQuestion, copy, copyError, copying } = useCopyFeedback();

  async function handleDecode() {
    if (!mounted.current || generation.current || !text.trim()) return;
    const controller = new AbortController();
    generation.current = controller;
    const isCurrent = () => mounted.current && generation.current === controller && !controller.signal.aborted;
    setDecoding(true);
    setError("");
    try {
      const data = await jsonFetch<unknown>("/api/tools/jargon-decodings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.trim() }),
        signal: controller.signal,
      });
      if (!isCurrent()) return;
      const id = data && typeof data === "object" ? (data as { id?: unknown }).id : undefined;
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw new Error("生成响应不完整，请先核对历史记录是否已保存");
      router.push(`/tools/decoder/${id}`);
    } catch (err) {
      if (!isCurrent()) return;
      generation.current = null;
      setError(errorMessage(err));
      setDecoding(false);
      reload();
    }
  }

  return (
    <div className="mx-auto min-w-0 max-w-6xl space-y-8 [overflow-wrap:anywhere]">
      {/* 顶部标题栏 */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div>
          <h1 className="font-serif text-[28px] sm:text-[32px] font-bold text-ink leading-tight">
            面试黑话与暗号解码器
          </h1>
          <p className="mt-1 max-w-prose text-sm text-muted leading-relaxed">
            仅依据输入原文整理含糊表述、可能解释和核实问题；文本风险信号分不代表实际风险概率，低分不等于已确认安全。
          </p>
        </div>
        {records !== null && (
          <div className="flex items-center gap-2 text-xs text-muted">
            <span>已载入解码存档：<strong className="font-mono text-ink font-bold text-sm">{visibleRecords?.length}</strong> 份{total !== null && ` / 共 ${total} 份`}</span>
          </div>
        )}
      </div>

      {/* 经典高频黑话秒查卡片区 */}
      <div className={`p-5 space-y-4 ${cardCls}`}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/70 pb-3">
          <div>
            <h2 className="text-sm font-bold text-ink flex flex-wrap items-center gap-2">
              <span>🔍 经典高频暗号速览</span>
              <span className="text-xs font-normal text-muted">
                （通用释义与提问示例，不代表具体公司的实际情况）
              </span>
            </h2>
          </div>
          <button
            type="button"
            onClick={() => setText(SAMPLE_JD)}
            disabled={decoding}
            className="text-xs text-primary font-medium hover:underline"
          >
            填入经典黑话 JD 示例 ↗
          </button>
        </div>

        <div className="flex flex-wrap gap-2.5">
          {PRESET_JARGONS.map((p) => {
            const isHigh = p.riskLevel === "high";
            const isMedium = p.riskLevel === "medium";
            return (
              <button
                key={p.keyword}
                type="button"
                onClick={() => setInspectPreset(p)}
                className={`group flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition-all ${
                  inspectPreset?.keyword === p.keyword
                    ? "border-primary bg-primary-soft text-primary font-semibold shadow-sm"
                    : "border-line bg-surface hover:border-primary/50 text-ink hover:text-primary"
                }`}
              >
                <span>{p.keyword}</span>
                <span
                  className={`inline-block h-1.5 w-1.5 rounded-full ${
                    p.riskLevel === null ? "bg-line" : isHigh ? "bg-danger" : isMedium ? "bg-accent" : "bg-primary"
                  }`}
                />
              </button>
            );
          })}
        </div>

        {/* 经典暗号展开预览卡片 */}
        {inspectPreset && (
          <div className={`mt-4 space-y-3.5 border-l-4 border-primary p-4 ${wellCls}`}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5">
                <span className="min-w-0 break-words text-base font-bold text-ink">{inspectPreset.keyword}</span>
                <span className="text-xs font-medium text-muted">[{inspectPreset.riskCategory}]</span>
                <span
                  className={
                    inspectPreset.riskLevel === null
                      ? "text-xs text-muted"
                      : inspectPreset.riskLevel === "high"
                      ? badgeDanger
                      : inspectPreset.riskLevel === "medium"
                      ? badgeAccent
                      : badgePrimary
                  }
                >
                  {inspectPreset.riskLevel === null
                    ? "通用示例 · 未评估"
                    : inspectPreset.riskLevel === "high"
                    ? "信号较强"
                    : inspectPreset.riskLevel === "medium"
                    ? "待核实"
                    : "信号较弱"}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-3 self-end sm:self-start">
                <button
                  type="button"
                  onClick={() => {
                    setText((prev) => (prev ? `${prev}\n${inspectPreset.keyword}` : inspectPreset.keyword));
                  }}
                  disabled={decoding}
                  className="whitespace-nowrap text-xs text-primary hover:underline font-medium"
                >
                  + 加到输入框
                </button>
                <button
                  type="button"
                  onClick={() => setInspectPreset(null)}
                  className="whitespace-nowrap text-xs text-faint hover:text-ink"
                >
                  收起 ✕
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
              <div className="rounded-md border border-line bg-card p-3 space-y-1">
                <div className="font-semibold text-muted">📢 字面含义</div>
                <div className="text-ink leading-relaxed">{inspectPreset.surfaceMeaning}</div>
              </div>
              <div className="rounded-md border border-danger/20 bg-danger-wash p-3 space-y-1">
                <div className="font-semibold text-danger">💡 可能解释与待核实条件</div>
                <div className="text-ink leading-relaxed font-medium">{inspectPreset.hiddenMeaning}</div>
              </div>
            </div>

            <div className="rounded-md border border-line bg-card p-3 space-y-1.5 text-xs">
              <div className="font-semibold text-ink flex items-center gap-1.5">
                <span>🛡️ 沟通建议</span>
                <span className="text-faint font-normal">（如实表达诉求与边界）</span>
              </div>
              <p className="text-muted leading-relaxed">{inspectPreset.interviewRule}</p>
            </div>

            <div className="rounded-md border border-line bg-card p-3 space-y-2 text-xs">
              <div className="font-semibold text-ink">🔎 可直接使用的核实问题</div>
              <ul className="space-y-1.5">
                {inspectPreset.counterQuestions.map((q, idx) => (
                  <li key={idx} className="flex flex-wrap items-start justify-between gap-3 text-muted">
                    <span className="min-w-0 flex-1 whitespace-pre-wrap break-words leading-relaxed">👉 {q}</span>
                    <button
                      type="button"
                      onClick={() => void copy(q)}
                      disabled={copying}
                      className="shrink-0 text-primary hover:underline font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {copiedQuestion === q ? "已复制 ✓" : "复制"}
                    </button>
                    {copyError?.text === q && <p role="alert" className="basis-full text-danger">{copyError.message}</p>}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </div>

      {/* AI 解码输入区 */}
      <div className={`relative space-y-4 p-5 ${cardCls}`}>
        <LoadingOverlay
          show={decoding}
          message="正在分析文本线索与待核实条件…"
          description="仅依据本次原文整理可能解释与核实问题，不确认公司实际情况；风险信号分不代表实际风险概率，请稍候…"
        />
        <div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label htmlFor={sourceId} className={labelCls}>待解码的 JD 文本 / 面试官暗号话术</label>
            {text.trim() && (
              <button
                type="button"
                onClick={() => setText("")}
                disabled={decoding}
                className="text-xs text-faint hover:text-danger"
              >
                清空内容
              </button>
            )}
          </div>
          <textarea
            id={sourceId}
            aria-label="待解码的 JD 文本或面试原话"
            className={`${textareaTallCls} mt-2 font-mono text-xs`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={decoding}
            placeholder="粘贴完整的招聘 JD、团队介绍或面试原话，也可输入“抗压能力强”等短语。尽量保留说话人、否定与适用条件，便于区分字面含义、可能解释和待核实信息。"
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <div className="text-xs text-muted">
            {text.trim().length > 0 ? (
              <span>已输入 {text.trim().length} 字，将结合上下文分析</span>
            ) : (
              <span>支持整段职位 JD，也支持单句暗号输入</span>
            )}
          </div>
          <button
            type="button"
            className={btnPrimary}
            onClick={handleDecode}
            disabled={decoding || !text.trim()}
          >
            {decoding ? "正在分析文本…" : "启动暗号解码器 →"}
          </button>
        </div>
      </div>

      {error && <div role="alert" className={`space-y-1 text-sm ${textErr}`}><p>{error}</p><p>原文已保留，请先核对历史是否已有报告，再决定是否重新解码。</p></div>}
      <ToolHistoryDeletionFeedback deletion={deletion} />
      {loadError && <LoadError message={`解码历史加载失败：${loadError}`} onRetry={failedCursor === null ? reload : loadMore} />}
      {records === null && !loadError && <Loading label="正在加载解码历史…" />}

      {/* 历史解码记录 */}
      {visibleRecords !== null && visibleRecords.length > 0 && (
        <div className="space-y-3 pt-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-ink">📜 解码历史记录</h2>
            <span className="text-xs text-faint">已载入 {visibleRecords.length} 份报告</span>
          </div>

          <div className="divide-y divide-line rounded-xl border border-line bg-card overflow-hidden">
            {visibleRecords.map((r) => {
              const parsed = parseJargonDecoderResult(r.result);
              return (
                <div
                  key={r.id}
                  className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 hover:bg-surface/50 transition-colors"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/tools/decoder/${r.id}`}
                        className="font-medium text-ink hover:text-primary hover:underline truncate"
                      >
                        {getRecordTitle(r)}
                      </Link>
                      {parsed && getRiskBadge(parsed.overallRiskScore)}
                      {parsed?.items.some((item) => item.riskLevel === null) && (
                        <span className="text-xs text-muted">含未评估条目</span>
                      )}
                    </div>
                    {parsed && (
                      <p className="text-xs text-muted truncate">
                        {parsed.punchline}
                      </p>
                    )}
                    <p className="text-[11px] text-faint">
                      {new Date(r.created_at).toLocaleString()}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    <Link href={`/tools/decoder/${r.id}`} className={btnGhost}>
                      查看报告
                    </Link>
                    <button
                      type="button"
                      onClick={() => void deletion.remove(r.id, getRecordTitle(r))}
                      disabled={deletion.busy}
                      className={btnDanger}
                    >
                      删除
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          {nextCursor && (
            <div className="flex justify-center pt-2">
              <button type="button" className={btnPrimary} onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? "加载中…" : failedCursor === nextCursor ? "重试加载更多" : "加载更多"}
              </button>
            </div>
          )}
        </div>
      )}

      {visibleRecords !== null && visibleRecords.length === 0 && (
        <p className="text-center text-xs text-faint py-6">
          暂无历史解码记录：在上方粘贴一段 JD 或选取高频暗号体验吧
        </p>
      )}
    </div>
  );
}
