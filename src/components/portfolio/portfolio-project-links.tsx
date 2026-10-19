"use client";

import { useId } from "react";
import { normalizePortfolioLink, PORTFOLIO_LINK_LABELS } from "@/lib/portfolio-links";
import type { PortfolioProjectSelection } from "@/lib/portfolio-types";

export function PortfolioProjectLinks({ name, links, onChange }: {
  name: string;
  links: PortfolioProjectSelection["customLinks"];
  onChange: (field: keyof typeof PORTFOLIO_LINK_LABELS, value: string) => void;
}) {
  const baseId = useId();
  return Object.entries(PORTFOLIO_LINK_LABELS).map(([key, label]) => {
    const field = key as keyof typeof PORTFOLIO_LINK_LABELS;
    const id = `${baseId}-${field}`;
    const value = links?.[field] ?? "";
    const invalid = normalizePortfolioLink(value) === null;
    return (
      <div key={field} className="min-w-0">
        <label htmlFor={id} className="block text-muted mb-1">{name} · {label}</label>
        <input
          id={id}
          type="url"
          value={value}
          onChange={(e) => onChange(field, e.target.value)}
          placeholder="https://example.com"
          aria-invalid={invalid}
          aria-describedby={invalid ? `${id}-error` : undefined}
          className="w-full rounded border border-line bg-surface px-2.5 py-1 text-xs text-ink focus-visible:outline-2 focus-visible:outline-primary"
        />
        {invalid && <p id={`${id}-error`} className="mt-1 text-danger">请输入完整的 HTTP/HTTPS 地址</p>}
      </div>
    );
  });
}
