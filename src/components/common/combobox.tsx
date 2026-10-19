"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { registerEscapeLayer } from "@/lib/escape-layer";
import { inputCls } from "@/lib/ui";

const PAGE_STEP = 10;

/** 可输入选择框：下拉按钮展示全部候选并给当前已选值打勾；输入框平时保持为空、已选值以虚化浮层展示，重新输入才按输入内容匹配。 */
export function Combobox({
  value,
  onChange,
  options,
  placeholder,
  ariaLabel,
  listboxLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
  /** 无障碍名称，默认沿用模型选择场景的叫法 */
  ariaLabel?: string;
  /** 下拉面板的名称；省略时沿用 ariaLabel，再省略则沿用模型选择场景的叫法 */
  listboxLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  // 输入中的搜索词与已选值解耦：确认前 value 保持不变，下拉列表里始终能给当前已选模型打勾
  const [typing, setTyping] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const selectedValueId = useId();

  const filtered = useMemo(() => {
    if (!typing) return options;
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.toLowerCase().includes(q));
  }, [options, query, typing]);

  // 键盘高亮项滚入可视区（沿用 command-palette 的 data-selected 定位）
  useEffect(() => {
    listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  // 展开期间登记为内层 Escape 消费者，避免把承载它的模态一起关掉
  useEffect(() => {
    if (!open) return;
    return registerEscapeLayer();
  }, [open]);

  /** 回到「已选」展示态：丢弃搜索词、收起面板 */
  function reset() {
    setTyping(false);
    setQuery("");
    setOpen(false);
  }

  /** 确认一个值：同步给父级并回到已选展示态 */
  function commit(v: string) {
    onChange(v);
    reset();
  }

  /** 在面板展开时切换到展示全部候选，高亮定位到当前已选值 */
  function showAll() {
    setTyping(false);
    setQuery("");
    setActive(Math.max(0, options.indexOf(value)));
  }

  /** 仅在面板从关闭到打开时展示全部候选；已打开时是空操作 */
  function openList() {
    if (options.length === 0 || open) return;
    showAll();
    setOpen(true);
  }

  function onBlur(e: React.FocusEvent<HTMLInputElement>) {
    // 选项 mousedown 被 preventDefault，不会走到这里；只有焦点真正离开组件才收起
    if (rootRef.current?.contains(e.relatedTarget as Node | null)) return;
    // 无候选匹配时保留自由输入；搜索词失焦后回到已选值。
    if (typing && query && filtered.length === 0) commit(query);
    else reset();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        openList();
      } else if (filtered.length > 0) {
        const delta = e.key === "ArrowDown" ? 1 : -1;
        setActive((i) => (i + delta + filtered.length) % filtered.length);
      }
    } else if (open && filtered.length > 0 && (e.key === "Home" || e.key === "End")) {
      e.preventDefault();
      setActive(e.key === "Home" ? 0 : filtered.length - 1);
    } else if (open && filtered.length > 0 && (e.key === "PageDown" || e.key === "PageUp")) {
      e.preventDefault();
      const delta = e.key === "PageDown" ? PAGE_STEP : -PAGE_STEP;
      setActive((i) => Math.min(Math.max(i + delta, 0), filtered.length - 1));
    } else if (e.key === "Enter" && ((open && filtered[active]) || (typing && query))) {
      // 有高亮候选时确认候选，否则按「回车保留当前输入」处理自由文本
      e.preventDefault();
      commit(open && filtered[active] ? filtered[active] : query);
    } else if (e.key === "Escape") {
      reset();
    }
  }

  return (
    <div ref={rootRef} className="relative">
      <input
        className={`${inputCls} pr-9`}
        value={typing ? query : ""}
        placeholder={!typing && value ? undefined : placeholder}
        role="combobox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open && filtered[active] ? `${listboxId}-option-${active}` : undefined}
        aria-autocomplete="list"
        aria-label={ariaLabel ?? "候选模型"}
        aria-describedby={value ? selectedValueId : undefined}
        autoComplete="off"
        onChange={(e) => {
          setQuery(e.target.value);
          setTyping(true);
          if (options.length > 0) {
            setActive(0);
            setOpen(true);
          }
        }}
        onFocus={openList}
        onClick={openList}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
      />
      {value && <span id={selectedValueId} className="sr-only">当前选择：{value}</span>}
      {/* 未重新输入时输入框保持为空，已选值以虚化浮层展示，点击即可直接输入新值 */}
      {!typing && value && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 right-9 flex items-center pl-3 text-base sm:text-sm text-faint"
        >
          <span className="truncate">{value}</span>
        </span>
      )}
      {options.length > 0 && (
        <button
          type="button"
          tabIndex={-1}
          aria-label="展开全部候选"
          aria-expanded={open}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            if (open && !typing) setOpen(false);
            else if (open) showAll();
            else openList();
          }}
          className="absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-lg text-faint transition-colors hover:text-ink"
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`h-3.5 w-3.5 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
            aria-hidden
          >
            <path d="m4 6 4 4 4-4" />
          </svg>
        </button>
      )}
      {open && (
        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          aria-label={listboxLabel ?? ariaLabel ?? "候选模型"}
          className="dropdown-in absolute inset-x-0 top-full z-20 mt-1.5 max-h-60 overflow-y-auto rounded-xl border border-line bg-card p-1 shadow-card-float"
        >
          {filtered.length === 0 ? (
            <p className="px-2.5 py-2 text-xs text-faint">无匹配模型，回车保留当前输入</p>
          ) : (
            filtered.map((m, index) => {
              const selected = m === value;
              const isActive = index === active;
              return (
                <button
                  key={m}
                  id={`${listboxId}-option-${index}`}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  data-selected={isActive || undefined}
                  onMouseEnter={() => setActive(index)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => commit(m)}
                  className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors ${
                    isActive ? "bg-primary-soft" : ""
                  }`}
                >
                  <span className="min-w-0 truncate font-mono text-[13px] text-ink">
                    {typing ? highlight(m, query) : m}
                  </span>
                  {selected && (
                    <svg
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="h-3.5 w-3.5 shrink-0 text-primary"
                      aria-hidden
                    >
                      <path d="m3 8.5 3.5 3.5L13 5" />
                    </svg>
                  )}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

/** 子串匹配高亮（不区分大小写） */
function highlight(text: string, query: string) {
  const q = query.trim().toLowerCase();
  const i = q ? text.toLowerCase().indexOf(q) : -1;
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <span className="font-semibold text-primary">{text.slice(i, i + q.length)}</span>
      {text.slice(i + q.length)}
    </>
  );
}
