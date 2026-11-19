"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { usePreparationHref } from "@/hooks/use-preparation-href";
import { jsonFetch } from "@/lib/fetcher";
import { errorMessage } from "@/lib/error-message";
import { readSeriesData } from "./interview-series-data";
import { normalizeSeriesReport, SERIES_ROUNDS } from "@/lib/series";
import type { SeriesData } from "./interview-series-types";

type PendingSeriesRead = ({ kind: "advance"; roundNo: number } | { kind: "finalize" }) & { failure: string };

export function useInterviewSeries(seriesId: string) {
  const router = useRouter();
  const preparationHref = usePreparationHref();
  const [sessionData, setData] = useState<SeriesData | null>(null);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [action, setAction] = useState<"advance" | "finalize" | null>(null);
  const [readRecovery, setReadRecovery] = useState<PendingSeriesRead | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [stateId, setStateId] = useState(seriesId);
  const session = useMemo(() => Symbol(seriesId), [seriesId]);
  const active = useRef<symbol | null>(null);
  const running = useRef(false);
  const navigating = useRef(false);
  const completed = useRef(false);
  const pendingRead = useRef<PendingSeriesRead | null>(null);

  if (stateId !== seriesId) {
    setStateId(seriesId);
    setData(null);
    setLoadError("");
    setActionError("");
    setAction(null);
    setReadRecovery(null);
  }
  const data = sessionData?.id === Number(seriesId) ? sessionData : null;
  const isCurrent = useCallback(() => active.current === session, [session]);
  useLayoutEffect(() => {
    active.current = session;
    running.current = false;
    navigating.current = false;
    completed.current = false;
    pendingRead.current = null;
    return () => { active.current = null; };
  }, [session]);
  const refetch = useCallback(async () => readSeriesData(
    await jsonFetch<SeriesData>(`/api/interviews/series/${seriesId}`), Number(seriesId),
  ), [seriesId]);
  useEffect(() => {
    let cancelled = false;
    refetch().then((next) => {
      if (!cancelled && isCurrent()) setData(next);
    }).catch((reason) => {
      if (!cancelled && isCurrent()) setLoadError(errorMessage(reason));
    });
    return () => { cancelled = true; };
  }, [refetch, loadAttempt, isCurrent]);

  function retryLoad() {
    if (!isCurrent()) return;
    setLoadError("");
    setLoadAttempt((attempt) => attempt + 1);
  }
  function start(kind: "advance" | "finalize", recovering = false) {
    if (!isCurrent() || !data || running.current || navigating.current || completed.current ||
        (!recovering && pendingRead.current)) return false;
    running.current = true;
    setAction(kind);
    setActionError("");
    return true;
  }
  function finish() {
    if (isCurrent() && !navigating.current) { running.current = false; setAction(null); }
  }
  function clearPending() {
    pendingRead.current = null;
    setReadRecovery(null);
    setActionError("");
  }
  function goToRound(id: number) {
    navigating.current = true;
    try { router.push(preparationHref(`/interviews/${id}`)); }
    catch (reason) { navigating.current = false; throw reason; }
  }

  async function readResult(pending: PendingSeriesRead) {
    if (!isCurrent()) return;
    pendingRead.current = pending;
    setReadRecovery(pending);
    try {
      const next = await refetch();
      if (!isCurrent()) return;
      if (!data || data.entries.some((entry) => !next.entries.some((updated) =>
        updated.round_no === entry.round_no && updated.interview_id === entry.interview_id))) {
        throw new Error("服务器返回的系列记录缺失或已被替换");
      }
      if (pending.kind === "finalize") {
        if (next.final_report && (next.status !== "finished" || !next.finished_at.trim())) {
          throw new Error("已保存总评的完成状态不完整");
        }
        setData(next);
        clearPending();
        if (next.final_report) completed.current = true;
        else setActionError(pending.failure);
      } else {
        const target = next.entries.find((entry) => entry.round_no === pending.roundNo);
        setData(next);
        if (target) {
          goToRound(target.interview_id);
          clearPending();
        } else {
          clearPending();
          setActionError(pending.failure);
        }
      }
    } catch (reason) {
      if (!isCurrent()) return;
      setActionError(`${pending.kind === "finalize" ? "跨轮总评保存状态暂无法确认" : "下一轮创建状态暂无法确认"}：${errorMessage(reason)}。请重新读取系列状态。`);
    }
  }

  async function finalize() {
    if (!data || data.final_report || data.entries.length !== SERIES_ROUNDS || data.entries.some((entry) => entry.status !== "finished" || !entry.report)) return;
    if (!start("finalize")) return;
    try {
      const response = await jsonFetch<{ report?: unknown; finished_at?: unknown }>(`/api/interviews/series/${seriesId}/finalize`, { method: "POST" });
      if (!isCurrent()) return;
      const report = normalizeSeriesReport(response?.report);
      if (!report || typeof response.finished_at !== "string" || !response.finished_at.trim()) throw new Error("跨轮总评响应不完整");
      const finishedAt = response.finished_at;
      completed.current = true;
      setData((previous) => previous ? { ...previous, final_report: report, status: "finished", finished_at: finishedAt } : previous);
      clearPending();
    } catch (reason) {
      await readResult({ kind: "finalize", failure: errorMessage(reason) });
    } finally { finish(); }
  }

  async function advance() {
    const last = data?.entries[data.entries.length - 1];
    if (!data || data.status !== "ongoing" || data.final_report || !last?.report || last.status !== "finished" || last.round_no >= SERIES_ROUNDS) return;
    const roundNo = last.round_no + 1;
    if (!start("advance")) return;
    try {
      const response = await jsonFetch<{ id?: number; round_no?: number }>(`/api/interviews/series/${seriesId}/advance`, {
        method: "POST", body: JSON.stringify({ from_interview_id: last.interview_id }),
      });
      if (!isCurrent()) return;
      if (!response || typeof response.id !== "number" || !Number.isSafeInteger(response.id) || response.id <= 0 || response.round_no !== roundNo) throw new Error("下一轮响应不完整");
      goToRound(response.id);
    } catch (reason) {
      await readResult({ kind: "advance", roundNo, failure: errorMessage(reason) });
    } finally { finish(); }
  }

  async function retryRead() {
    const pending = pendingRead.current;
    if (!pending || !start(pending.kind, true)) return;
    try { await readResult(pending); }
    finally { finish(); }
  }

  return { data, loadError, retryLoad, actionError, readRecovery, retryRead, advance, finalize,
    advancing: action === "advance", finalizing: action === "finalize" };
}
