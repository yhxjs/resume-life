"use client";

import { useEffect, useState } from "react";
import { jsonFetch } from "@/lib/fetcher";
import { errorMessage } from "@/lib/error-message";

/** /api/resumes 返回的行；updated_at 供简历排雷页展示「最后更新」 */
export type ResumeVersionOption = { id: number; version: number; name: string };
export type ResumeOption = { id: number; title: string; updated_at: string; versions: ResumeVersionOption[] };

/**
 * 简历下拉选项：4 个页面各自维护过一份 setResumes/error 样板，收口到此处。
 * reloadKey 变化时重取，供调用点的「重试」控件复用原有版本号。
 */
export function useResumeOptions(reloadKey: unknown = 0) {
  const [resumes, setResumes] = useState<ResumeOption[] | null>(null);
  const [resumesError, setResumesError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);

  function reloadResumes() {
    setResumesError("");
    setLoadAttempt((attempt) => attempt + 1);
  }

  useEffect(() => {
    let cancelled = false;
    jsonFetch<ResumeOption[]>("/api/resumes")
      .then((list) => {
        if (cancelled) return;
        setResumes(list);
        setResumesError("");
      })
      .catch((err) => {
        if (!cancelled) setResumesError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey, loadAttempt]);

  return { resumes, resumesError, reloadResumes };
}
