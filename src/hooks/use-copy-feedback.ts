"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 剪贴板写入是异步的，且会因权限、非安全上下文或用户手势丢失而被拒绝。
 * 每次尝试先清除旧成功提示；在途写入互斥，避免两次完成顺序不同而误报复制内容。
 * 失败反馈保留原文供页面就近展示；卸载后的完成不更新状态或启动定时器。
 */
export function useCopyFeedback(resetDelayMs = 2000): {
  copiedText: string | null;
  copyError: { text: string; message: string } | null;
  copying: boolean;
  copy: (text: string) => Promise<boolean>;
} {
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<{ text: string; message: string } | null>(null);
  const [copying, setCopying] = useState(false);
  const timerRef = useRef<number | null>(null);
  const pendingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(
    () => {
      mountedRef.current = true;
      return () => {
        mountedRef.current = false;
        if (timerRef.current !== null) window.clearTimeout(timerRef.current);
        timerRef.current = null;
      };
    },
    []
  );

  const copy = useCallback(
    async (text: string): Promise<boolean> => {
      if (!mountedRef.current || pendingRef.current) return false;
      pendingRef.current = true;
      setCopying(true);
      setCopiedText(null);
      setCopyError(null);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = null;
      try {
        await navigator.clipboard.writeText(text);
        if (!mountedRef.current) return false;
        setCopiedText(text);
        timerRef.current = window.setTimeout(() => {
          timerRef.current = null;
          setCopiedText(null);
        }, resetDelayMs);
        return true;
      } catch {
        if (mountedRef.current) setCopyError({ text, message: "复制失败，请检查浏览器剪贴板权限；也可以选中文字手动复制。" });
        return false;
      } finally {
        pendingRef.current = false;
        if (mountedRef.current) setCopying(false);
      }
    },
    [resetDelayMs]
  );

  return { copiedText, copyError, copying, copy };
}
