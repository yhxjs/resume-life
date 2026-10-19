"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "@/lib/reduced-motion";

export function useTypewriter(options?: {
  defaultCps?: number; // 默认每秒输出字符数（Characters Per Second）
  onFinished?: () => void;
}) {
  const [displayedText, setDisplayedText] = useState("");
  const [isTyping, setIsTyping] = useState(false);

  const queueRef = useRef<string[]>([]);
  const isStreamingRef = useRef(false);
  const rafIdRef = useRef<number | null>(null);
  const lastTickRef = useRef<number>(0);
  const tickRef = useRef<((timestamp: number) => void) | null>(null);

  const tick = useCallback(
    (timestamp: number) => {
      if (!lastTickRef.current) lastTickRef.current = timestamp;
      const elapsed = timestamp - lastTickRef.current;

      // 系统要求减少动效时，不逐字吐字：单帧内吐出全部积压，随后正常收尾
      const reduced = prefersReducedMotion();
      const queueLength = queueRef.current.length;
      // 动态步长：队列积压越长，单帧吐字越多以追赶真实进度
      const step = reduced ? queueLength : queueLength > 80 ? 4 : queueLength > 30 ? 2 : 1;
      const interval = reduced ? 0 : 1000 / (options?.defaultCps ?? 45);

      if (queueRef.current.length > 0 && elapsed >= interval) {
        const take = queueRef.current.splice(0, step).join("");
        setDisplayedText((prev) => prev + take);
        lastTickRef.current = timestamp;
      }

      if (queueRef.current.length > 0 || isStreamingRef.current) {
        rafIdRef.current = requestAnimationFrame((ts) => tickRef.current?.(ts));
      } else {
        setIsTyping(false);
        options?.onFinished?.();
      }
    },
    [options]
  );

  useEffect(() => {
    tickRef.current = tick;
  }, [tick]);

  const appendDelta = useCallback(
    (delta: string) => {
      if (!delta) return;
      isStreamingRef.current = true;
      setIsTyping(true);
      for (const char of delta) {
        queueRef.current.push(char);
      }
      if (rafIdRef.current === null) {
        rafIdRef.current = requestAnimationFrame((ts) => tickRef.current?.(ts));
      }
    },
    []
  );

  const flush = useCallback(() => {
    if (queueRef.current.length > 0) {
      const remaining = queueRef.current.join("");
      queueRef.current = [];
      setDisplayedText((prev) => prev + remaining);
    }
    isStreamingRef.current = false;
    setIsTyping(false);
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
  }, []);

  const reset = useCallback((initialText = "") => {
    queueRef.current = [];
    isStreamingRef.current = false;
    setIsTyping(false);
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    setDisplayedText(initialText);
  }, []);

  const markDone = useCallback(() => {
    isStreamingRef.current = false;
  }, []);

  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, []);

  return {
    displayedText,
    isTyping,
    appendDelta,
    flush,
    reset,
    markDone,
  };
}
