"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { registerEscapeLayer } from "@/lib/escape-layer";
import { inputCls } from "@/lib/ui";

export interface DateTimePickerProps {
  id?: string;
  value: string; // 格式: "YYYY-MM-DDTHH:mm" 或 ""
  initialDate?: Date;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  className?: string;
  ariaLabel?: string;
  ariaLabelledBy?: string;
}

const WEEK_DAYS = ["一", "二", "三", "四", "五", "六", "日"];
const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0"));
// 提供常用 5 分钟步进项，面试约时间最常用
const MINUTES = Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, "0"));

export function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function buildDateTimeString(
  date: { year: number; month: number; day: number },
  hour: string,
  minute: string
): string {
  return `${date.year}-${pad(date.month + 1)}-${pad(date.day)}T${pad(Number(hour))}:${pad(Number(minute))}`;
}

export function parseDateTime(val: string): { year: number; month: number; day: number; hour: string; minute: string } {
  if (val) {
    // 若带有时区指示（如以 Z 结尾或含时区偏移），转换为客户端本地时间
    if (val.endsWith("Z") || /[+-]\d{2}(:\d{2})?$/.test(val)) {
      const d = new Date(val);
      if (Number.isFinite(d.getTime())) {
        return {
          year: d.getFullYear(),
          month: d.getMonth(),
          day: d.getDate(),
          hour: pad(d.getHours()),
          minute: pad(d.getMinutes()),
        };
      }
    }

    // 若为本地时间字符串 YYYY-MM-DDTHH:mm
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(val)) {
      const parts = val.split("T");
      const datePart = parts[0] ?? "";
      const timePart = parts[1] ?? "";
      const dateSegments = datePart.split("-");
      const timeSegments = timePart.split(":");

      const y = Number(dateSegments[0]) || 2026;
      const m = (Number(dateSegments[1]) || 1) - 1; // 0-based
      const d = Number(dateSegments[2]) || 1;
      const h = timeSegments[0] ?? "00";
      const min = timeSegments[1] ?? "00";

      return {
        year: y,
        month: m,
        day: d,
        hour: pad(Number(h) || 0),
        minute: pad(Number(min) || 0),
      };
    }

    // 其它可识别的有效日期格式，转成本地时区
    const d = new Date(val);
    if (Number.isFinite(d.getTime())) {
      return {
        year: d.getFullYear(),
        month: d.getMonth(),
        day: d.getDate(),
        hour: pad(d.getHours()),
        minute: pad(d.getMinutes()),
      };
    }
  }

  const now = new Date();
  // 默认取下一个整点或半点
  const m = now.getMinutes();
  now.setMinutes(m < 30 ? 30 : 60, 0, 0);

  return {
    year: now.getFullYear(),
    month: now.getMonth(),
    day: now.getDate(),
    hour: pad(now.getHours()),
    minute: pad(now.getMinutes()),
  };
}

export function DateTimePicker({
  id,
  value,
  initialDate,
  onChange,
  placeholder = "选择日期与时间...",
  disabled = false,
  required = false,
  className = "",
  ariaLabel = "日期时间选择",
  ariaLabelledBy,
}: DateTimePickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const selectedDateRef = useRef<HTMLButtonElement>(null);
  const pickerId = useId();

  const parsed = useMemo(() => {
    const result = parseDateTime(value);
    if (!value && initialDate) {
      return { ...result, year: initialDate.getFullYear(), month: initialDate.getMonth(), day: initialDate.getDate() };
    }
    return result;
  }, [value, initialDate]);

  // 面板内部当前的浏览年月（可以左右翻月）
  const [viewYear, setViewYear] = useState(parsed.year);
  const [viewMonth, setViewMonth] = useState(parsed.month);

  // 面板内部当前暂选的日期和时间
  const [draftDate, setDraftDate] = useState<{ year: number; month: number; day: number } | null>(null);
  const [draftHour, setDraftHour] = useState<string | null>(null);
  const [draftMinute, setDraftMinute] = useState<string | null>(null);

  const activeDate = useMemo(() => {
    return draftDate ?? { year: parsed.year, month: parsed.month, day: parsed.day };
  }, [draftDate, parsed.year, parsed.month, parsed.day]);
  const activeHour = draftHour ?? parsed.hour;
  const activeMinute = draftMinute ?? parsed.minute;

  function openPicker() {
    if (disabled) return;
    const p = parsed;
    setViewYear(p.year);
    setViewMonth(p.month);
    setDraftDate({ year: p.year, month: p.month, day: p.day });
    setDraftHour(p.hour);
    setDraftMinute(p.minute);
    setOpen(true);
  }

  function closePicker(restoreFocus = true) {
    setOpen(false);
    setDraftDate(null);
    setDraftHour(null);
    setDraftMinute(null);
    if (restoreFocus) triggerRef.current?.focus();
  }

  // 展开期间登记为内层 Escape 消费者，避免把承载它的外层模态一起关掉
  useEffect(() => {
    if (!open) return;
    selectedDateRef.current?.focus();
    return registerEscapeLayer();
  }, [open]);

  // 点击外部收起
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        closePicker(false);
      }
    }
    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [open]);

  // 生成当前月份的 42 格日历数据
  const calendarDays = useMemo(() => {
    const firstDayOfMonth = new Date(viewYear, viewMonth, 1);
    // getDay(): 0 是周日，转为周一为 0 (周日为 6)
    let startDayOfWeek = firstDayOfMonth.getDay() - 1;
    if (startDayOfWeek === -1) startDayOfWeek = 6;

    const daysInCurrentMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const daysInPrevMonth = new Date(viewYear, viewMonth, 0).getDate();

    const days: Array<{
      year: number;
      month: number;
      day: number;
      isCurrentMonth: boolean;
      isToday: boolean;
      isSelected: boolean;
    }> = [];

    const now = new Date();
    const todayY = now.getFullYear();
    const todayM = now.getMonth();
    const todayD = now.getDate();

    // 上个月的补全
    for (let i = startDayOfWeek - 1; i >= 0; i--) {
      const d = daysInPrevMonth - i;
      const prevMonth = viewMonth === 0 ? 11 : viewMonth - 1;
      const prevYear = viewMonth === 0 ? viewYear - 1 : viewYear;
      days.push({
        year: prevYear,
        month: prevMonth,
        day: d,
        isCurrentMonth: false,
        isToday: todayY === prevYear && todayM === prevMonth && todayD === d,
        isSelected: Boolean(value || initialDate) && activeDate.year === prevYear && activeDate.month === prevMonth && activeDate.day === d,
      });
    }

    // 当月天数
    for (let d = 1; d <= daysInCurrentMonth; d++) {
      days.push({
        year: viewYear,
        month: viewMonth,
        day: d,
        isCurrentMonth: true,
        isToday: todayY === viewYear && todayM === viewMonth && todayD === d,
        isSelected: Boolean(value || initialDate) && activeDate.year === viewYear && activeDate.month === viewMonth && activeDate.day === d,
      });
    }

    // 下个月的补全（凑满 42 格）
    const remaining = 42 - days.length;
    for (let d = 1; d <= remaining; d++) {
      const nextMonth = viewMonth === 11 ? 0 : viewMonth + 1;
      const nextYear = viewMonth === 11 ? viewYear + 1 : viewYear;
      days.push({
        year: nextYear,
        month: nextMonth,
        day: d,
        isCurrentMonth: false,
        isToday: todayY === nextYear && todayM === nextMonth && todayD === d,
        isSelected: Boolean(value || initialDate) && activeDate.year === nextYear && activeDate.month === nextMonth && activeDate.day === d,
      });
    }

    return days;
  }, [viewYear, viewMonth, activeDate, value, initialDate]);

  function prevMonth() {
    if (viewMonth === 0) {
      setViewYear((y) => y - 1);
      setViewMonth(11);
    } else {
      setViewMonth((m) => m - 1);
    }
  }

  function nextMonth() {
    if (viewMonth === 11) {
      setViewYear((y) => y + 1);
      setViewMonth(0);
    } else {
      setViewMonth((m) => m + 1);
    }
  }

  // 点击某一天
  function handleSelectDate(day: { year: number; month: number; day: number }) {
    setDraftDate({ year: day.year, month: day.month, day: day.day });
    if (day.month !== viewMonth) {
      setViewYear(day.year);
      setViewMonth(day.month);
    }
  }

  // 点击小时
  function handleSelectHour(h: string) {
    setDraftHour(h);
  }

  // 关键：点击分钟后，立即保存并自动收起消失
  function handleSelectMinute(min: string) {
    setDraftMinute(min);
    const result = buildDateTimeString(activeDate, activeHour, min);
    onChange(result);
    // 自动消失/收起浮层
    closePicker();
  }

  // 清除输入
  function handleClear(e: React.MouseEvent) {
    e.stopPropagation();
    onChange("");
    triggerRef.current?.focus();
  }

  // 快捷选择今天/明天特定时间
  function handleQuickPick(offsetDays: number, hour: string, minute: string) {
    const target = new Date();
    target.setDate(target.getDate() + offsetDays);
    const dateStr = `${target.getFullYear()}-${pad(target.getMonth() + 1)}-${pad(target.getDate())}`;
    const result = `${dateStr}T${hour}:${minute}`;
    onChange(result);
    closePicker();
  }

  const displayLabel = useMemo(() => {
    if (!value) return initialDate ? `${parsed.year}-${pad(parsed.month + 1)}-${pad(parsed.day)} · 请选择时间` : "";
    const p = parseDateTime(value);
    return `${p.year}-${pad(p.month + 1)}-${pad(p.day)} ${p.hour}:${p.minute}`;
  }, [value, initialDate, parsed]);

  return (
    <div
      ref={rootRef}
      className={`relative ${className}`}
      onKeyDown={(e) => {
        if (e.key === "Escape" && open) {
          e.preventDefault();
          e.stopPropagation();
          closePicker();
        }
      }}
      onBlur={(e) => {
        if (open && !e.currentTarget.contains(e.relatedTarget)) closePicker(false);
      }}
    >
      {/* 触发输入框 */}
      <div
        ref={triggerRef}
        id={id}
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-label={ariaLabelledBy ? undefined : ariaLabel}
        aria-labelledby={ariaLabelledBy}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? pickerId : undefined}
        onClick={() => {
          if (open) closePicker();
          else openPicker();
        }}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (open) {
              const result = buildDateTimeString(activeDate, activeHour, activeMinute);
              onChange(result);
              closePicker();
            } else {
              openPicker();
            }
          }
        }}
        className={`${inputCls} flex cursor-pointer items-center justify-between gap-2 select-none ${
          disabled ? "pointer-events-none opacity-60" : ""
        }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-4 w-4 shrink-0 text-muted"
            aria-hidden
          >
            <rect width="18" height="18" x="3" y="4" rx="2" ry="2" />
            <line x1="16" x2="16" y1="2" y2="6" />
            <line x1="8" x2="8" y1="2" y2="6" />
            <line x1="3" x2="21" y1="10" y2="10" />
          </svg>
          {displayLabel ? (
            <span className="font-mono text-xs sm:text-sm text-ink truncate">{displayLabel}</span>
          ) : (
            <span className="text-xs sm:text-sm text-faint">{placeholder}</span>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`h-3.5 w-3.5 text-faint transition-transform duration-200 ${open ? "rotate-180" : ""}`}
            aria-hidden
          >
            <path d="m4 6 4 4 4-4" />
          </svg>
        </div>
      </div>

      {value && !disabled && (
        <button
          type="button"
          onClick={handleClear}
          title="清除已选时间"
          aria-label="清除已选时间"
          className="absolute right-6 top-1/2 -translate-y-1/2 rounded p-0.5 text-faint hover:bg-surface hover:text-ink transition-colors"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="h-3.5 w-3.5" aria-hidden>
            <path d="M5.28 4.22a.75.75 0 0 0-1.06 1.06L6.94 8l-2.72 2.72a.75.75 0 1 0 1.06 1.06L8 9.06l2.72 2.72a.75.75 0 1 0 1.06-1.06L9.06 8l2.72-2.72a.75.75 0 0 0-1.06-1.06L8 6.94 5.28 4.22Z" />
          </svg>
        </button>
      )}

      {/* 隐藏原生输入框，以便兼容原生 form 提交与 required 校验 */}
      {required && (
        <input
          type="text"
          value={value}
          required={required}
          tabIndex={-1}
          aria-hidden="true"
          className="sr-only"
          onChange={() => {}}
        />
      )}

      {/* 弹出下拉浮层 */}
      {open && (
        <div
          id={pickerId}
          role="dialog"
          aria-label="选择日期与时间"
          className="dropdown-in absolute left-0 sm:left-auto sm:right-0 top-full z-40 mt-1.5 w-[330px] rounded-xl border border-line bg-card p-3 shadow-card-float"
        >
          {/* 快捷选择标签条 */}
          <div className="flex items-center gap-1.5 pb-2.5 mb-2.5 border-b border-line overflow-x-auto text-[11px]">
            <span className="text-muted shrink-0">快捷:</span>
            <button
              type="button"
              onClick={() => handleQuickPick(0, "10", "00")}
              className="rounded border border-line bg-surface px-1.5 py-0.5 text-muted hover:border-primary hover:text-primary transition-colors shrink-0"
            >
              今天10:00
            </button>
            <button
              type="button"
              onClick={() => handleQuickPick(1, "10", "00")}
              className="rounded border border-line bg-surface px-1.5 py-0.5 text-muted hover:border-primary hover:text-primary transition-colors shrink-0"
            >
              明天10:00
            </button>
            <button
              type="button"
              onClick={() => handleQuickPick(1, "14", "30")}
              className="rounded border border-line bg-surface px-1.5 py-0.5 text-muted hover:border-primary hover:text-primary transition-colors shrink-0"
            >
              明天14:30
            </button>
          </div>

          {/* 年月翻页栏 */}
          <div className="flex items-center justify-between mb-2">
            <button
              type="button"
              onClick={prevMonth}
              aria-label="上个月"
              className="rounded-md p-1 text-muted hover:bg-surface hover:text-ink transition-colors"
            >
              ◀
            </button>
            <span className="text-xs font-semibold text-ink">
              {viewYear}年 {viewMonth + 1}月
            </span>
            <button
              type="button"
              onClick={nextMonth}
              aria-label="下个月"
              className="rounded-md p-1 text-muted hover:bg-surface hover:text-ink transition-colors"
            >
              ▶
            </button>
          </div>

          {/* 星期行 */}
          <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-medium text-muted mb-1">
            {WEEK_DAYS.map((w) => (
              <span key={w} className="py-0.5">
                {w}
              </span>
            ))}
          </div>

          {/* 日历网格 */}
          <div className="grid grid-cols-7 gap-1 text-center text-xs mb-3">
            {calendarDays.map((d, idx) => {
              const isChosen =
                activeDate.year === d.year && activeDate.month === d.month && activeDate.day === d.day;
              return (
                <button
                  key={`${d.year}-${d.month}-${d.day}-${idx}`}
                  type="button"
                  ref={isChosen ? selectedDateRef : undefined}
                  aria-label={`${d.year}年${d.month + 1}月${d.day}日`}
                  aria-pressed={isChosen}
                  aria-current={d.isToday ? "date" : undefined}
                  onClick={() => handleSelectDate(d)}
                  className={`h-7 w-7 mx-auto rounded-md flex items-center justify-center transition-colors font-medium ${
                    isChosen
                      ? "bg-primary text-on-primary font-bold shadow-xs"
                      : d.isToday
                      ? "border border-primary text-primary font-semibold hover:bg-primary-soft"
                      : d.isCurrentMonth
                      ? "text-ink hover:bg-surface"
                      : "text-faint hover:bg-surface/50"
                  }`}
                >
                  {d.day}
                </button>
              );
            })}
          </div>

          {/* 时间选择栏 (时 & 分) */}
          <div className="border-t border-line pt-2.5">
            <div className="flex items-center justify-between text-[11px] text-muted mb-1.5">
              <span>选择具体时间 (时 : 分)：</span>
              <span className="font-mono font-semibold text-primary">
                {activeHour} : {activeMinute}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              {/* 小时列表 */}
              <div>
                <div className="text-[10px] text-muted mb-1">时 (Hour)</div>
                <div className="h-28 overflow-y-auto rounded-lg border border-line bg-surface p-1 flex flex-col gap-0.5">
                  {HOURS.map((h) => {
                    const active = activeHour === h;
                    return (
                      <button
                        key={h}
                        type="button"
                        aria-pressed={active}
                        onClick={() => handleSelectHour(h)}
                        className={`rounded px-2 py-0.5 text-center font-mono transition-colors ${
                          active
                            ? "bg-primary text-on-primary font-bold"
                            : "text-ink hover:bg-primary-soft hover:text-primary"
                        }`}
                      >
                        {h} 点
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 分钟列表：点击分钟后自动消失 */}
              <div>
                <div className="text-[10px] text-muted mb-1 flex items-center justify-between">
                  <span>分 (Minute)</span>
                  <span className="text-[9px] text-faint">点击自动选定</span>
                </div>
                <div className="h-28 overflow-y-auto rounded-lg border border-line bg-surface p-1 flex flex-col gap-0.5">
                  {MINUTES.map((m) => {
                    const active = activeMinute === m;
                    return (
                      <button
                        key={m}
                        type="button"
                        aria-pressed={active}
                        onClick={() => handleSelectMinute(m)}
                        title="点击完成并关闭"
                        className={`rounded px-2 py-0.5 text-center font-mono transition-colors ${
                          active
                            ? "bg-primary text-on-primary font-bold"
                            : "text-ink hover:bg-primary text-hover hover:bg-primary-soft hover:text-primary"
                        }`}
                      >
                        {m} 分
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* 底部确认操作条 */}
          <div className="mt-3 flex items-center justify-between border-t border-line pt-2.5 text-xs">
            <button
              type="button"
              onClick={() => {
                const now = new Date();
                const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
                const result = `${dateStr}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
                onChange(result);
                closePicker();
              }}
              className="text-xs text-muted hover:text-primary transition-colors cursor-pointer"
            >
              设为当前时间
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => closePicker()}
                className="rounded-lg border border-line px-2.5 py-1 text-xs text-muted hover:bg-surface hover:text-ink transition-colors cursor-pointer"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => {
                  const result = buildDateTimeString(activeDate, activeHour, activeMinute);
                  onChange(result);
                  closePicker();
                }}
                className="rounded-lg bg-primary px-3 py-1 text-xs font-semibold text-on-primary shadow-xs hover:bg-primary-hover transition-colors cursor-pointer"
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
