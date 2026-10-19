"use client";

import { useCallback, useEffect, useRef } from "react";

export function useAutoScroll<T extends HTMLElement = HTMLDivElement>(
  dependency: unknown,
  options?: { threshold?: number }
) {
  const elementRef = useRef<T | null>(null);
  const isAtBottomRef = useRef(true);
  const threshold = options?.threshold ?? 30;

  const updateIsAtBottom = useCallback(
    (el: T) => {
      const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      isAtBottomRef.current = distanceToBottom <= threshold;
    },
    [threshold]
  );

  const handleScroll = useCallback(() => {
    if (elementRef.current) {
      updateIsAtBottom(elementRef.current);
    }
  }, [updateIsAtBottom]);

  const containerRef = useCallback(
    (node: T | null) => {
      if (elementRef.current) {
        elementRef.current.removeEventListener("scroll", handleScroll);
      }
      elementRef.current = node;
      if (node) {
        updateIsAtBottom(node);
        node.addEventListener("scroll", handleScroll, { passive: true });
      }
    },
    [handleScroll, updateIsAtBottom]
  );

  useEffect(() => {
    const el = elementRef.current;
    if (!el) return;
    if (isAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [dependency]);

  const scrollToBottom = useCallback(() => {
    isAtBottomRef.current = true;
    if (elementRef.current) {
      elementRef.current.scrollTop = elementRef.current.scrollHeight;
    }
  }, []);

  return { containerRef, handleScroll, scrollToBottom };
}
