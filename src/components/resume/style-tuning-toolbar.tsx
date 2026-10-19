"use client";

import { useEffect, useRef, useState } from "react";
import { jsonFetch } from "@/lib/fetcher";
import { errorMessage } from "@/lib/error-message";
import { RESUME_TEMPLATES, type CustomTemplate, type ResumeStyle, type ResumeStyleOverrides } from "@/lib/templates";
import { StyleFieldGroups } from "@/app/styles/style-field-groups";
import { registerEscapeLayer } from "@/lib/escape-layer";

interface StyleTuningToolbarProps {
  /** 当前生效的完整样式（模板预设 + overrides 叠加） */
  currentStyle: ResumeStyle;
  /** 当前已有的样式覆盖 */
  overrides: ResumeStyleOverrides;
  /** 简历当前引用的模板（内置 key 或 custom:<id>），用于建议模板名与展示基准 */
  template: string;
  /** 自定义模板列表（解析 custom 引用的名称） */
  customs: CustomTemplate[];
  /** 实时更新样式覆盖参数；传 null 表示重置回模板默认 */
  onUpdateOverrides: (overrides: ResumeStyleOverrides | null) => void;
  /** 另存模板成功后通知外层刷新自定义模板列表 */
  onTemplatesChanged?: () => void;
  /** 可选：当前简历中的实际模块列表，用于侧栏分流 */
  availableModules?: { key: string; label: string }[];
}

/** 悬浮在预览左侧的样式调整工具栏：点击展开全字段样式面板，并支持把当前样式另存为模板 */
export function StyleTuningToolbar({
  currentStyle,
  overrides,
  template,
  customs,
  onUpdateOverrides,
  onTemplatesChanged,
  availableModules,
}: StyleTuningToolbarProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [tplName, setTplName] = useState("");
  const [savingTpl, setSavingTpl] = useState(false);
  const [tplNote, setTplNote] = useState<{ ok: boolean; text: string } | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const triggerBtnRef = useRef<HTMLButtonElement>(null);

  const customMatch = /^custom:(\d+)$/.exec(template);
  const baseTemplateName =
    customMatch
      ? customs.find((c) => c.id === Number(customMatch[1]))?.name
      : RESUME_TEMPLATES.find((t) => t.key === template)?.label;
  const suggestedName = baseTemplateName ? `${baseTemplateName}·定制` : "";
  const hasOverrides = Object.keys(overrides).length > 0;

  // 点击外部或按 Escape 关闭弹层
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
        triggerBtnRef.current?.focus();
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

  function toggleOpen() {
    if (!isOpen && !tplName && suggestedName) setTplName(suggestedName);
    setIsOpen(!isOpen);
  }

  function handleReset() {
    onUpdateOverrides(null);
    setTplNote(null);
  }

  function writeStyle<K extends keyof ResumeStyle>(key: K, value: ResumeStyle[K]) {
    onUpdateOverrides({ ...overrides, [key]: value });
  }

  async function handleSaveTemplate() {
    const name = tplName.trim();
    if (!name || savingTpl) return;
    setSavingTpl(true);
    setTplNote(null);
    try {
      const created = await jsonFetch<CustomTemplate>("/api/templates", {
        method: "POST",
        body: JSON.stringify({ name, style: currentStyle }),
      });
      setTplNote({ ok: true, text: `已保存为模板「${created.name}」，可在模板下拉中选用` });
      onTemplatesChanged?.();
    } catch (error) {
      setTplNote({ ok: false, text: `保存失败：${errorMessage(error)}` });
    } finally {
      setSavingTpl(false);
    }
  }

  return (
    <div className="no-print relative" ref={popoverRef}>
      {/* 悬浮胶囊按钮：位于大纲排序下方 */}
      <button
        ref={triggerBtnRef}
        type="button"
        onClick={toggleOpen}
        title="调整简历样式：布局、配色、字体、页眉、小节与条目，并可另存为样式模板"
        className={`group relative flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium shadow-md backdrop-blur-md transition-all duration-200 select-none cursor-pointer ${
          isOpen
            ? "border-primary bg-primary text-on-primary shadow-lg ring-2 ring-primary/20"
            : hasOverrides
              ? "border-primary/50 bg-card/90 text-ink hover:border-primary hover:bg-card hover:shadow-lg active:scale-95"
              : "border-line/90 bg-card/90 text-ink hover:border-primary/60 hover:bg-card hover:shadow-lg active:scale-95"
        }`}
      >
        <span className="text-sm" aria-hidden="true">🎨</span>
        <span className="font-semibold">样式调整</span>
        <span
          className={`text-[10px] text-muted group-hover:text-ink transition-transform ${
            isOpen ? "rotate-90 text-on-primary" : ""
          }`}
        >
          ›
        </span>
        {hasOverrides && !isOpen && (
          <span className="absolute top-1 right-2 h-2 w-2 rounded-full bg-primary" />
        )}
      </button>

      {/* 展开面板：右侧浮层（在 lg 屏幕向右展开），滚动区 + 另存为模板 */}
      {isOpen && (
        <div className="absolute left-0 lg:left-full lg:ml-2 top-0 z-50 flex max-h-[min(72vh,620px)] w-80 sm:w-88 max-w-[calc(100vw-2rem)] flex-col rounded-2xl border border-line bg-card/95 shadow-2xl backdrop-blur-md animate-in fade-in slide-in-from-left-2 duration-150">
          <div className="flex items-start justify-between gap-2 border-b border-line px-3.5 py-2.5">
            <div>
              <p className="text-xs font-semibold text-ink">样式调整</p>
              <p className="mt-0.5 text-[11px] text-faint">
                基于模板「{baseTemplateName ?? "经典"}」叠加修改，实时生效
              </p>
            </div>
            <div className="flex items-center gap-2">
              {hasOverrides && (
                <button
                  type="button"
                  onClick={handleReset}
                  className="shrink-0 cursor-pointer text-[11px] text-muted underline transition-colors hover:text-danger"
                >
                  重置
                </button>
              )}
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="rounded-full p-1 text-muted hover:bg-surface hover:text-ink transition-colors"
                title="关闭样式面板 (Esc)"
                aria-label="关闭样式面板"
              >
                ✕
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3">
            <StyleFieldGroups style={currentStyle} onSet={writeStyle} onCommit={() => {}} availableModules={availableModules} />
          </div>

          <div className="space-y-1.5 border-t border-line p-3">
            <p className="text-[11px] font-medium text-muted">把当前样式另存为样式模板</p>
            <div className="flex gap-1.5">
              <input
                value={tplName}
                maxLength={30}
                placeholder="例：稳重金融风"
                onChange={(e) => setTplName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleSaveTemplate();
                }}
                className="w-full min-w-0 rounded-lg border border-line bg-card px-2.5 py-1.5 text-xs text-ink outline-none transition-[border-color,box-shadow] placeholder:text-faint focus:border-primary focus:ring-4 focus:ring-primary/10"
              />
              <button
                type="button"
                onClick={() => void handleSaveTemplate()}
                disabled={!tplName.trim() || savingTpl}
                className="shrink-0 cursor-pointer whitespace-nowrap rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-on-primary transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {savingTpl ? "保存中…" : "存为模板"}
              </button>
            </div>
            {tplNote && (
              <p className={`text-[11px] ${tplNote.ok ? "text-emerald-700" : "text-danger"}`}>{tplNote.text}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
