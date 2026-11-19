"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { jsonFetch } from "@/lib/fetcher";
import { errorMessage } from "@/lib/error-message";
import { normalizeEvaluatorReport, type EvaluatorReport } from "@/lib/scores";

/** 补生成的响应丢失时先核对存档；保存状态未确认前只允许 GET。 */
export function useInterviewEvaluator({
  interviewId, report, onReportGenerated,
}: {
  interviewId: number;
  report: EvaluatorReport | null;
  onReportGenerated?: (report: EvaluatorReport) => void;
}) {
  const [generated, setGenerated] = useState<EvaluatorReport | null>(null);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [readRecovery, setReadRecovery] = useState(false);
  const [stateId, setStateId] = useState(interviewId);
  const session = useMemo(() => Symbol(interviewId), [interviewId]);
  const activeSession = useRef<symbol | null>(null);
  const running = useRef(false);
  const pendingRead = useRef<string | null>(null);
  const completed = useRef(false);

  if (stateId !== interviewId) {
    setStateId(interviewId);
    setGenerated(null);
    setGenerating(false);
    setError("");
    setReadRecovery(false);
  }

  useLayoutEffect(() => {
    activeSession.current = session;
    running.current = false;
    pendingRead.current = null;
    completed.current = false;
    return () => { activeSession.current = null; };
  }, [session]);

  const isCurrent = () => activeSession.current === session;

  function accept(saved: EvaluatorReport) {
    if (!isCurrent()) return;
    completed.current = true;
    pendingRead.current = null;
    setReadRecovery(false);
    setGenerated(saved);
    setError("");
    onReportGenerated?.(saved);
  }

  async function readResult(failure: string) {
    if (!isCurrent()) return;
    pendingRead.current = failure;
    setReadRecovery(true);
    try {
      const data = await jsonFetch<{ id: number; evaluator_report: unknown }>(`/api/interviews/${interviewId}`);
      if (!isCurrent()) return;
      if (!data || data.id !== interviewId || data.evaluator_report === undefined) {
        throw new Error("服务器返回的面试官评估状态不完整");
      }
      if (data.evaluator_report === null) {
        pendingRead.current = null;
        setReadRecovery(false);
        setError(failure);
        return;
      }
      const saved = normalizeEvaluatorReport(data.evaluator_report);
      if (!saved) throw new Error("服务器返回的面试官评估无法读取");
      accept(saved);
    } catch (reason) {
      if (isCurrent()) setError(`面试官评估保存状态暂无法确认：${errorMessage(reason)}。请重新读取评估结果。`);
    }
  }

  async function generate() {
    if (!isCurrent() || report || completed.current || running.current || pendingRead.current !== null) return;
    running.current = true;
    setGenerating(true);
    setError("");
    try {
      const data = await jsonFetch<{ evaluator_report?: unknown }>(`/api/interviews/${interviewId}/evaluator-report`, { method: "POST" });
      if (!isCurrent()) return;
      const saved = normalizeEvaluatorReport(data?.evaluator_report);
      if (!saved) throw new Error("面试官评估响应不完整，请重试");
      accept(saved);
    } catch (reason) {
      await readResult(errorMessage(reason));
    } finally {
      if (isCurrent()) { running.current = false; setGenerating(false); }
    }
  }

  async function retryRead() {
    const failure = pendingRead.current;
    if (!isCurrent() || report || completed.current || running.current || failure === null) return;
    running.current = true;
    setGenerating(true);
    setError("");
    try { await readResult(failure); }
    finally { if (isCurrent()) { running.current = false; setGenerating(false); } }
  }

  return { report: report ?? generated, generating, error, readRecovery, generate, retryRead };
}
