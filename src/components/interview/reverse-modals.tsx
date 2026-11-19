"use client";

import { useState } from "react";
import { CompactModal } from "@/components/common/modal-variants";
import { btnGhost, btnPrimary, textareaShortCls, textErr } from "@/lib/ui";

const REVERSE_SAMPLES = [
  "就这个岗位而言，您期望新人在入职前3个月达成哪些核心目标与产出？",
  "团队目前在业务演进或技术架构上遇到的最核心挑战是什么？",
  "平时团队内部的技术方案决策、代码评审（CR）与上线流程是怎样的？",
  "您在这家公司/团队工作中最享受或最有成就感的是哪部分？",
];

interface ReverseInterviewModalsProps {
  showChoiceModal: boolean;
  showInputModal: boolean;
  interviewerLabel: string;
  busy: boolean;
  reverseBusy: boolean;
  reverseError: string;
  reverseReadRecovery: { confirmed: boolean } | null;
  reverseConflict: boolean;
  onRetryReverseRead: () => void;
  onSkipChoice: () => void;
  onStartChoice: () => void;
  onCloseInput: () => void;
  onGiveUpInput: () => void;
  onSubmitReverse: (question: string) => void;
}

export function ReverseInterviewModals({
  showChoiceModal,
  showInputModal,
  interviewerLabel,
  busy,
  reverseBusy,
  reverseError,
  reverseReadRecovery,
  reverseConflict,
  onRetryReverseRead,
  onSkipChoice,
  onStartChoice,
  onCloseInput,
  onGiveUpInput,
  onSubmitReverse,
}: ReverseInterviewModalsProps) {
  const [question, setQuestion] = useState("");
  const locked = reverseBusy || reverseReadRecovery !== null;

  return (
    <>
      {/* 弹窗 1：是否进入反问环节的选择模态框 */}
      <CompactModal
        open={showChoiceModal}
        title="主提问环节已全部完成！"
        onClose={onSkipChoice}
        closeOnBackdrop={!busy}
        escapeDisabled={busy}
        loading={busy}
        loadingText="AI 正在深度复盘并生成面试全景报告…"
        loadingDescription="正在综合多轮问答、STAR 结构、业务与技术深度进行四维打分与复盘，请稍候…"
        initialFocusSelector="[data-reverse-choice-initial]"
      >
        <div className="flex items-center gap-2">
          <span className="text-2xl">🎉</span>
          <h3 className="text-lg font-bold text-ink">主提问环节已全部完成！</h3>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          你可以通过反问核实岗位职责、工作安排、团队支持或薪酬条件，练习提出有助于求职判断的具体问题。
        </p>
        <div className="mt-3 rounded-lg border border-primary/20 bg-primary-soft/40 p-3 text-xs leading-relaxed text-ink">
          💡 <span className="font-semibold text-primary">模拟练习：</span>AI 根据已提供的背景模拟回应，未知的公司情况仍需向真实招聘方核实。评分只供练习参考，不代表真实公司的政策、承诺或录用结果。
        </div>
        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            data-reverse-choice-initial
            type="button"
            className={btnGhost}
            onClick={onSkipChoice}
            disabled={busy}
          >
            跳过，直接生成报告
          </button>
          <button
            type="button"
            className={btnPrimary}
            onClick={onStartChoice}
            disabled={busy}
          >
            进入反问环节
          </button>
        </div>
      </CompactModal>

      {/* 弹窗 2：反问输入模态框 */}
      <CompactModal
        open={showInputModal}
        title="向面试官提问"
        onClose={onCloseInput}
        closeOnBackdrop={!locked}
        escapeDisabled={locked}
        loading={reverseBusy}
        loadingText={reverseReadRecovery ? "正在读取反问结果…" : "面试官正在解答并评估你的反问…"}
        loadingDescription={reverseReadRecovery ? "正在核对已保存的反问与模拟回应，无需重复提问。" : "正在根据已提供的岗位背景模拟回应，并评价本次提问的信息价值。"}
        initialFocusSelector="textarea"
      >
        <div className="flex items-center justify-between gap-3 border-b border-line pb-3">
          <div className="flex items-center gap-2">
            <span className="text-xl">🤝</span>
            <h3 className="text-base font-bold text-ink">向面试官提问</h3>
          </div>
          <button
            type="button"
            onClick={onCloseInput}
            className="text-faint hover:text-ink text-sm"
            disabled={locked}
            aria-label="关闭反问弹窗"
          >
            ✕
          </button>
        </div>

        {!reverseConflict && <p className="mt-3 text-xs text-muted">
          请根据岗位背景、团队情况或技术体系，向当前的
          <span className="font-medium text-ink">
            「{interviewerLabel}」
          </span>
          面试官提出你的问题：
        </p>}

        {/* 快捷经典预设推荐 */}
        {!reverseConflict && <div className="mt-3 space-y-1.5">
          <p className="text-[11px] font-medium text-faint">推荐参考方向（点击填入）：</p>
          <div className="flex flex-wrap gap-1.5">
            {REVERSE_SAMPLES.map((sample, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => setQuestion(sample)}
                disabled={locked}
                className="rounded-md border border-line bg-surface px-2.5 py-1 text-left text-xs text-muted hover:border-primary/40 hover:bg-card hover:text-primary transition-colors"
              >
                💡 {sample}
              </button>
            ))}
          </div>
        </div>}

        <div className="mt-3">
          {reverseConflict && <p className="mb-2 text-sm text-muted">保留的反问草稿（可选择并复制）</p>}
          <textarea
            aria-label="我的反问问题"
            className={`${textareaShortCls} text-sm`}
            value={question}
            onChange={(e) => { if (!locked && !reverseConflict) setQuestion(e.target.value); }}
            placeholder="输入您想向面试官了解的问题…"
            disabled={locked}
            readOnly={reverseConflict}
          />
        </div>

        {reverseError && <p role="alert" className={`mt-2 text-xs ${textErr}`}>{reverseError}</p>}

        <div className="mt-5 flex flex-col items-stretch justify-between gap-3 border-t border-line pt-3 sm:flex-row sm:items-center">
          {reverseConflict ? <button type="button" className={`${btnPrimary} max-w-full whitespace-normal`} onClick={onCloseInput}>
            查看已保存结果
          </button> : <>
          <button
            type="button"
            className={`${btnGhost} max-w-full whitespace-normal`}
            onClick={onGiveUpInput}
            disabled={locked}
          >
            放弃反问，直接生成报告
          </button>
          <button
            type="button"
            className={`${btnPrimary} max-w-full whitespace-normal`}
            onClick={() => reverseReadRecovery ? onRetryReverseRead() : onSubmitReverse(question)}
            disabled={reverseBusy || (!reverseReadRecovery && !question.trim())}
          >
            {reverseBusy ? reverseReadRecovery ? "正在读取反问结果…" : "面试官思考与评估中…" : reverseReadRecovery
              ? reverseReadRecovery.confirmed ? "重新读取已保存反问" : "重新读取反问状态"
              : "向面试官提问"}
          </button>
          </>}
        </div>
      </CompactModal>
    </>
  );
}
