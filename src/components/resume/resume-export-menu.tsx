"use client";

import { useEffect, useRef, useState } from "react";
import { registerEscapeLayer } from "@/lib/escape-layer";

interface ResumeExportMenuProps {
  onRequestExport: (format: "print" | "markdown" | "docx" | "anonymize" | "portfolio") => void;
}

export function ResumeExportMenu({ onRequestExport }: ResumeExportMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const unregister = registerEscapeLayer();

    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
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

  return (
    <div className="relative inline-block text-left" ref={containerRef}>
      {/* 导出触发按钮 */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        aria-haspopup="true"
        aria-expanded={isOpen}
        className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-on-primary shadow-xs transition-colors hover:bg-primary-hover focus:outline-none focus:ring-2 focus:ring-primary/30 cursor-pointer"
        title="导出当前简历或进行 A4 打印预览"
      >
        <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path
            fillRule="evenodd"
            d="M4.5 2A1.5 1.5 0 003 3.5v13A1.5 1.5 0 004.5 18h11a1.5 1.5 0 001.5-1.5V7.621a1.5 1.5 0 00-.44-1.06l-4.12-4.122A1.5 1.5 0 0011.378 2H4.5zm4.75 6.75a.75.75 0 011.5 0v3.69l1.22-1.22a.75.75 0 111.06 1.06l-2.5 2.5a.75.75 0 01-1.06 0l-2.5-2.5a.75.75 0 111.06-1.06l1.22 1.22V8.75z"
            clipRule="evenodd"
          />
        </svg>
        <span>导出 / 打印</span>
        <svg
          className={`h-3 w-3 transition-transform duration-150 ${isOpen ? "rotate-180" : ""}`}
          viewBox="0 0 20 20"
          fill="currentColor"
          aria-hidden="true"
        >
          <path
            fillRule="evenodd"
            d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {/* 下拉面板 */}
      {isOpen && (
        <div className="absolute right-0 top-full z-50 mt-1.5 w-60 origin-top-right rounded-xl border border-line bg-card p-1.5 shadow-card-float transition-all focus:outline-none">
          {/* A4 打印预览 / 导出 PDF */}
          <button
            type="button"
            onClick={() => { setIsOpen(false); onRequestExport("print"); }}
            className="flex w-full items-center gap-2.5 rounded-lg p-2 text-left text-xs font-medium text-ink transition-colors hover:bg-surface"
          >
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary">
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="6 9 6 2 18 2 18 9" />
                <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                <rect x="6" y="14" width="12" height="8" />
              </svg>
            </div>
            <div className="flex flex-col min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="font-semibold text-ink">A4 打印 / 导出 PDF</span>
                <span className="rounded bg-primary/10 px-1 text-[10px] text-primary">推荐</span>
              </div>
              <span className="text-[11px] text-muted truncate">标准无水印排版，可另存 PDF</span>
            </div>
          </button>

          <button
            type="button"
            onClick={() => { setIsOpen(false); onRequestExport("docx"); }}
            className="flex w-full items-center gap-2.5 rounded-lg p-2 text-left text-xs font-medium text-ink transition-colors hover:bg-surface"
            title="导出可编辑的 Word 文档，保留当前模板的顶栏、配色、章节样式和头像"
          >
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary">
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <path d="M8 13h8M8 17h6" />
              </svg>
            </div>
            <div className="flex flex-col min-w-0">
              <span className="font-semibold text-ink">导出 Word (.docx)</span>
              <span className="text-[11px] text-muted truncate">保留模板样式与头像，可继续编辑</span>
            </div>
          </button>

          {/* 隐私脱敏导出 */}
          <button
            type="button"
            onClick={() => {
              setIsOpen(false);
              onRequestExport("anonymize");
            }}
            className="flex w-full items-center gap-2.5 rounded-lg p-2 text-left text-xs font-medium text-ink transition-colors hover:bg-surface cursor-pointer"
          >
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-accent-wash text-accent">
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
              </svg>
            </div>
            <div className="flex flex-col min-w-0">
              <span className="font-semibold text-ink">隐私脱敏导出</span>
              <span className="text-[11px] text-muted truncate">隐藏手机邮箱，安全求职分享</span>
            </div>
          </button>

          {/* 个人作品集与静态主页 */}
          <button
            type="button"
            onClick={() => {
              setIsOpen(false);
              onRequestExport("portfolio");
            }}
            className="flex w-full items-center gap-2.5 rounded-lg p-2 text-left text-xs font-medium text-ink transition-colors hover:bg-surface cursor-pointer"
            title="生成自包含的个人作品集静态站点，带项目深度复盘与离线网页"
          >
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary">
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="2" y1="12" x2="22" y2="12" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
            </div>
            <div className="flex flex-col min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="font-semibold text-ink">个人作品集网页</span>
                <span className="rounded bg-primary/10 px-1 text-[10px] text-primary">全新</span>
              </div>
              <span className="text-[11px] text-muted truncate">深浅色主页与离线 Zip 包</span>
            </div>
          </button>

          <div className="my-1 border-t border-line/70" />

          {/* 导出 Markdown */}
          <button
            type="button"
            onClick={() => { setIsOpen(false); onRequestExport("markdown"); }}
            className="flex w-full items-center gap-2.5 rounded-lg p-2 text-left text-xs font-medium text-ink transition-colors hover:bg-surface"
          >
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface text-muted">
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="16" y1="13" x2="8" y2="13" />
                <line x1="16" y1="17" x2="8" y2="17" />
                <polyline points="10 9 9 9 8 9" />
              </svg>
            </div>
            <div className="flex flex-col min-w-0">
              <span className="font-semibold text-ink">导出 Markdown (.md)</span>
              <span className="text-[11px] text-muted truncate">纯文本内容，方便知识库导入</span>
            </div>
          </button>
        </div>
      )}
    </div>
  );
}
