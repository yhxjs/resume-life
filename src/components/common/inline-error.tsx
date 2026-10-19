"use client";

import { textErr } from "@/lib/ui";

/**
 * 局部加载失败的轻量提示：贴在出问题的选择器或列表旁边。
 * 用于「非关键路径的初始加载」——这类请求失败时页面主体仍可用，
 * 但不能静默成空列表让用户误以为「本来就没有数据」。
 */
export function InlineError({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  if (!message) return null;
  return (
    <p className={`text-xs leading-relaxed ${textErr}`} role="alert">
      {message}
      {onRetry && (
        <button type="button" className="ml-1.5 underline hover:no-underline" onClick={onRetry}>
          点击重试
        </button>
      )}
    </p>
  );
}
