"use client";

import type { SuggestedReply } from "@/lib/salary-negotiation";
import { isHistoricalScore, type HistoricalNegotiationTurn } from "@/lib/salary-negotiation-history";
import { cardCls } from "@/lib/ui";

interface SalaryPlaygroundMentorProps {
  turns: HistoricalNegotiationTurn[];
  activeTurnNo: number;
  onSelectTurn: (turnNo: number) => void;
  onApplySuggestion: (suggestion: SuggestedReply) => void;
  isFinished: boolean;
  suggestionsDisabled?: boolean;
}

export function SalaryPlaygroundMentor({
  turns,
  activeTurnNo,
  onSelectTurn,
  onApplySuggestion,
  isFinished,
  suggestionsDisabled = false,
}: SalaryPlaygroundMentorProps) {
  const activeTurn = turns.find((t) => t.turn_no === activeTurnNo) ?? turns[turns.length - 1];
  const hasCandidateMessage = Boolean(activeTurn?.user_message.trim());

  return (
    <div className={`p-5 ${cardCls} space-y-5 sticky top-20 wrap-anywhere [&_p]:whitespace-pre-wrap [&_li]:whitespace-pre-wrap`}>
      {/* 军师头部与回合切换 */}
      <div className="flex items-center justify-between border-b border-line pb-3">
        <div>
          <div className="flex items-center gap-1.5">
            <span className="flex h-2 w-2 rounded-full bg-primary" />
            <h3 className="font-serif text-sm font-bold text-ink">
              首席谈判军师 · 即时拆解
            </h3>
          </div>
          <p className="text-[11px] text-muted mt-0.5">
            分析本轮表达与待确认条件，提供练习建议
          </p>
        </div>

        {/* 回合切换 Pills */}
        {turns.length > 1 && (
          <div className="flex items-center gap-1 overflow-x-auto max-w-[150px]">
            {turns.map((t) => (
              <button
                key={t.turn_no}
                type="button"
                aria-label={`查看第 ${t.turn_no} 回合分析`}
                aria-pressed={activeTurn?.turn_no === t.turn_no}
                onClick={() => onSelectTurn(t.turn_no)}
                className={`h-6 w-6 rounded-md text-[11px] font-mono transition-colors ${
                  activeTurnNo === t.turn_no
                    ? "bg-primary text-on-primary font-bold shadow-xs"
                    : "bg-surface border border-line text-muted hover:text-ink"
                }`}
              >
                {t.turn_no}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 本回合军师点评内容 */}
      {activeTurn && (
        <div className="space-y-4 text-xs">
          {/* 评分卡 */}
          <div className="flex items-center justify-between rounded-xl border border-line bg-surface p-3">
            <div>
              <span className="text-[11px] text-muted block">
                {hasCandidateMessage ? `第 ${activeTurn.turn_no} 回合说服力评分` : "开局分析 · 尚未评分"}
              </span>
              <span className="text-[11px] text-faint">
                {hasCandidateMessage
                  ? "仅评本回合已提交的候选人发言"
                  : "候选人尚未发言，先核对模拟方案与条件"}
              </span>
            </div>
            {hasCandidateMessage && (isHistoricalScore(activeTurn.mentor_analysis.user_argument_score, 1, 10) ? <div className="flex items-baseline gap-1">
              <span className="font-mono text-2xl font-bold text-primary">
                {activeTurn.mentor_analysis.user_argument_score}
              </span>
              <span className="font-mono text-muted">/10</span>
            </div> : <span className="text-xs text-muted">未保存有效评分</span>)}
          </div>

          {/* 优势筹码与逻辑漏洞 */}
          <div className="grid grid-cols-1 gap-2.5">
            {/* 优势筹码 */}
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3 space-y-1">
              <div className="flex items-center gap-1 text-[11px] font-bold text-emerald-700 dark:text-emerald-400">
                <span>{hasCandidateMessage ? "✓ 本轮亮点与可用依据" : "✓ 已知有利条件"}</span>
              </div>
              <ul className="space-y-1 pl-3 list-disc text-muted">
                {activeTurn.mentor_analysis.strengths.length === 0 && <li>旧记录未保存具体亮点</li>}
                {activeTurn.mentor_analysis.strengths.map((s, idx) => (
                  <li key={idx} className="leading-relaxed">
                    {s}
                  </li>
                ))}
              </ul>
            </div>

            {/* 逻辑漏洞 */}
            <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3 space-y-1">
              <div className="flex items-center gap-1 text-[11px] font-bold text-amber-700 dark:text-amber-400">
                <span>⚠ 待澄清与改进事项</span>
              </div>
              <ul className="space-y-1 pl-3 list-disc text-muted">
                {activeTurn.mentor_analysis.vulnerabilities.length === 0 && <li>旧记录未保存具体待澄清事项</li>}
                {activeTurn.mentor_analysis.vulnerabilities.map((v, idx) => (
                  <li key={idx} className="leading-relaxed">
                    {v}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* 核心破局点拨 */}
          <div className="rounded-xl border border-line bg-surface p-3 space-y-1">
            <span className="text-[11px] font-bold text-ink block">
              💡 军师核心破局点拨
            </span>
            <p className="text-muted leading-relaxed">
              {activeTurn.mentor_analysis.tactical_tips || "旧记录未保存练习建议"}
            </p>
          </div>

          {/* 推荐高情商反击示范（带一键填入） */}
          {!isFinished && (
            <div className="space-y-2.5 pt-1">
              <span className="text-[11px] font-bold text-ink block">
                🎯 练习回复参考（请核对后发送）
              </span>

              {activeTurn.mentor_analysis.suggested_replies.map((s, idx) => (
                <div
                  key={idx}
                  className="group rounded-xl border border-primary/30 bg-primary-soft/40 p-3.5 space-y-2 transition-all hover:border-primary"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-primary">
                      {s.title}
                    </span>
                    <button
                      type="button"
                      onClick={() => onApplySuggestion(s)}
                      disabled={suggestionsDisabled || !s.content.trim()}
                      className="rounded-md border border-primary/40 bg-card px-2 py-0.5 text-[10px] font-medium text-primary hover:bg-primary hover:text-on-primary transition-colors cursor-pointer"
                    >
                      一键填入输入框 ↗
                    </button>
                  </div>
                  <p className="whitespace-pre-wrap rounded-lg bg-card/80 p-2.5 font-sans text-xs text-ink leading-relaxed border border-line/60">
                    {s.content}
                  </p>
                  <p className="text-[11px] text-muted italic">
                    建议理由：{s.rationale}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
