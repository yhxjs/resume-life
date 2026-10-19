import React from "react";

export function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function HighlightText({
  text,
  keyword,
  className = "font-semibold text-primary bg-primary/10 rounded px-0.5",
}: {
  text: string;
  keyword: string;
  className?: string;
}) {
  if (!text) return null;
  const trimmed = keyword.trim();
  if (!trimmed) return <>{text}</>;

  const escaped = escapeRegExp(trimmed);
  // 用括号捕获分组切分，保证切分后的数组保留匹配项
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));

  return (
    <>
      {parts.map((part, index) => {
        if (part.toLowerCase() === trimmed.toLowerCase()) {
          return (
            <mark key={index} className={className}>
              {part}
            </mark>
          );
        }
        return <React.Fragment key={index}>{part}</React.Fragment>;
      })}
    </>
  );
}
