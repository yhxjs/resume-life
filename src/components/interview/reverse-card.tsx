"use client";

import type { ReverseInterviewData } from "@/lib/interview";
import { badgePrimary, badgeAccent, cardCls, scoreTextCls, wellCls } from "@/lib/ui";

interface InterviewReverseCardProps {
  data: ReverseInterviewData;
  styleName?: string;
}

export function InterviewReverseCard({ data, styleName }: InterviewReverseCardProps) {
  const { question, answer, evaluation, created_at } = data;
  const score = evaluation.score;

  return (
    <div className={`${cardCls} overflow-hidden border-primary/30 shadow-sm transition-all`}>
      {/* 头部状态与得分 */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-primary-soft/40 px-5 py-3.5">
        <div className="flex items-center gap-2">
          <span className="text-base">🤝</span>
          <span className="font-medium text-ink">
            尾声反问环节（Reverse Interview）
          </span>
          <span className={badgePrimary}>加分参考项</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted">提问水平评级：</span>
          <span className={`${badgeAccent} font-semibold`}>
            {evaluation.level || "良好"}
          </span>
          <div className="flex items-baseline gap-1">
            <span className="text-xs text-muted">提问评分</span>
            <span className={`font-mono text-xl font-bold tabular-nums ${scoreTextCls(score)}`}>
              {score}
            </span>
            <span className="text-xs text-faint">/10</span>
          </div>
        </div>
      </div>

      <div className="p-5 space-y-4">
        {/* 候选人的提问 */}
        <div>
          <div className="flex items-center gap-2 text-xs font-medium text-muted">
            <span className="h-2 w-2 rounded-full bg-primary" />
            <span>候选人反问</span>
            {created_at && (
              <span className="text-[11px] text-faint">
                · {new Date(created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            )}
          </div>
          <div className="mt-1.5 rounded-xl rounded-tl-sm border border-line bg-card p-3.5 text-sm font-medium text-ink leading-relaxed">
            {question}
          </div>
        </div>

        {/* 面试官的回答 */}
        <div>
          <div className="flex items-center gap-2 text-xs font-medium text-muted">
            <span className="h-2 w-2 rounded-full bg-accent" />
            <span>面试官作答{styleName ? `（${styleName}）` : ""}</span>
          </div>
          <div className="mt-1.5 rounded-xl rounded-tl-sm bg-surface p-3.5 text-sm text-ink leading-relaxed whitespace-pre-wrap">
            {answer}
          </div>
        </div>

        {/* 面试官视角对提问的诊断与建议 */}
        <div className={`${wellCls} space-y-2.5 text-xs`}>
          <div className="flex items-center gap-1.5 font-semibold text-primary">
            <span>🎯 考官视角的提问水平诊断</span>
          </div>

          {evaluation.insight && (
            <p className="leading-relaxed text-ink">
              <span className="font-medium text-muted">视角洞察：</span>
              {evaluation.insight}
            </p>
          )}

          {evaluation.feedback && (
            <p className="leading-relaxed text-ink">
              <span className="font-medium text-muted">提问点评：</span>
              {evaluation.feedback}
            </p>
          )}

          {evaluation.suggestions && (
            <p className="leading-relaxed text-ink">
              <span className="font-medium text-primary">更佳问法与进阶建议：</span>
              {evaluation.suggestions}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
