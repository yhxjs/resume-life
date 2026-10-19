"use client";

import { useMemo, useState } from "react";
import { type CustomTemplate } from "@/lib/templates";
import { templateSummary } from "@/lib/template-browser";
import { TemplatePickerDialog } from "./template-picker-dialog";

export function TemplatePicker({
  value,
  customs,
  onChange,
}: {
  value: string;
  customs: CustomTemplate[];
  onChange: (ref: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const currentMeta = useMemo(() => templateSummary(value, customs), [value, customs]);

  return (
    <>
      {/* 触发按钮：显示当前模板状态与主色调胶囊 */}
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="group inline-flex items-center gap-1.5 rounded-lg border border-line bg-card px-2.5 py-1.5 text-xs text-ink shadow-xs transition-all hover:border-primary/60 hover:bg-surface focus:outline-none focus:ring-2 focus:ring-primary/20 cursor-pointer"
        title="点击切换简历模板"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
      >
        <span className="text-[11px] font-medium text-faint">模板</span>
        <span
          className="inline-block h-2 w-2 shrink-0 rounded-full transition-transform group-hover:scale-125"
          style={{ backgroundColor: currentMeta.color }}
        />
        <span className="font-semibold text-ink">{currentMeta.label}</span>
        <svg
          className="h-3 w-3 text-muted transition-transform group-hover:text-primary"
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

      {isOpen && (
        <TemplatePickerDialog
          value={value}
          customs={customs}
          onChange={onChange}
          onClose={() => setIsOpen(false)}
        />
      )}
    </>
  );
}
