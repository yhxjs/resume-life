"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { isStoredId } from "@/lib/id-parsing";
import { jsonFetch } from "@/lib/fetcher";
import { errorMessage } from "@/lib/error-message";

/** 候选材料只依赖身份、标题与发布版；兼容缺省的历史时间元数据。 */
export type ResumeVersionOption = { id: number; version: number; name: string };
export type ResumeOption = { id: number; title: string; updated_at?: string; versions: ResumeVersionOption[] };

const positiveId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
export function readResumeOptions(value: unknown): ResumeOption[] {
  const invalid = () => new Error("简历列表响应不完整或存在重复记录，请重新加载");
  if (!Array.isArray(value)) throw invalid();
  const resumeIds = new Set<number>();
  const versionIds = new Set<number>();
  for (const row of value) {
    if (!row || typeof row !== "object" || !isStoredId(row.id) || resumeIds.has(row.id) ||
      typeof row.title !== "string" || (row.updated_at !== undefined && typeof row.updated_at !== "string") || !Array.isArray(row.versions)) throw invalid();
    resumeIds.add(row.id);
    const numbers = new Set<number>();
    for (const version of row.versions) {
      if (!version || typeof version !== "object" || !isStoredId(version.id) || versionIds.has(version.id) ||
        !positiveId(version.version) || numbers.has(version.version) || typeof version.name !== "string" ||
        (version.resume_id !== undefined && version.resume_id !== row.id)) throw invalid();
      versionIds.add(version.id);
      numbers.add(version.version);
    }
  }
  // 新投递等业务仅接受正 ID。先完整核对目录，再生成可绑定的候选。
  return (value as ResumeOption[]).filter(row => row.id > 0).map(row => ({
    ...row, versions: row.versions.filter(version => version.id > 0),
  }));
}

/**
 * 公共简历候选：整份验证后再接受，刷新失败保留上次已验证的选项。
 * reloadKey 变化时重取，供调用点的「重试」控件复用原有版本号。
 */
export function useResumeOptions(reloadKey: unknown = 0) {
  const [resumes, setResumes] = useState<ResumeOption[] | null>(null);
  const [resumesError, setResumesError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const mounted = useRef(false);
  const request = useRef<AbortController | null>(null);

  const reloadResumes = useCallback(() => {
    if (!mounted.current) return;
    request.current?.abort();
    request.current = null;
    setResumesError("");
    setLoadAttempt((attempt) => attempt + 1);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.abort();
      request.current = null;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    request.current?.abort();
    request.current = controller;
    const isCurrent = () => mounted.current && request.current === controller && !controller.signal.aborted;
    jsonFetch<unknown>("/api/resumes", { signal: controller.signal, cache: "no-store" })
      .then((value) => {
        if (!isCurrent()) return;
        const list = readResumeOptions(value);
        setResumes(list);
        setResumesError("");
      })
      .catch((err) => {
        if (isCurrent()) setResumesError(errorMessage(err));
      }).finally(() => { if (request.current === controller) request.current = null; });
    return () => {
      controller.abort();
      if (request.current === controller) request.current = null;
    };
  }, [reloadKey, loadAttempt]);

  return { resumes, resumesError, reloadResumes };
}
