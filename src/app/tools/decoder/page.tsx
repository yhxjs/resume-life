"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { confirmDialog, alertDialog } from "@/components/common/confirm-dialog";
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
    return <span className={badgeDanger}>⚠️ 高风险预警 ({score}分)</span>;
  }
  if (score >= 50) {
    return <span className={badgeAccent}>⚡ 中度警惕 ({score}分)</span>;
  }
  return <span className={badgePrimary}>✓ 风险可控 ({score}分)</span>;
}

export default function JargonDecoderPage() {
  const router = useRouter();
  const { items: records, total, nextCursor, loadingMore, listError: loadError, failedCursor, loadMore, reload } = useCursorList<DecodingRecord>({
    queryKey: "jargon-decodings",
    buildUrl: (cursor) => `/api/tools/jargon-decodings?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
    delay: 0,
  });
  const [text, setText] = useState("");
  const [decoding, setDecoding] = useState(false);
  const [error, setError] = useState("");

  // 经典暗号速查弹窗/抽屉状态
  const [inspectPreset, setInspectPreset] = useState<DecodedItem | null>(null);
  const { copiedText: copiedQuestion, copy } = useCopyFeedback();

  async function handleDecode() {
    if (!text.trim()) return;
    setDecoding(true);
    setError("");
    try {
      const data = await jsonFetch<{ id: number }>("/api/tools/jargon-decodings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.trim() }),
      });
      router.push(`/tools/decoder/${data.id}`);
    } catch (err) {
      setError(errorMessage(err));
      setDecoding(false);
    }
  }

  async function removeRecord(id: number) {
    if (
      !(await confirmDialog({
        title: "删除解码记录",
        message: "确定删除这份暗号解码报告？",
        danger: true,
      }))
    ) {
      return;
    }
    try {
      await jsonFetch(`/api/tools/jargon-decodings/${id}`, { method: "DELETE" });
      reload();
    } catch (err) {
      await alertDialog({
        title: "删除失败",
        message: errorMessage(err),
      });
    }
  }

  async function copyText(val: string) {
    if (!(await copy(val))) setError("复制失败，请检查浏览器剪贴板权限");
  }

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      {/* 顶部标题栏 */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div>
          <h1 className="font-serif text-[28px] sm:text-[32px] font-bold text-ink leading-tight">
            面试黑话与暗号解码器
          </h1>
          <p className="mt-1 max-w-prose text-sm text-muted leading-relaxed">
            穿透招聘 JD 与面试套话的包装滤镜，看懂潜台词与真实工作生态，获取面试应对潜规则与反向提问避坑指南。
          </p>
        </div>
        {records !== null && (
          <div className="flex items-center gap-2 text-xs text-muted">
            <span>已载入解码存档：<strong className="font-mono text-ink font-bold text-sm">{records.length}</strong> 份{total !== null && ` / 共 ${total} 份`}</span>
          </div>
        )}
      </div>

      {/* 经典高频黑话秒查卡片区 */}
      <div className={`p-5 space-y-4 ${cardCls}`}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line/70 pb-3">
          <div>
            <h2 className="text-sm font-bold text-ink flex items-center gap-2">
              <span>🔍 经典高频暗号速览</span>
              <span className="text-xs font-normal text-muted">
                （点击标签可一键速查内幕或填入输入框）
              </span>
            </h2>
          </div>
          <button
            type="button"
            onClick={() => setText(SAMPLE_JD)}
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
                    isHigh ? "bg-danger" : isMedium ? "bg-accent" : "bg-primary"
                  }`}
                />
              </button>
            );
          })}
        </div>

        {/* 经典暗号展开预览卡片 */}
        {inspectPreset && (
          <div className={`mt-4 space-y-3.5 border-l-4 border-primary p-4 ${wellCls}`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <span className="text-base font-bold text-ink">{inspectPreset.keyword}</span>
                <span className="text-xs font-medium text-muted">[{inspectPreset.riskCategory}]</span>
                <span
                  className={
                    inspectPreset.riskLevel === "high"
                      ? badgeDanger
                      : inspectPreset.riskLevel === "medium"
                      ? badgeAccent
                      : badgePrimary
                  }
                >
                  {inspectPreset.riskLevel === "high"
                    ? "高危警示"
                    : inspectPreset.riskLevel === "medium"
                    ? "中度关注"
                    : "常规留心"}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setText((prev) => (prev ? `${prev}\n${inspectPreset.keyword}` : inspectPreset.keyword));
                  }}
                  className="text-xs text-primary hover:underline font-medium"
                >
                  + 加到输入框
                </button>
                <button
                  type="button"
                  onClick={() => setInspectPreset(null)}
                  className="text-xs text-faint hover:text-ink"
                >
                  收起 ✕
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
              <div className="rounded-md border border-line bg-card p-3 space-y-1">
                <div className="font-semibold text-muted">📢 表面说辞</div>
                <div className="text-ink leading-relaxed">{inspectPreset.surfaceMeaning}</div>
              </div>
              <div className="rounded-md border border-danger/20 bg-danger-wash p-3 space-y-1">
                <div className="font-semibold text-danger">💡 真实潜台词（揭底）</div>
                <div className="text-ink leading-relaxed font-medium">{inspectPreset.hiddenMeaning}</div>
              </div>
            </div>

            <div className="rounded-md border border-line bg-card p-3 space-y-1.5 text-xs">
              <div className="font-semibold text-ink flex items-center gap-1.5">
                <span>🛡️ 面试应对潜规则</span>
                <span className="text-faint font-normal">（面试官问到时的避坑策略）</span>
              </div>
              <p className="text-muted leading-relaxed">{inspectPreset.interviewRule}</p>
            </div>

            <div className="rounded-md border border-line bg-card p-3 space-y-2 text-xs">
              <div className="font-semibold text-ink">🗡️ 刺探反问暗器（反客为主探虚实）</div>
              <ul className="space-y-1.5">
                {inspectPreset.counterQuestions.map((q, idx) => (
                  <li key={idx} className="flex items-start justify-between gap-3 text-muted">
                    <span className="leading-relaxed">👉 {q}</span>
                    <button
                      type="button"
                      onClick={() => void copyText(q)}
                      className="shrink-0 text-primary hover:underline font-medium"
                    >
                      {copiedQuestion === q ? "已复制 ✓" : "复制"}
                    </button>
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
          message="暗号解码器正在穿透分析潜台词…"
          description="正在拆解黑话修饰词与团队真实工作生态，生成反制套路与避坑指南，约需 20-30 秒，请稍候…"
        />
        <label className="block">
          <div className="flex items-center justify-between">
            <span className={labelCls}>待解码的 JD 文本 / 面试官暗号话术</span>
            {text.trim() && (
              <button
                type="button"
                onClick={() => setText("")}
                className="text-xs text-faint hover:text-danger"
              >
                清空内容
              </button>
            )}
          </div>
          <textarea
            className={`${textareaTallCls} mt-2 font-mono text-xs`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="粘贴完整的岗位招聘 JD、团队宣讲文案，或者输入诸如“抗压能力强”、“拥抱变化”、“扁平化管理”、“有从0到1经验”等暗号短句。AI 将穿透修饰词，深度还原团队生态并给出面试应对潜规则与反向提问避坑指南…"
          />
        </label>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <div className="text-xs text-muted">
            {text.trim().length > 0 ? (
              <span>已输入 {text.trim().length} 字，将进行全方位深度解码</span>
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
            {decoding ? "正在穿透暗号中（预计需20-30秒）…" : "启动暗号解码器 →"}
          </button>
        </div>
      </div>

      {error && <p className={`text-sm ${textErr}`}>{error}</p>}
      {loadError && <LoadError message={`解码历史加载失败：${loadError}`} onRetry={failedCursor === null ? reload : loadMore} />}
      {records === null && !loadError && <Loading label="正在加载解码历史…" />}

      {/* 历史解码记录 */}
      {records !== null && records.length > 0 && (
        <div className="space-y-3 pt-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-bold text-ink">📜 解码历史记录</h2>
            <span className="text-xs text-faint">已载入 {records.length} 份报告</span>
          </div>

          <div className="divide-y divide-line rounded-xl border border-line bg-card overflow-hidden">
            {records.map((r) => {
              const parsed = parseJargonDecoderResult(r.result);
              return (
                <div
                  key={r.id}
                  className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 hover:bg-surface/50 transition-colors"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2">
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
                      onClick={() => removeRecord(r.id)}
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

      {records !== null && records.length === 0 && (
        <p className="text-center text-xs text-faint py-6">
          暂无历史解码记录：在上方粘贴一段 JD 或选取高频暗号体验吧
        </p>
      )}
    </div>
  );
}
