"use client";

import React from "react";
import { A4_HEIGHT_PX, estimatePageFitStatus } from "@/lib/resume-compression";
import type { ResumeStyle } from "@/lib/template-styles";

interface PageBreakGuideProps {
  /** 是否开启警戒线显示（默认关闭） */
  visible: boolean;
  /** 当前纸张实际高度（像素） */
  paperHeight: number;
  /** 当前生效的样式（用于更精准地估算行高与超出行数） */
  style?: Partial<ResumeStyle>;
}

/**
 * A4 分页警戒线：
 * 贴附在简历纸张（.paper）内部，在标准 A4 页面底部（297mm）绘制虚线警戒红线，
 * 并在右下角实时标注当前单页占用率与溢出行数，直观感知是否发生难看跨页。
 */
export function PageBreakGuide({ visible, paperHeight, style }: PageBreakGuideProps) {
  if (!visible) return null;

  const status = estimatePageFitStatus(paperHeight, A4_HEIGHT_PX, style);

  return (
    <div className="no-print pointer-events-none absolute inset-x-0 top-0 h-full select-none" aria-hidden>
      {/* 仅在发生跨页时，在第 1 页分页警戒处 (297mm) 显式标出虚线，单页时不压底边以防重影 */}
      {!status.isSinglePage && (
        <div
          className="absolute inset-x-0 flex items-center justify-between"
          style={{ top: "297mm", transform: "translateY(-50%)" }}
        >
          <div className="h-[1.5px] flex-1 border-t-2 border-dashed border-rose-500/80" />
          <div className="mx-3 shrink-0 rounded-full px-2.5 py-0.5 text-[11px] font-mono font-medium shadow-xs backdrop-blur-xs transition-colors bg-rose-50 text-rose-700 border border-rose-200 animate-pulse">
            <span>
              ⚠️ 发生跨页 · 溢出 {status.overflowPx}px (约 {status.overflowLines} 行)
            </span>
          </div>
          <div className="h-[1.5px] w-8 border-t-2 border-dashed border-rose-500/80" />
        </div>
      )}

      {/* 如果内容极多超过 2 页，在第 2 页 (594mm 处) 也给一条提示线 */}
      {paperHeight > A4_HEIGHT_PX * 1.5 && (
        <div
          className="absolute inset-x-0 flex items-center justify-between opacity-70"
          style={{ top: "594mm", transform: "translateY(-50%)" }}
        >
          <div className="h-[1px] flex-1 border-t border-dashed border-muted/50" />
          <span className="mx-3 rounded bg-surface/80 px-2 py-0.5 text-[10px] text-muted border border-line">
            第 2 页基准线 (594mm)
          </span>
          <div className="h-[1px] w-8 border-t border-dashed border-muted/50" />
        </div>
      )}
    </div>
  );
}
