"use client";

import { useId, type ReactNode } from "react";
import { useModalFocus } from "@/hooks/use-modal-focus";
import { dialogCardCls, modalOverlayCls } from "@/lib/ui";
import { LoadingOverlay } from "@/components/common/loading-overlay";

export interface ModalProps {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  onClose: () => void;
  initialFocusSelector?: string;
  closeOnBackdrop?: boolean;
  escapeDisabled?: boolean;
  /** 是否展示全弹窗加载遮罩 */
  loading?: boolean;
  /** 遮罩主文案 */
  loadingText?: ReactNode;
  /** 遮罩辅助提示文案 */
  loadingDescription?: ReactNode;
  children: ReactNode;
}

export type ModalSurface = "default" | "compact" | "command" | "drawer";

const surfaceClassName: Record<ModalSurface, string> = {
  default: "max-w-lg",
  compact: "max-w-md",
  command: "mt-2 max-w-xl self-start !p-0 sm:mt-[10vh] overflow-hidden",
  drawer: "fixed inset-y-0 right-0 !h-[100dvh] !max-h-[100dvh] w-screen max-w-xl !rounded-none !border-y-0 !border-r-0 !p-0 !overflow-hidden flex flex-col",
};

export function ModalCore({
  open,
  title,
  description,
  onClose,
  initialFocusSelector,
  closeOnBackdrop = true,
  escapeDisabled = false,
  loading = false,
  loadingText,
  loadingDescription,
  children,
  surface,
}: ModalProps & { surface: ModalSurface }) {
  const id = useId();
  const effectiveEscapeDisabled = escapeDisabled || loading;
  const effectiveCloseOnBackdrop = closeOnBackdrop && !loading;
  const dialogRef = useModalFocus(open, onClose, initialFocusSelector, effectiveEscapeDisabled);

  if (!open) return null;

  const titleId = `${id}-title`;
  const hasDescription = description !== undefined && description !== null && description !== false && description !== true && description !== "";
  const descriptionId = hasDescription ? `${id}-description` : undefined;

  return (
    <div
      data-modal-overlay
      className={modalOverlayCls}
      onClick={(event) => {
        if (effectiveCloseOnBackdrop && event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-busy={loading ? "true" : undefined}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className={`relative ${dialogCardCls} max-h-[calc(100dvh-1.25rem)] overflow-y-auto outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 ${surfaceClassName[surface]}`}
      >
        <span id={titleId} className="sr-only">{title}</span>
        {hasDescription && <p id={descriptionId} className="sr-only">{description}</p>}
        {children}
        <LoadingOverlay
          show={loading}
          message={loadingText ?? "正在处理中，请稍候…"}
          description={loadingDescription}
        />
      </div>
    </div>
  );
}
