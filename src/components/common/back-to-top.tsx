"use client";

import React, { useEffect, useState, useCallback } from "react";
import { motionSafeScrollBehavior } from "@/lib/reduced-motion";

export interface BackToTopProps {
  /** 触发显示的滚动距离阈值（px），默认 300 */
  threshold?: number;
  /** 滚动目标，默认为 window；可传入特定容器的 Ref、HTMLElement 或 CSS 选择器 */
  target?: React.RefObject<HTMLElement | null> | HTMLElement | string | null;
  /** 自定义类名（覆盖定位、间距、z-index 等） */
  className?: string;
  /** 是否平滑滚动，默认 true（受 prefers-reduced-motion 保护） */
  smooth?: boolean;
  /** 无障碍标签与提示文字，默认 "返回顶部" */
  ariaLabel?: string;
  /** 自定义内容（不传时默认渲染向上箭头 SVG 图标） */
  children?: React.ReactNode;
  /** 点击回到顶部后的回调函数 */
  onScrollTop?: () => void;
}

export function BackToTop({
  threshold = 300,
  target,
  className = "",
  smooth = true,
  ariaLabel = "返回顶部",
  children,
  onScrollTop,
}: BackToTopProps) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const resolveTargetElement = (): HTMLElement | null => {
      if (!target) return null;
      if (typeof target === "string") {
        return document.querySelector<HTMLElement>(target);
      }
      if ("current" in target) {
        return target.current;
      }
      return target;
    };

    const targetEl = resolveTargetElement();

    const getScrollTop = () => {
      if (targetEl) {
        return targetEl.scrollTop;
      }
      return (
        window.scrollY ||
        document.documentElement.scrollTop ||
        document.body.scrollTop ||
        0
      );
    };

    const handleScroll = () => {
      const scrollTop = getScrollTop();
      setVisible(scrollTop > threshold);
    };

    // 初始化时同步当前滚动状态
    handleScroll();

    const listenerTarget: EventTarget = targetEl || window;
    listenerTarget.addEventListener("scroll", handleScroll, { passive: true });

    return () => {
      listenerTarget.removeEventListener("scroll", handleScroll);
    };
  }, [target, threshold]);

  const scrollToTop = useCallback(() => {
    const resolveTargetElement = (): HTMLElement | null => {
      if (!target) return null;
      if (typeof target === "string") {
        return document.querySelector<HTMLElement>(target);
      }
      if ("current" in target) {
        return target.current;
      }
      return target;
    };

    const targetEl = resolveTargetElement();
    const behavior: ScrollBehavior = smooth ? motionSafeScrollBehavior() : "auto";

    if (targetEl) {
      targetEl.scrollTo({ top: 0, behavior });
    } else if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, behavior });
    }

    onScrollTop?.();
  }, [target, smooth, onScrollTop]);

  const hasCustomPosition = Boolean(className && /\b(top-|bottom-|right-|left-)\b/.test(className));
  const positionCls = hasCustomPosition
    ? ""
    : "right-10 bottom-16 sm:right-14 sm:bottom-20 md:right-16 md:bottom-24 lg:right-20 lg:bottom-28";

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={ariaLabel}
      aria-hidden={!visible}
      tabIndex={visible ? 0 : -1}
      onClick={scrollToTop}
      className={`group fixed z-40 flex h-10 w-10 sm:h-11 sm:w-11 items-center justify-center rounded-full border border-line bg-card/90 text-muted shadow-card-float backdrop-blur-xs transition-all duration-200 hover:border-line-strong hover:bg-surface hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary cursor-pointer active:scale-95 ${positionCls} ${
        visible
          ? "opacity-100 translate-y-0 pointer-events-auto"
          : "opacity-0 translate-y-3 pointer-events-none"
      } ${className}`}
    >
      {children ?? (
        <svg
          className="h-5 w-5 transition-transform duration-200 group-hover:-translate-y-0.5"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 19V5M5 12l7-7 7 7" />
        </svg>
      )}
    </button>
  );
}
