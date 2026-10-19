"use client";

import React, { useEffect, useId, useRef, useState } from "react";
import type { ResumeStyle } from "@/lib/template-styles";
import type { ResumeStyleOverrides } from "@/lib/templates";
import { calculateAutoFitOverrides, estimatePageFitStatus, A4_HEIGHT_PX } from "@/lib/resume-compression";
import { registerEscapeLayer } from "@/lib/escape-layer";

interface SpacingTuningPopoverProps {
  /** 当前生效的完整样式（包含 base 与 overrides） */
  currentStyle: ResumeStyle;
  /** 当前基准样式（未加 overrides 的模板默认值） */
  baseStyle: ResumeStyle;
  /** 当前已有的样式覆盖 */
  overrides: ResumeStyleOverrides;
  /** 纸张 DOM 实际测量高度 */
  paperHeight: number;
  /** 是否开启 A4 分页警戒线 */
  showPageBreakGuide: boolean;
  /** 切换分页警戒线开关 */
  onTogglePageBreakGuide: (show: boolean) => void;
  /** 实时更新样式覆盖参数 */
  onUpdateOverrides: (overrides: ResumeStyleOverrides | null) => void;
}

export function SpacingTuningPopover({
  currentStyle,
  baseStyle,
  overrides,
  paperHeight,
  showPageBreakGuide,
  onTogglePageBreakGuide,
  onUpdateOverrides,
}: SpacingTuningPopoverProps) {
  const [isOpen, setIsOpen] = useState(false);
  const sliderId = useId();
  const popoverRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const status = estimatePageFitStatus(paperHeight, A4_HEIGHT_PX, currentStyle);
  const hasOverrides = Object.keys(overrides).length > 0;

  // 点击外部或按 ESC 键关闭弹层
  useEffect(() => {
    if (!isOpen) return;
    const unregister = registerEscapeLayer();
    function handleClickOutside(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      unregister();
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  // 一键单页自适应压缩：只覆盖压缩涉及的间距字段，保留用户已调整的其余样式
  function handleAutoFit() {
    const calculated = calculateAutoFitOverrides(baseStyle, paperHeight, A4_HEIGHT_PX);
    onUpdateOverrides({ ...overrides, ...calculated });
  }

  // 重置回模板默认样式
  function handleReset() {
    onUpdateOverrides(null);
  }

  function updateField<K extends keyof ResumeStyleOverrides>(key: K, value: ResumeStyleOverrides[K]) {
    onUpdateOverrides({
      ...overrides,
      [key]: value,
    });
  }

  return (
    <div className="relative inline-block" ref={popoverRef}>
      {/* 顶部工具栏紧凑触发按钮 */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className={`relative inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium border transition-colors ${
          isOpen
            ? "border-primary bg-primary/10 text-primary"
            : hasOverrides
              ? "border-primary/40 bg-primary/5 text-primary hover:bg-primary/10"
              : "border-line bg-card text-muted hover:text-ink hover:bg-surface"
        }`}
        title="调整简历间距、行高、页边距，或一键自适应压缩至单页 A4"
      >
        <span>📐</span>
        <span>排版微调</span>
        {!status.isSinglePage && (
          <span className="rounded bg-rose-100 px-1 text-[10px] text-rose-700 font-mono">
            +{status.overflowLines}行
          </span>
        )}
        {hasOverrides && (
          <span className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full border border-card bg-primary" />
        )}
      </button>

      {/* 紧凑下拉弹层 */}
      {isOpen && (
        <div className="absolute left-0 top-full z-40 mt-1.5 w-76 rounded-xl border border-line bg-card p-3.5 shadow-xl backdrop-blur-md animate-in fade-in zoom-in-95 duration-100">
          <div className="mb-3 flex items-center justify-between border-b border-line pb-2.5">
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-semibold text-ink">单页自适应与微调</span>
              {status.isSinglePage ? (
                <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700 border border-emerald-200">
                  单页 {status.heightPercent}%
                </span>
              ) : (
                <span className="rounded-full bg-rose-50 px-2 py-0.5 text-[10px] font-medium text-rose-700 border border-rose-200">
                  跨页 +{status.overflowLines}行
                </span>
              )}
            </div>
            {hasOverrides && (
              <button
                type="button"
                onClick={handleReset}
                className="text-[11px] text-muted hover:text-danger transition-colors underline"
              >
                重置
              </button>
            )}
          </div>

          {/* 一键单页压缩按钮 */}
          <div className="mb-3">
            <button
              type="button"
              onClick={handleAutoFit}
              disabled={status.isSinglePage}
              className={`w-full flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-medium shadow-xs transition-all ${
                status.isSinglePage
                  ? "bg-surface text-faint border border-line cursor-not-allowed"
                  : "bg-primary text-on-primary hover:bg-primary/90 active:scale-[0.99]"
              }`}
            >
              <span>🪄</span>
              <span>{status.isSinglePage ? "已收纳在单页内" : "一键压缩至单页 A4"}</span>
            </button>
            <p className="mt-1 text-[11px] text-faint">
              智能渐进压缩模块间距、条目间距、边距及行高，告别跨页 2-3 行。
            </p>
          </div>

          {/* A4 分页警戒线开关（默认关闭） */}
          <div className="mb-3 flex items-center justify-between rounded-lg border border-line/80 bg-surface/40 px-2.5 py-1.5">
            <label htmlFor="page-break-toggle" className="text-xs text-muted cursor-pointer select-none">
              A4 分页警戒红线
            </label>
            <input
              id="page-break-toggle"
              type="checkbox"
              checked={showPageBreakGuide}
              onChange={(e) => onTogglePageBreakGuide(e.target.checked)}
              className="h-4 w-4 rounded border-line text-primary focus:ring-primary/20 cursor-pointer"
            />
          </div>

          {/* 细粒度间距微调滑块 */}
          <div className="space-y-2.5 border-t border-line pt-2.5 text-xs">
            {/* 模块间距 (sectionGapBefore) */}
            <div>
              <div className="flex justify-between text-muted mb-1 text-[11px]">
                <label htmlFor={`${sliderId}-section-gap`}>模块间距</label>
                <span className="font-mono text-ink">{currentStyle.sectionGapBefore}px</span>
              </div>
              <input
                id={`${sliderId}-section-gap`}
                type="range"
                min="4"
                max="24"
                step="1"
                value={currentStyle.sectionGapBefore}
                onChange={(e) => updateField("sectionGapBefore", Number(e.target.value))}
                className="w-full h-1.5 bg-surface rounded-lg appearance-none cursor-pointer accent-primary"
              />
            </div>

            {/* 条目间距 (entryGap) */}
            <div>
              <div className="flex justify-between text-muted mb-1 text-[11px]">
                <label htmlFor={`${sliderId}-entry-gap`}>经历条目间距</label>
                <span className="font-mono text-ink">{currentStyle.entryGap}px</span>
              </div>
              <input
                id={`${sliderId}-entry-gap`}
                type="range"
                min="4"
                max="20"
                step="1"
                value={currentStyle.entryGap}
                onChange={(e) => updateField("entryGap", Number(e.target.value))}
                className="w-full h-1.5 bg-surface rounded-lg appearance-none cursor-pointer accent-primary"
              />
            </div>

            {/* 页面边距 (pageMargin) */}
            <div>
              <div className="flex justify-between text-muted mb-1 text-[11px]">
                <label htmlFor={`${sliderId}-page-margin`}>页面边距 (上下左右)</label>
                <span className="font-mono text-ink">{currentStyle.pageMargin}mm</span>
              </div>
              <input
                id={`${sliderId}-page-margin`}
                type="range"
                min="8"
                max="22"
                step="1"
                value={currentStyle.pageMargin}
                onChange={(e) => updateField("pageMargin", Number(e.target.value))}
                className="w-full h-1.5 bg-surface rounded-lg appearance-none cursor-pointer accent-primary"
              />
            </div>

            {/* 正文行高 (lineHeight) */}
            <div>
              <div className="flex justify-between text-muted mb-1 text-[11px]">
                <label htmlFor={`${sliderId}-line-height`}>正文行高</label>
                <span className="font-mono text-ink">{currentStyle.lineHeight}</span>
              </div>
              <input
                id={`${sliderId}-line-height`}
                type="range"
                min="1.25"
                max="1.80"
                step="0.05"
                value={currentStyle.lineHeight}
                onChange={(e) => updateField("lineHeight", Number(e.target.value))}
                className="w-full h-1.5 bg-surface rounded-lg appearance-none cursor-pointer accent-primary"
              />
            </div>

            {/* 正文字号 (baseSize) */}
            <div>
              <div className="flex justify-between text-muted mb-1 text-[11px]">
                <label htmlFor={`${sliderId}-base-size`}>正文字号</label>
                <span className="font-mono text-ink">{currentStyle.baseSize}px</span>
              </div>
              <input
                id={`${sliderId}-base-size`}
                type="range"
                min="10"
                max="14"
                step="0.5"
                value={currentStyle.baseSize}
                onChange={(e) => updateField("baseSize", Number(e.target.value))}
                className="w-full h-1.5 bg-surface rounded-lg appearance-none cursor-pointer accent-primary"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
