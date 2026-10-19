"use client";

import { useEffect, useRef, useState } from "react";
import { PRESET_RICH_COLORS, plainTextToRichHtml, sanitizeRichText } from "@/lib/rich-text";

export interface RichTextEditorProps {
  value: string;
  onChange: (val: string) => void;
  placeholder?: string;
  minHeightClass?: string;
  className?: string;
  ariaLabel?: string;
}

export function RichTextEditor({
  value,
  onChange,
  placeholder = "输入内容…",
  minHeightClass = "min-h-[96px]",
  className = "",
  ariaLabel,
}: RichTextEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const lastHtmlRef = useRef<string | null>(null);
  const selectionRef = useRef<Range | null>(null);
  const [colorMenuOpen, setColorMenuOpen] = useState(false);
  const [isBold, setIsBold] = useState(false);

  // 同步外部 value 变化（支持历史纯文本展示，同时避免用户打字时光标跳动）
  useEffect(() => {
    if (editorRef.current && value !== lastHtmlRef.current) {
      const htmlToRender = plainTextToRichHtml(value || "");
      editorRef.current.innerHTML = htmlToRender;
      selectionRef.current = null;
      lastHtmlRef.current = value || "";
    }
  }, [value]);

  function updateActiveState() {
    if (typeof document === "undefined") return;
    saveSelection();
    try {
      setIsBold(document.queryCommandState("bold"));
    } catch {
      // 忽略查询失败异常
    }
  }

  function saveSelection() {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !editorRef.current) return;
    const range = selection.getRangeAt(0);
    if (editorRef.current.contains(range.startContainer) && editorRef.current.contains(range.endContainer)) {
      selectionRef.current = range.cloneRange();
    }
  }

  function restoreSelection() {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    const range = selectionRef.current;
    if (range && editor.contains(range.startContainer) && editor.contains(range.endContainer)) {
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  }

  function handleInput() {
    if (!editorRef.current) return;
    const rawHtml = editorRef.current.innerHTML;
    // 如果只有占位空行，转为空字符
    const clean = rawHtml === "<br>" || rawHtml === "<p><br></p>" ? "" : rawHtml;
    lastHtmlRef.current = clean;
    onChange(clean);
    updateActiveState();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    // 拦截 Ctrl+B / Cmd+B 进行原生加粗
    if ((e.ctrlKey || e.metaKey) && (e.key === "b" || e.key === "B")) {
      e.preventDefault();
      toggleBold();
    }
  }

  function toggleBold() {
    if (!editorRef.current) return;
    restoreSelection();
    document.execCommand("bold", false);
    handleInput();
  }

  function applyColor(color: string) {
    if (!editorRef.current) return;
    restoreSelection();
    if (color === "inherit") {
      document.execCommand("removeFormat", false);
      // 如果当前是加粗状态，重新加粗
      if (isBold) {
        document.execCommand("bold", false);
      }
    } else {
      document.execCommand("styleWithCSS", false, "true");
      document.execCommand("foreColor", false, color);
    }
    setColorMenuOpen(false);
    handleInput();
  }

  function handlePaste(e: React.ClipboardEvent<HTMLDivElement>) {
    e.preventDefault();
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    // 纯文本粘贴，换行转为 <br> 并进行安全清洗
    const linesHtml = text
      .split("\n")
      .map((line) => line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"))
      .join("<br>");
    const sanitized = sanitizeRichText(linesHtml);
    document.execCommand("insertHTML", false, sanitized);
    handleInput();
  }

  return (
    <div
      className={`rounded-lg border border-line bg-card transition-[border-color,box-shadow] focus-within:border-primary focus-within:ring-4 focus-within:ring-primary/10 ${className}`}
    >
      {/* 顶部微型工具栏 */}
      <div className="flex items-center justify-between border-b border-line/60 bg-surface/50 px-2 py-1 select-none">
        <div className="flex items-center gap-1.5">
          {/* 加粗按钮 */}
          <button
            type="button"
            title="加粗 (Ctrl+B)"
            aria-label="加粗文本"
            aria-pressed={isBold}
            onMouseDown={(e) => {
              e.preventDefault();
              saveSelection();
            }}
            onClick={toggleBold}
            className={`flex h-7 w-7 items-center justify-center rounded text-xs font-bold transition-colors ${
              isBold
                ? "bg-primary text-on-primary"
                : "text-muted hover:bg-surface hover:text-ink"
            }`}
          >
            B
          </button>

          {/* 颜色高亮按钮与色板下拉 */}
          <div className="relative">
            <button
              type="button"
              title="文字颜色"
              aria-label="设置文字颜色"
              aria-expanded={colorMenuOpen}
              onMouseDown={(e) => {
                e.preventDefault();
                saveSelection();
              }}
              onClick={() => setColorMenuOpen((prev) => !prev)}
              className="flex h-7 items-center gap-1 rounded px-1.5 text-xs text-muted transition-colors hover:bg-surface hover:text-ink"
            >
              {/* 色板按钮需同时预览三种可选颜色的固定色值，属 DESIGN.md 令牌禁令的领域特例 */}
              <span
                className="h-3 w-3 rounded-full border border-line"
                style={{
                  background:
                    "linear-gradient(135deg, #1d4ed8 0%, #b91c1c 50%, #15803d 100%)",
                }}
              />
              <span>颜色</span>
            </button>

            {colorMenuOpen && (
              <div
                className="absolute left-0 top-full z-20 mt-1 flex flex-wrap gap-1.5 rounded-lg border border-line bg-card p-2 shadow-card-float"
                style={{ minWidth: "168px" }}
              >
                {PRESET_RICH_COLORS.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    title={item.label}
                    onMouseDown={(e) => {
                      e.preventDefault();
                    }}
                    onClick={() => applyColor(item.color)}
                    className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-ink transition-colors hover:bg-surface"
                  >
                    <span
                      className={`h-3.5 w-3.5 rounded-full ${item.dotClass}`}
                      style={item.color !== "inherit" ? { backgroundColor: item.color } : undefined}
                    />
                    <span>{item.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <span className="text-[11px] text-faint">选中文本加粗/标色</span>
      </div>

      {/* 可编辑区 */}
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel}
        data-placeholder={placeholder}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onKeyUp={updateActiveState}
        onMouseUp={updateActiveState}
        onBlur={saveSelection}
        onPaste={handlePaste}
        className={`w-full p-2.5 text-sm text-ink outline-none leading-relaxed overflow-y-auto ${minHeightClass} empty:before:content-[attr(data-placeholder)] empty:before:text-faint empty:before:pointer-events-none`}
      />
    </div>
  );
}
