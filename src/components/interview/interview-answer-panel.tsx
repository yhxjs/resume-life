import type { Dispatch, SetStateAction } from "react";
import type { InterviewData, InterviewTurn } from "@/hooks/use-interview-session";
import { btnGhost, btnPrimary, textareaTallCls, textErr } from "@/lib/ui";
import { LoadingOverlay } from "@/components/common/loading-overlay";

type InterviewAnswerPanelProps = {
  data: InterviewData;
  current: InterviewTurn | undefined;
  answer: string;
  setAnswer: Dispatch<SetStateAction<string>>;
  busy: boolean;
  confirmingFinish: boolean;
  error: string;
  readRecovery: { kind: "answer" | "report"; confirmed: boolean } | null;
  onRetryRead: () => void;
  answeredCount: number;
  displayedText: string;
  isTyping: boolean;
  onFinish: () => void;
  onSubmitAnswer: () => void;
  onGenerateReport: () => void;
  onOpenReverse: () => void;
};

export function InterviewAnswerPanel({
  data,
  current,
  answer,
  setAnswer,
  busy,
  confirmingFinish,
  error,
  readRecovery,
  onRetryRead,
  answeredCount,
  displayedText,
  isTyping,
  onFinish,
  onSubmitAnswer,
  onGenerateReport,
  onOpenReverse,
}: InterviewAnswerPanelProps) {
  if (readRecovery) {
    return (
      <div className="space-y-4 rounded-2xl border border-line bg-card p-6 shadow-card-subtle">
        <p role={error ? "alert" : "status"} className={`text-sm ${error ? textErr : "text-muted"}`}>
          {error || "正在读取已提交的面试结果…"}
        </p>
        {readRecovery.kind === "answer" && answer && (
          <label className="block space-y-2 text-sm text-muted">
            <span>保留的回答草稿</span>
            <textarea className={textareaTallCls} value={answer} readOnly />
          </label>
        )}
        <button type="button" className={btnPrimary} disabled={busy} onClick={onRetryRead}>
          {busy ? "正在读取面试状态…" : readRecovery.confirmed
            ? readRecovery.kind === "answer" ? "重新读取已保存作答" : "重新读取已保存报告"
            : "重新读取面试状态"}
        </button>
      </div>
    );
  }

  if (data.status === "ongoing" && current) {
    return (
      <div className="space-y-4 rounded-2xl border border-line bg-card p-6 shadow-card-subtle">
        <div className="flex items-center justify-between border-b border-line pb-2.5">
          <label htmlFor={`interview-answer-${data.id}`} className="font-serif text-sm font-bold text-ink flex items-center gap-2">
            <span className="h-[9px] w-[9px] rounded-[1px] bg-primary" />
            <span>以候选人身份组织作答：</span>
          </label>
          <span className="font-mono text-xs text-faint">Ctrl + Enter 快捷提交</span>
        </div>

        <textarea
          id={`interview-answer-${data.id}`}
          className={`${textareaTallCls} font-sans text-xs sm:text-sm`}
          value={answer}
          onChange={(event) => { if (!busy && !confirmingFinish) setAnswer(event.target.value); }}
          placeholder="按题目要求说明要点；经历题可用 STAR 整理实际行动与分工，未知信息请明确说明…"
          disabled={busy || confirmingFinish}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (!busy && !confirmingFinish && answer.trim()) onSubmitAnswer();
            }
          }}
        />
        {error && <p role="alert" className={`text-sm ${textErr}`}>{error}</p>}

        {busy && (
          <div className="rounded-xl border border-primary/20 bg-primary-soft/50 p-4 animate-in fade-in duration-200">
            <div className="flex items-center gap-2 text-xs font-bold text-primary">
              <span className="inline-block h-2 w-2 animate-ping rounded-full bg-primary" />
              面试官正在倾听点评并构思下一步追问…
            </div>
            <div className="mt-2 text-sm text-ink leading-relaxed font-sans whitespace-pre-wrap">
              {displayedText || "正在分析您的作答深度与技术切入点…"}
              {isTyping && (
                <span className="inline-block w-1.5 h-4 ml-0.5 bg-primary animate-pulse align-middle" />
              )}
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
          <span className="text-xs text-faint">简短且充分也可获得高分；按题目作答，说明实际分工与尚未验证的信息。</span>
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              className={btnGhost}
              onClick={onFinish}
              disabled={busy || answeredCount === 0}
            >
              提前结束并生成总结
            </button>
            <button
              type="button"
              className={btnPrimary}
              onClick={onSubmitAnswer}
              disabled={busy || confirmingFinish || !answer.trim()}
            >
              {busy ? "面试官思考中…" : "提交回答"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (data.status === "ongoing") {
    return (
      <p className="text-sm text-muted text-center py-4">
        本轮回答已提交，面试即将完结。如页面未更新请刷新。
      </p>
    );
  }

  if (data.status === "finished" && !data.report) {
    return (
      <div className="relative rounded-2xl border border-line bg-card p-6 shadow-card-subtle space-y-3">
        {error && <p role="alert" className={`text-sm ${textErr}`}>{error}</p>}
        <LoadingOverlay
          show={busy}
          message="AI 考官正在全面复盘本场面试…"
          description="正在整理已作答题目的表现与材料一致性，生成模拟复盘报告，请稍候…"
        />
        <p className="font-serif text-base font-bold text-ink">面试题目已全部作答完毕！</p>
        <p className="text-xs text-muted leading-relaxed">
          {data.reverse_interview
            ? "反问环节已完成，随时可以生成本场面试的综合全景复盘报告。"
            : "您可以先练习向面试官反问，核实岗位相关信息，也可以直接生成全场报告。"}
        </p>
        <div className="flex flex-wrap items-center gap-3 pt-2">
          {!data.reverse_interview && (
            <button type="button" className={btnGhost} onClick={onOpenReverse} disabled={busy}>
              <span>🤝 进入反问环节</span>
            </button>
          )}
          <button type="button" className={btnPrimary} onClick={onGenerateReport} disabled={busy}>
            {busy ? "正在生成总结报告…" : "立即生成全景报告"}
          </button>
        </div>
      </div>
    );
  }

  return null;
}
