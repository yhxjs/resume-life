"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { btnGhost } from "@/lib/ui";

function ReturnLink() {
  const id = Number(useSearchParams().get("applicationId"));
  return Number.isSafeInteger(id) && id > 0 ? <Link className={btnGhost} href={`/applications/${id}/prepare`}>← 返回投递准备</Link> : null;
}

export function PreparationReturnLink() {
  return <Suspense fallback={null}><ReturnLink /></Suspense>;
}
