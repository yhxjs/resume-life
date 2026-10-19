"use client";

import { useEffect, useEffectEvent, useRef } from "react";

export function useDebouncedSearch<T>({
  queryKey,
  delay,
  load,
  onSuccess,
  onError,
  onStart,
  onEmpty,
}: {
  queryKey: string;
  delay: number;
  load: (signal: AbortSignal) => Promise<T>;
  onSuccess: (value: T) => void;
  onError: (error: Error) => void;
  onStart?: () => void;
  onEmpty?: () => void;
}): void {
  const sequence = useRef(0);
  const loadEvent = useEffectEvent(load);
  const successEvent = useEffectEvent(onSuccess);
  const errorEvent = useEffectEvent(onError);
  const startEvent = useEffectEvent(() => onStart?.());
  const emptyEvent = useEffectEvent(() => onEmpty?.());

  useEffect(() => {
    const requestSequence = ++sequence.current;
    const controller = new AbortController();

    if (!queryKey) {
      emptyEvent();
      return () => {
        controller.abort();
      };
    }

    // 每次 queryKey 改变，重新开启 delay 毫秒的计时
    // 只有在用户停止输入 delay 毫秒后，才真正触发搜索
    const timer = window.setTimeout(async () => {
      if (requestSequence !== sequence.current) return;

      startEvent();
      try {
        const value = await loadEvent(controller.signal);
        if (controller.signal.aborted || requestSequence !== sequence.current) return;
        successEvent(value);
      } catch (reason) {
        if (controller.signal.aborted || (reason instanceof Error && reason.name === "AbortError")) return;
        if (requestSequence === sequence.current) {
          errorEvent(reason instanceof Error ? reason : new Error(String(reason)));
        }
      }
    }, delay);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [delay, queryKey]);
}
