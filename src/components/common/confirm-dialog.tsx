"use client";

import { useEffect, useId, useState } from "react";
import { btnDangerSolid, btnGhost, btnPrimary } from "@/lib/ui";
import { useModalFocus } from "@/hooks/use-modal-focus";

export type ConfirmOptions = {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
};

type Pending =
  | (ConfirmOptions & { kind: "confirm"; resolve: (ok: boolean) => void })
  | { kind: "alert"; title?: string; message: string; confirmText?: string; resolve: () => void };

let push: ((p: Pending | null) => void) | null = null;
/** 正在展示的那一条，与宿主的 pending state 同步 */
let current: Pending | null = null;
/** 同一 tick 内到达的后续请求排队等待，逐个呈现 */
const waiting: Pending[] = [];

function settle(item: Pending, ok: boolean): void {
  if (item.kind === "confirm") item.resolve(ok);
  else item.resolve();
}

function enqueue(item: Pending): void {
  if (!push) {
    settle(item, false);
    return;
  }
  if (current) {
    waiting.push(item);
    return;
  }
  current = item;
  push(item);
}

/** 结算当前项并呈现队列中的下一项；队列空则关闭弹窗 */
function advance(ok: boolean): void {
  if (!current) return;
  settle(current, ok);
  current = waiting.shift() ?? null;
  push?.(current);
}

/** 自定义确认弹窗（替代 window.confirm），在 ConfirmDialogHost 中渲染 */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    enqueue({ kind: "confirm", ...opts, resolve });
  });
}

/** 自定义提示弹窗（替代 window.alert） */
export function alertDialog(opts: { title?: string; message: string }): Promise<void> {
  return new Promise((resolve) => {
    enqueue({ kind: "alert", ...opts, resolve: () => resolve() });
  });
}

/** 挂在根布局的全局弹窗宿主 */
export function ConfirmDialogHost() {
  const [pending, setPending] = useState<Pending | null>(null);
  const dialogId = useId();
  const dialogRef = useModalFocus(Boolean(pending), () => close(false));

  useEffect(() => {
    push = setPending;
    return () => {
      push = null;
      // 卸载时结算全部未完成请求，避免调用方永久悬挂
      const leftover = waiting.splice(0, waiting.length);
      if (current) leftover.unshift(current);
      current = null;
      for (const item of leftover) settle(item, false);
    };
  }, []);

  function close(result: boolean) {
    advance(result);
  }

  if (!pending) return null;

  const danger = pending.kind === "confirm" && pending.danger;
  const confirmText = pending.confirmText ?? (danger ? "删除" : "确定");

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${dialogId}-title`}
      aria-describedby={`${dialogId}-message`}
      className="overlay-in fixed inset-0 z-[10000] flex items-center justify-center bg-overlay p-3 sm:p-4 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur-[2px]"
      onClick={() => close(false)}
    >
      <div
        className="dialog-in w-full max-w-sm rounded-2xl border border-line bg-card p-5 sm:p-6 shadow-card-float max-h-[90dvh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id={`${dialogId}-title`} className={pending.title ? "font-serif text-base font-bold text-ink" : "sr-only"}>
          {pending.title ?? (pending.kind === "confirm" ? "请确认" : "提示")}
        </h2>
        <p id={`${dialogId}-message`} className={`text-sm leading-relaxed text-muted ${pending.title ? "mt-2" : ""}`}>
          {pending.message}
        </p>
        <div className="mt-6 flex flex-col-reverse sm:flex-row sm:justify-end gap-2 sm:gap-2.5 [&>button]:w-full sm:[&>button]:w-auto">
          {pending.kind === "confirm" && (
            <button className={btnGhost} onClick={() => close(false)}>
              {pending.cancelText ?? "取消"}
            </button>
          )}
          <button
            className={danger ? btnDangerSolid : btnPrimary}
            onClick={() => close(true)}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
