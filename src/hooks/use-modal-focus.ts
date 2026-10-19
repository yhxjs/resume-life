"use client";

import { useEffect, useEffectEvent, useRef } from "react";
import { hasOpenEscapeLayer } from "@/lib/escape-layer";

const focusableSelector = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable]:not([contenteditable="false"]):not([tabindex="-1"]):not([aria-disabled="true"])';
const activeModals: HTMLElement[] = [];
let bodyOverflowBeforeLock: string | null = null;

/** 统一弹层的首焦点、焦点围栏、Escape、滚动锁与触发元素焦点归还。 */
export function useModalFocus(
  open: boolean,
  onClose: () => void,
  initialSelector?: string,
  escapeDisabled = false
) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useEffectEvent(onClose);
  const isEscapeDisabled = useEffectEvent(() => escapeDisabled);

  useEffect(() => {
    const element = ref.current;
    if (!open || !element) return;
    const dialog: HTMLDivElement = element;
    const previous = document.activeElement as HTMLElement | null;

    if (activeModals.length === 0) {
      bodyOverflowBeforeLock = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    activeModals.push(dialog);

    const isTop = () => activeModals.at(-1) === dialog;
    const controls = () => Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector))
      .filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden");
    const first = () => controls()[0] ?? dialog;
    const initial = initialSelector ? controls().find((element) => element.matches(initialSelector)) : null;
    (initial ?? first()).focus();

    function onKey(event: KeyboardEvent) {
      if (!isTop()) return;
      if (event.key === "Escape") {
        // 内层浮层（如展开的 Combobox）优先消费 Escape：放行后事件才会到达它，
        // 否则会在捕获阶段被拦下，连承载用户输入的模态一起关掉
        if (hasOpenEscapeLayer()) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!isEscapeDisabled()) close();
      } else if (event.key === "Tab") {
        const elements = controls();
        const start = elements[0] ?? dialog;
        const end = elements.at(-1) ?? dialog;
        const current = document.activeElement;
        if (!dialog.contains(current) || current === dialog || (event.shiftKey ? current === start : current === end)) {
          event.preventDefault();
          (event.shiftKey ? end : start).focus();
        }
      }
    }

    function onFocus(event: FocusEvent) {
      if (isTop() && !dialog.contains(event.target as Node)) first().focus();
    }

    document.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocus);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocus);
      // 边界判断：lastIndexOf 返回 -1 时 splice(-1, 1) 会误删栈顶的另一个弹层
      const index = activeModals.lastIndexOf(dialog);
      if (index !== -1) activeModals.splice(index, 1);
      if (activeModals.length === 0) {
        document.body.style.overflow = bodyOverflowBeforeLock ?? "";
        bodyOverflowBeforeLock = null;
      }
      if (previous?.isConnected) previous.focus();
    };
  }, [open, initialSelector]);

  return ref;
}
