import React from "react";
import { inputCls, cardCls } from "@/lib/ui";

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <span className="shrink-0 text-xs text-muted">{label}</span>
      {children}
    </div>
  );
}

export function Seg<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-card p-0.5" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
            value === o.value ? "bg-primary text-on-primary" : "text-muted hover:text-ink"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function NumField({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  onChange,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit: string;
  onChange: (v: number) => void;
  onCommit: () => void;
}) {
  return (
    <Field label={label}>
      <div className="flex items-center gap-1.5">
        <input
          type="number"
          className={`${inputCls} w-20 px-2 py-1 text-xs`}
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (e.target.value !== "" && Number.isFinite(n)) {
              onChange(Math.min(max, Math.max(min, n)));
            }
          }}
          onBlur={onCommit}
          aria-label={label}
        />
        <span className="w-7 text-xs text-faint">{unit}</span>
      </div>
    </Field>
  );
}

export function ColorField({
  label,
  value,
  onChange,
  onCommit,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
}) {
  return (
    <Field label={label}>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onCommit}
          aria-label={label}
          className="h-8 w-10 cursor-pointer rounded border border-line bg-card p-0.5"
        />
        <input
          className={`${inputCls} w-24 px-2 py-1 font-mono text-xs`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onCommit}
          aria-label={`${label}十六进制值`}
        />
      </div>
    </Field>
  );
}

export function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <details open className={`${cardCls} p-4`}>
      <summary className="cursor-pointer select-none text-sm font-bold">{title}</summary>
      <div className="mt-1 divide-y divide-line">{children}</div>
    </details>
  );
}
