"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { jsonFetch } from "@/lib/fetcher";
import { errorMessage } from "@/lib/error-message";
import { SERIES_ROUNDS } from "@/lib/series";
import { usePreparationHref } from "@/hooks/use-preparation-href";
import { readSeriesData } from "./interview-series-data";
import type { SeriesData } from "./interview-series-types";

type PendingAdvance = { roundNo: number; failure: string };

/** 详情页的两个导航动作共享锁；下一轮响应异常时，先按原目标轮次读取确认。 */
export function useInterviewSeriesActions({
  interviewId, seriesId, roundNo, isCurrent,
}: {
  interviewId: number | null;
  seriesId: number | null;
  roundNo: number | null;
  isCurrent: () => boolean;
}) {
  const router = useRouter();
  const preparationHref = usePreparationHref();
  const [remediating, setRemediating] = useState(false);
  const [remedialError, setRemedialError] = useState("");
  const [advancing, setAdvancing] = useState(false);
  const [advanceError, setAdvanceError] = useState("");
  const [readRecovery, setReadRecovery] = useState<PendingAdvance | null>(null);
  const session = useMemo(() => ({ interviewId, seriesId, roundNo, isCurrent }), [interviewId, seriesId, roundNo, isCurrent]);
  const [stateSession, setStateSession] = useState(session);
  const active = useRef<typeof session | null>(null);
  const running = useRef(false);
  const navigating = useRef(false);
  const pendingRead = useRef<PendingAdvance | null>(null);
  if (stateSession !== session) {
    setStateSession(session);
    setRemediating(false);
    setRemedialError("");
    setAdvancing(false);
    setAdvanceError("");
    setReadRecovery(null);
  }
  useLayoutEffect(() => {
    active.current = session;
    running.current = false;
    navigating.current = false;
    pendingRead.current = null;
    return () => { active.current = null; };
  }, [session]);

  function isActive() { return active.current === session && isCurrent(); }
  function start(recovering = false) {
    if (!isActive() || interviewId === null || running.current || navigating.current ||
        (!recovering && pendingRead.current)) return false;
    running.current = true;
    return true;
  }
  function finish() {
    if (!isActive() || navigating.current) return;
    running.current = false;
    setAdvancing(false);
    setRemediating(false);
  }
  function navigate(href: string) {
    navigating.current = true;
    try { router.push(href); }
    catch (reason) { navigating.current = false; throw reason; }
  }

  async function startRemediation() {
    if (!start()) return;
    setRemediating(true);
    setRemedialError("");
    try {
      const result = await jsonFetch<{ id: number }>("/api/drills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "interview", interview_id: interviewId, count: 5 }),
      });
      if (!isActive()) return;
      if (!result || !Number.isSafeInteger(result.id) || result.id <= 0) throw new Error("追练题响应不完整");
      navigate(`/drills/${result.id}`);
    } catch (reason) {
      if (isActive()) setRemedialError(errorMessage(reason));
    } finally { finish(); }
  }

  async function readResult(pending: PendingAdvance) {
    if (!isActive() || seriesId === null) return;
    pendingRead.current = pending;
    setReadRecovery(pending);
    try {
      const next = readSeriesData(await jsonFetch<SeriesData>(`/api/interviews/series/${seriesId}`), seriesId);
      if (!isActive()) return;
      if (!next.entries.some((entry) => entry.round_no === roundNo && entry.interview_id === interviewId)) {
        throw new Error("服务器返回的原面试记录缺失或已被替换");
      }
      const target = next.entries.find((entry) => entry.round_no === pending.roundNo);
      if (target) navigate(preparationHref(`/interviews/${target.interview_id}`));
      pendingRead.current = null;
      setReadRecovery(null);
      setAdvanceError(target ? "" : pending.failure);
    } catch (reason) {
      if (isActive()) setAdvanceError(`下一轮创建状态暂无法确认：${errorMessage(reason)}。请重新读取系列状态。`);
    }
  }

  async function advance() {
    if (seriesId === null || roundNo === null || !Number.isSafeInteger(roundNo) || roundNo < 1 || roundNo >= SERIES_ROUNDS || !start()) return;
    const targetRound = roundNo + 1;
    setAdvancing(true);
    setAdvanceError("");
    try {
      const result = await jsonFetch<{ id: number; round_no: number }>(`/api/interviews/series/${seriesId}/advance`, {
        method: "POST", body: JSON.stringify({ from_interview_id: interviewId }),
      });
      if (!isActive()) return;
      if (!result || !Number.isSafeInteger(result.id) || result.id <= 0 || result.id === interviewId || result.round_no !== targetRound) {
        throw new Error("下一轮响应不完整");
      }
      navigate(preparationHref(`/interviews/${result.id}`));
    } catch (reason) {
      await readResult({ roundNo: targetRound, failure: errorMessage(reason) });
    } finally { finish(); }
  }

  async function retryRead() {
    const pending = pendingRead.current;
    if (!pending || !start(true)) return;
    setAdvancing(true);
    setAdvanceError("");
    try { await readResult(pending); }
    finally { finish(); }
  }

  return { remediating, remedialError, advancing, advanceError, readRecovery, retryRead, startRemediation, advance };
}
