"use client";

import { useState } from "react";
import { Drawer } from "@/components/common/drawer";
import { LoadingOverlay } from "@/components/common/loading-overlay";
import type { DefenseDrillRecord, ScannedDefenseItem } from "@/lib/resume-defense";
import { jsonFetch } from "@/lib/fetcher";
import {
  btnGhost,
  btnPrimary,
  badgeDanger,
  badgeAccent,
  badgePrimary,
  textareaTallCls,
  textErr,
} from "@/lib/ui";
import { errorMessage } from "@/lib/error-message";
import { RichText } from "@/components/resume/rich-text";

interface DefenseDrillDrawerProps {
  defenseId: number;
  item: ScannedDefenseItem | null;
  existingDrill?: DefenseDrillRecord | null;
  isOpen: boolean;
  onClose: () => void;
  onDrillSaved: (drill: DefenseDrillRecord) => void;
}

function DefenseDrillForm({
  defenseId,
  item,
  existingDrill,
  onClose,
  onDrillSaved,
}: {
  defenseId: number;
  item: ScannedDefenseItem;
  existingDrill?: DefenseDrillRecord | null;
  onClose: () => void;
  onDrillSaved: (drill: DefenseDrillRecord) => void;
}) {
  const initialQuestion =
    existingDrill?.question ||
    item.deadlyQuestions?.[0] ||
    "请解释该技术点的实现原理与量化细节。";
  const [selectedQuestion, setSelectedQuestion] = useState(initialQuestion);
  const [answer, setAnswer] = useState(existingDrill?.userAnswer || "");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [drillResult, setDrillResult] = useState<DefenseDrillRecord | null>(
    existingDrill || null
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!answer.trim()) {
      setError("请先输入你的防御自辩回答");
      return;
    }
    setError("");
    setLoading(true);

    try {
      const res = await jsonFetch<DefenseDrillRecord>(
        `/api/tools/resume-defenses/${defenseId}/drill`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            itemId: item.id,
            question: selectedQuestion,
            userAnswer: answer.trim(),
            defensePlan: item.defensePlan.standardDefense,
          }),
        }
      );
      setDrillResult(res);
      onDrillSaved(res);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  function getScoreBadge(score: number) {
    if (score >= 85) return <span className={badgePrimary}>防御坚不可摧 ({score}分)</span>;
    if (score >= 65) return <span className={badgeAccent}>防线基本稳固 ({score}分)</span>;
    return <span className={badgeDanger}>破绽已被击穿 ({score}分)</span>;
  }

  return (
    <>
      {/* 抽屉顶栏 */}
      <div className="flex items-center justify-between border-b border-line bg-surface/50 px-4 pb-4 pt-[max(1rem,env(safe-area-inset-top))] sm:px-6">
          <div className="space-y-0.5">
            <div className="flex items-center gap-2">
              <span className="font-serif text-lg font-bold text-ink">即时防御演练场</span>
              <span className="inline-flex rounded-full bg-danger-wash text-danger border border-danger/20 px-2 py-0.5 text-[11px] font-medium">
                毒舌挑刺中
              </span>
            </div>
            <p className="text-xs text-muted">针对简历高危点，与毒舌大厂面试官面对面攻防对决</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-muted hover:bg-surface hover:text-ink transition-colors cursor-pointer"
            aria-label="关闭"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
      </div>

      {/* 抽屉内容区 */}
      <div className="relative flex-1 overflow-y-auto space-y-6 p-4 sm:p-6">
        <LoadingOverlay
          show={loading}
          message="毒舌面试官正在严苛审视回答…"
          description="正在多维评估自辩逻辑、攻防漏洞与量化证据，请稍候…"
        />
        {/* 靶子原句 */}
          <div className="space-y-1.5 rounded-xl border border-line bg-surface/40 p-3.5 text-xs">
            <div className="flex items-center justify-between text-muted">
              <span className="font-semibold text-ink flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 rounded-full bg-danger" />
                <span>被抓包的原句</span>
              </span>
              <span className="text-[11px] text-faint">{item.sectionHint}</span>
            </div>
            <div className="font-mono text-ink bg-card rounded-md p-2.5 border border-line/60 leading-relaxed break-words">
              &ldquo;<RichText content={item.originalText} />&rdquo;
            </div>
          </div>

          {/* 面试官致命发难 */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs font-bold text-ink flex items-center gap-1.5">
                <span className="inline-block text-base">🧐</span>
                <span>面试官现场发难（点击可切换追问角度）：</span>
              </label>
            </div>
            <div className="space-y-2">
              {(item.deadlyQuestions || []).map((q, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => setSelectedQuestion(q)}
                  className={`w-full text-left rounded-xl p-3 text-xs transition-all border cursor-pointer ${
                    selectedQuestion === q
                      ? "border-primary bg-primary-soft/30 font-medium text-ink shadow-xs"
                      : "border-line bg-card hover:bg-surface text-muted"
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <span className="shrink-0 mt-0.5 text-[10px] font-mono px-1.5 py-0.2 rounded bg-surface border border-line">
                      追问 #{idx + 1}
                    </span>
                    <span className="flex-1 leading-relaxed">{q}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>

          {/* 防御答题区 */}
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-xs font-bold text-ink flex items-center gap-1.5">
                <span className="inline-block text-base">🛡️</span>
                <span>你的现场防御自辩回答：</span>
              </label>
              <button
                type="button"
                onClick={() => setAnswer(item.defensePlan?.standardDefense || "")}
                className="text-[11px] text-primary hover:underline cursor-pointer"
              >
                填入预案参考
              </button>
            </div>

            <textarea
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder="在此输入你的回答（建议运用 STAR 结构：交代背景压测环境、具体量化基数、架构方案取舍与容灾反思）..."
              className={`${textareaTallCls} text-xs`}
            />

            {error && <p className={textErr}>{error}</p>}

            <div className="flex items-center justify-between gap-3 pt-1">
              <span className="text-[11px] text-faint">
                已输入 {answer.length} 字 · 回答应注重数据基准与权衡
              </span>
              <button
                type="submit"
                disabled={loading || !answer.trim()}
                className={`${btnPrimary} min-w-[120px] cursor-pointer`}
              >
                {loading ? (
                  <>
                    <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-on-primary" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                    </svg>
                    <span>面试官批改中…</span>
                  </>
                ) : (
                  "提交迎击演练"
                )}
              </button>
            </div>
          </form>

          {/* 演练批改结果 */}
          {drillResult && (
            <div className="space-y-4 rounded-2xl border border-line bg-card p-4 shadow-card-subtle">
              <div className="flex items-center justify-between border-b border-line/60 pb-3">
                <span className="font-serif text-sm font-bold text-ink flex items-center gap-1.5">
                  <span>对决结果评估</span>
                </span>
                {getScoreBadge(drillResult.defenseScore)}
              </div>

              {/* 毒舌点评 */}
              <div className="space-y-1 rounded-xl bg-danger-wash/40 border border-danger/20 p-3 text-xs">
                <div className="flex items-center gap-1.5 font-bold text-danger text-[11px]">
                  <span>🤬 毒舌面试官当头棒喝：</span>
                </div>
                <p className="text-ink leading-relaxed font-sans">{drillResult.interviewerRoast}</p>
              </div>

              {/* 破绽剖析 */}
              <div className="space-y-1 rounded-xl bg-accent-wash/30 border border-accent/20 p-3 text-xs">
                <div className="flex items-center gap-1.5 font-bold text-accent text-[11px]">
                  <span>🔍 破绽与死穴剖析：</span>
                </div>
                <p className="text-ink leading-relaxed">{drillResult.defenseCritique}</p>
              </div>

              {/* 满分示范 */}
              <div className="space-y-1 rounded-xl bg-primary-soft/30 border border-primary/20 p-3 text-xs">
                <div className="flex items-center gap-1.5 font-bold text-primary text-[11px]">
                  <span>✨ 大厂满分防御示范：</span>
                </div>
                <p className="text-ink leading-relaxed font-sans whitespace-pre-wrap">{drillResult.improvedAnswer}</p>
              </div>
            </div>
          )}
      </div>

      {/* 抽屉底栏 */}
      <div className="flex items-center justify-between border-t border-line bg-surface/50 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-6">
        <span className="text-[11px] text-faint">随时修改回答并重新提交评估</span>
        <button
          type="button"
          onClick={onClose}
          className={`${btnGhost} text-xs py-1.5 px-3 cursor-pointer`}
        >
          完成演练
        </button>
      </div>
    </>
  );
}

export function DefenseDrillDrawer({
  defenseId,
  item,
  existingDrill,
  isOpen,
  onClose,
  onDrillSaved,
}: DefenseDrillDrawerProps) {
  if (!isOpen || !item) return null;

  return (
    <Drawer
      open={isOpen}
      title="即时防御演练场"
      description="针对简历高危点进行即时防御演练"
      onClose={onClose}
      initialFocusSelector='button[aria-label="关闭"]'
    >
      <DefenseDrillForm
        key={`${defenseId}-${item.id}-${existingDrill?.id ?? "new"}`}
        defenseId={defenseId}
        item={item}
        existingDrill={existingDrill}
        onClose={onClose}
        onDrillSaved={onDrillSaved}
      />
    </Drawer>
  );
}
