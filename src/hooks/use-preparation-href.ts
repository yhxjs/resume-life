"use client";

import { useSearchParams } from "next/navigation";

/** 进阶面试内部跳转保留当前投递，便于回到准备页。 */
export function usePreparationHref() {
  const id = Number(useSearchParams().get("applicationId"));
  return (href: string) => Number.isSafeInteger(id) && id > 0 ? `${href}${href.includes("?") ? "&" : "?"}applicationId=${id}` : href;
}
