"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 剪贴板写入是异步的，且会因权限、非安全上下文或用户手势丢失而被拒绝。
 * 统一在此 await 并捕获失败，同时把「已复制」提示的定时器纳入卸载清理，
 * 避免未处理的 Promise 拒绝和卸载后 setState。
 */
export function useCopyFeedback(resetDelayMs = 2000): {
  copiedText: string | null;
  copy: (text: string) => Promise<boolean>;
} {
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    []
  );

  const copy = useCallback(
    async (text: string): Promise<boolean> => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        return false;
      }
      setCopiedText(text);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => setCopiedText(null), resetDelayMs);
      return true;
    },
    [resetDelayMs]
  );

  return { copiedText, copy };
}
