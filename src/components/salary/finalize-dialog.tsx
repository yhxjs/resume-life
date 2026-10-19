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
  finalizeError: string;
}

export function SalaryFinalizeDialog({
  open,
  onClose,
  onConfirm,
  finalWords,
  setFinalWords,
  finalizing,
  finalizeError,
}: SalaryFinalizeDialogProps) {
  return (
    <Modal
      open={open}
      title="达成一致 · 结束并生成复盘报告"
      description="输入你与 HR 最终锁定的口头方案或总结表态，生成整场谈判的复盘报告。"
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
          达成一致 · 结束并生成复盘报告
        </h3>
        <p className="text-xs text-muted leading-relaxed">
          输入你与 HR 最终锁定的口头方案或总结表态（可选），AI 将全面复盘整场拉扯博弈，输出包含评级与实战锦囊的深度报告。
        </p>

        <label className="block">
          <span className="text-xs font-medium text-ink">最终确认表态（可选）</span>
          <textarea
            value={finalWords}
            onChange={(e) => setFinalWords(e.target.value)}
            placeholder="例如：双方最终商定 34k*15 + 2W 签字费，9月下旬入职；或输入你最后的反击收官词…"
            className={`${textareaShortCls} mt-1 text-xs`}
            disabled={finalizing}
          />
        </label>

        {finalizeError && <p className={`text-xs ${textErr}`}>{finalizeError}</p>}

        <div className="flex items-center justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className={btnGhost}
            disabled={finalizing}
          >
            取消
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={finalizing}
            className={btnPrimary}
          >
            {finalizing ? "正在生成复盘报告…" : "确认封板并生成报告"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
