"use client";

import { type ReactNode } from "react";

export interface LoadingOverlayProps {
  /** 是否展示遮罩，默认 true */
  show?: boolean;
  /** 加载标题 / 主提示文案 */
  message?: ReactNode;
  /** 次级说明信息（如“请勿关闭浏览器窗口”等） */
  description?: ReactNode;
  /** 是否使用全屏固定遮罩（默认在当前 relative 父容器内撑满绝对定位） */
  fullScreen?: boolean;
  /** 额外的容器类名 */
  className?: string;
  role?: string;
  "aria-live"?: "polite" | "assertive" | "off";
  /** 取消操作回调（当提供时在遮罩卡片内渲染取消按钮） */
  onCancel?: () => void;
  /** 取消按钮文案，默认“取消” */
  cancelText?: string;
}

/**
 * 局部/全屏加载中遮罩组件：
 * 采用设计令牌与半透明磨砂质感，自带无障碍属性并阻断下层点击。
 */
export function LoadingOverlay({
  show = true,
  message = "正在处理中，请稍候…",
  description,
  fullScreen = false,
  className = "",
  role = "status",
  "aria-live": ariaLive = "polite",
  onCancel,
  cancelText = "取消",
}: LoadingOverlayProps) {
  if (!show) return null;

  return (
    <div
      role={role}
      aria-live={ariaLive}
      aria-busy="true"
      onClick={(e) => e.stopPropagation()}
      className={`${
        fullScreen ? "fixed inset-0 z-50" : "absolute inset-0 z-20 rounded-[inherit]"
      } flex items-center justify-center p-4 bg-card/80 backdrop-blur-[2px] transition-all animate-in fade-in duration-150 ${className}`}
    >
      <div className="flex flex-col items-center justify-center text-center max-w-sm rounded-2xl border border-line bg-surface/95 px-6 py-5 shadow-card-float space-y-3 select-none pointer-events-auto">
        <svg
          className="h-8 w-8 animate-spin text-primary shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          aria-hidden="true"
        >
          <circle
            className="opacity-20 stroke-current"
            cx="12"
            cy="12"
            r="10"
            strokeWidth="3"
          />
          <path
            className="opacity-90 fill-current"
            d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
          />
        </svg>

        {message && (
          <p className="font-serif text-sm font-bold text-ink leading-snug">
            {message}
          </p>
        )}

        {description && (
          <p className="text-xs text-muted leading-relaxed text-pretty">
            {description}
          </p>
        )}

        {onCancel && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onCancel();
            }}
            className="mt-1 inline-flex items-center justify-center rounded-lg border border-line-strong bg-card px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-surface active:bg-surface-2 cursor-pointer"
          >
            {cancelText}
          </button>
        )}
      </div>
    </div>
  );
}
