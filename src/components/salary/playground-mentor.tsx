"use client";

import type { NegotiationTurnData, SuggestedReply } from "@/lib/salary-negotiation";
import { cardCls } from "@/lib/ui";

interface SalaryPlaygroundMentorProps {
  turns: NegotiationTurnData[];
  activeTurnNo: number;
  onSelectTurn: (turnNo: number) => void;
  onApplySuggestion: (suggestion: SuggestedReply) => void;
  isFinished: boolean;
}

export function SalaryPlaygroundMentor({
  turns,
  activeTurnNo,
  onSelectTurn,
  onApplySuggestion,
  isFinished,
}: SalaryPlaygroundMentorProps) {
  const activeTurn = turns.find((t) => t.turn_no === activeTurnNo) ?? turns[turns.length - 1];

  return (
    <div className={`p-5 ${cardCls} space-y-5 sticky top-20`}>
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
            深度复盘你的说服漏洞并提供高胜率解法
          </p>
        </div>

        {/* 回合切换 Pills */}
        {turns.length > 1 && (
          <div className="flex items-center gap-1 overflow-x-auto max-w-[150px]">
            {turns.map((t) => (
              <button
                key={t.turn_no}
                type="button"
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
                第 {activeTurn.turn_no} 回合说服力评分
              </span>
              <span className="text-[11px] text-faint">
                {activeTurn.turn_no === 1
                  ? "初始开局局势拆解"
                  : "基于你最新一轮的说服逻辑评估"}
              </span>
            </div>
            <div className="flex items-baseline gap-1">
              <span className="font-mono text-2xl font-bold text-primary">
                {activeTurn.mentor_analysis.user_argument_score}
              </span>
              <span className="font-mono text-muted">/10</span>
            </div>
          </div>

          {/* 优势筹码与逻辑漏洞 */}
          <div className="grid grid-cols-1 gap-2.5">
            {/* 优势筹码 */}
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3 space-y-1">
              <div className="flex items-center gap-1 text-[11px] font-bold text-emerald-700 dark:text-emerald-400">
                <span>✓ 打出的优势筹码与亮点</span>
              </div>
              <ul className="space-y-1 pl-3 list-disc text-muted">
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
                <span>⚠ 暴露的逻辑漏洞或破绽</span>
              </div>
              <ul className="space-y-1 pl-3 list-disc text-muted">
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
              {activeTurn.mentor_analysis.tactical_tips}
            </p>
          </div>

          {/* 推荐高情商反击示范（带一键填入） */}
          {!isFinished && (
            <div className="space-y-2.5 pt-1">
              <span className="text-[11px] font-bold text-ink block">
                🎯 推荐高情商反制话术示范
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
                      className="rounded-md border border-primary/40 bg-card px-2 py-0.5 text-[10px] font-medium text-primary hover:bg-primary hover:text-on-primary transition-colors cursor-pointer"
                    >
                      一键填入输入框 ↗
                    </button>
                  </div>
                  <p className="rounded-lg bg-card/80 p-2.5 font-sans text-xs text-ink leading-relaxed border border-line/60">
                    {s.content}
                  </p>
                  <p className="text-[11px] text-muted italic">
                    心理学原理：{s.rationale}
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
