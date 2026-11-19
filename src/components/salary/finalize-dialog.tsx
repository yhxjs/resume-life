"use client";

import { Modal } from "@/components/common/modal";
import { btnGhost, btnPrimary, textareaShortCls, textErr } from "@/lib/ui";

interface SalaryFinalizeDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  finalWords: string;
  setFinalWords: (words: string) => void;
  finalizing: boolean;
  actionsDisabled?: boolean;
  finalizeError: string;
}

export function SalaryFinalizeDialog({
  open,
  onClose,
  onConfirm,
  finalWords,
  setFinalWords,
  finalizing,
  actionsDisabled = finalizing,
  finalizeError,
}: SalaryFinalizeDialogProps) {
  return (
    <Modal
      open={open}
      title="结束模拟并生成复盘报告"
      description="无论是否达成一致，都可以结束本次模拟；可补充当前方案与尚未确认的条件。"
      onClose={onClose}
      initialFocusSelector="textarea"
      closeOnBackdrop={!finalizing}
      escapeDisabled={finalizing}
      loading={finalizing}
      loadingText="AI 正在深度复盘薪酬博弈拉扯…"
      loadingDescription="正在分析议价筹码、攻防话术与底线博弈成效，生成终局复盘报告，请稍候…"
    >
      <div className="space-y-4">
        <h3 className="font-serif text-lg font-bold text-ink">
          结束模拟并生成复盘报告
        </h3>
        <p className="text-xs text-muted leading-relaxed">
          结束模拟不代表双方达成一致。可补充当前方案、分歧或待审批条件（可选）；补充内容会作为你的自述参与复盘。
        </p>

        <label className="block">
          <span className="text-xs font-medium text-ink">结束补充（可选）</span>
          <textarea
            value={finalWords}
            onChange={(e) => setFinalWords(e.target.value)}
            placeholder="例如：目前只认可月薪，奖金与薪数尚未确认；HR 的加薪方案仍需审批，双方尚未达成一致。"
            className={`${textareaShortCls} mt-1 text-xs`}
            disabled={actionsDisabled}
          />
        </label>

        {finalizeError && <p className={`text-xs ${textErr}`}>{finalizeError}</p>}

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className={btnGhost}
            disabled={actionsDisabled}
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={actionsDisabled}
            className={btnPrimary}
          >
            {finalizing ? "正在生成复盘报告…" : "结束模拟并生成报告"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
