"use client";

import { useState, useRef, useEffect } from "react";
import { ZOOM_PRESETS, formatZoomPercent } from "@/lib/zoom";
import { registerEscapeLayer } from "@/lib/escape-layer";

export interface ZoomControlsProps {
  scale: number;
  isAutoFit: boolean;
  canZoomIn: boolean;
  canZoomOut: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onSelectScale: (target: number) => void;
  onResetAutoFit: () => void;
  className?: string;
}

export function ZoomControls({
  scale,
  isAutoFit,
  canZoomIn,
  canZoomOut,
  onZoomIn,
  onZoomOut,
  onSelectScale,
  onResetAutoFit,
  className = "",
}: ZoomControlsProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerBtnRef = useRef<HTMLButtonElement>(null);

  // 点击外部关闭下拉菜单或按 ESC 键收起浮层
  useEffect(() => {
    if (!menuOpen) return;
    const unregister = registerEscapeLayer();
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setMenuOpen(false);
        triggerBtnRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      unregister();
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  const percentText = formatZoomPercent(scale);

  return (
    <div
      ref={containerRef}
      className={`relative inline-flex items-center rounded-lg border border-line bg-card p-0.5 shadow-xs ${className}`}
    >
      {/* 缩小按钮 */}
      <button
        type="button"
        disabled={!canZoomOut}
        onClick={onZoomOut}
        className="flex h-7 w-7 items-center justify-center rounded text-muted transition-colors hover:bg-surface hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted cursor-pointer disabled:cursor-not-allowed"
        title="缩小 (或 Ctrl + 滚轮向下)"
        aria-label="缩小预览"
      >
        <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
          <path
            fillRule="evenodd"
            d="M4 10a.75.75 0 01.75-.75h10.5a.75.75 0 010 1.5H4.75A.75.75 0 014 10z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {/* 中间百分比/模式下拉触发器 */}
      <button
        ref={triggerBtnRef}
        type="button"
        aria-label="选择缩放比例"
        onClick={() => setMenuOpen((prev) => !prev)}
        className="flex h-7 items-center gap-1 px-1.5 rounded text-xs font-mono font-medium text-ink transition-colors hover:bg-surface cursor-pointer"
        title="选择缩放比例 (支持 Ctrl + 滚轮缩放，Ctrl / 空格 / 空白区拖拽平移)"
        aria-haspopup="listbox"
        aria-expanded={menuOpen}
      >
        <span className="min-w-[42px] text-center">
          {isAutoFit ? `自适应 (${percentText})` : percentText}
        </span>
        <svg
          className={`h-2.5 w-2.5 text-muted transition-transform ${menuOpen ? "rotate-180" : ""}`}
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path
            fillRule="evenodd"
            d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {/* 放大按钮 */}
      <button
        type="button"
        disabled={!canZoomIn}
        onClick={onZoomIn}
        className="flex h-7 w-7 items-center justify-center rounded text-muted transition-colors hover:bg-surface hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted cursor-pointer disabled:cursor-not-allowed"
        title="放大 (或 Ctrl + 滚轮向上)"
        aria-label="放大预览"
      >
        <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
          <path
            d="M10.75 4.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z"
          />
        </svg>
      </button>

      {/* 预设档位菜单 */}
      {menuOpen && (
        <div
          role="listbox"
          className="absolute left-1/2 top-full z-30 mt-1 min-w-[130px] -translate-x-1/2 rounded-xl border border-line bg-card p-1 shadow-card-float text-xs"
        >
          <button
            type="button"
            role="option"
            aria-selected={isAutoFit}
            onClick={() => {
              onResetAutoFit();
              setMenuOpen(false);
            }}
            className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 transition-colors cursor-pointer ${
              isAutoFit ? "bg-primary/10 font-medium text-primary" : "text-ink hover:bg-surface"
            }`}
          >
            <span>适应宽度 (默认)</span>
            {isAutoFit && (
              <svg className="h-3.5 w-3.5 text-primary" viewBox="0 0 20 20" fill="currentColor">
                <path
                  fillRule="evenodd"
                  d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                  clipRule="evenodd"
                />
              </svg>
            )}
          </button>

          <div className="my-1 border-t border-line" />

          {ZOOM_PRESETS.map((preset) => {
            const isCurrent = !isAutoFit && Math.abs(scale - preset) < 0.01;
            return (
              <button
                key={preset}
                type="button"
                role="option"
                aria-selected={isCurrent}
                onClick={() => {
                  onSelectScale(preset);
                  setMenuOpen(false);
                }}
                className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 font-mono transition-colors cursor-pointer ${
                  isCurrent ? "bg-primary/10 font-medium text-primary" : "text-ink hover:bg-surface"
                }`}
              >
                <span>{formatZoomPercent(preset)}</span>
                {isCurrent && (
                  <svg className="h-3.5 w-3.5 text-primary" viewBox="0 0 20 20" fill="currentColor">
                    <path
                      fillRule="evenodd"
                      d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
