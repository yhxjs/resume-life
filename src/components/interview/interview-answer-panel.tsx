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
  error: string;
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
  error,
  answeredCount,
  displayedText,
  isTyping,
  onFinish,
  onSubmitAnswer,
  onGenerateReport,
  onOpenReverse,
}: InterviewAnswerPanelProps) {
  if (data.status === "ongoing" && current) {
    return (
      <div className="space-y-4 rounded-2xl border border-line bg-card p-6 shadow-card-subtle">
        <div className="flex items-center justify-between border-b border-line pb-2.5">
          <label className="font-serif text-sm font-bold text-ink flex items-center gap-2">
            <span className="h-[9px] w-[9px] rounded-[1px] bg-primary" />
            <span>以候选人身份组织作答：</span>
          </label>
          <span className="font-mono text-xs text-faint">Ctrl + Enter 快捷提交</span>
        </div>

        <textarea
          className={`${textareaTallCls} font-sans text-xs sm:text-sm`}
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          placeholder="建议采用分点阐述或 STAR 原则展开作答…"
          disabled={busy}
        />
        {error && <p className={`text-sm ${textErr}`}>{error}</p>}

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
          <span className="text-xs text-faint">请尽量详实回答，作答越充分考官追问越具真实针对性</span>
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
              disabled={busy || !answer.trim()}
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
        <LoadingOverlay
          show={busy}
          message="AI 考官正在全面复盘本场面试…"
          description="正在整合各轮问答作答表现、技术深度与真实性评分，生成全景评估报告，请稍候…"
        />
        <p className="font-serif text-base font-bold text-ink">面试题目已全部作答完毕！</p>
        <p className="text-xs text-muted leading-relaxed">
          {data.reverse_interview
            ? "反问环节已完成，随时可以生成本场面试的综合全景复盘报告。"
            : "您可以先向面试官提出一个问题体验真实的逆向反问加分环节，也可以直接生成全场报告。"}
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
