"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { confirmDialog } from "@/components/common/confirm-dialog";
import { fetchSse } from "@/lib/fetch-sse";
import { jsonFetch } from "@/lib/fetcher";
import { useTypewriter } from "@/hooks/use-typewriter";
import { errorMessage } from "@/lib/error-message";
import { useReverseInterview } from "@/hooks/use-reverse-interview";
import { useInterviewSeriesActions } from "@/hooks/use-interview-series-actions";
import type { InterviewData, InterviewTurn } from "@/hooks/interview-types";

export type { InterviewData, InterviewTurn } from "@/hooks/interview-types";

/**
 * 面试详情页的命令入口。本函数只持有「加载 + 作答 + 生成报告」这条主流程的状态，
 * 反问环节与两个跳走动作各自在自己的 hook 里持有状态，这里只做组合，
 * 以便每个流程可以单独阅读与测试。
 */
export function useInterviewCommands(interviewId: string) {
  const [sessionData, setSessionData] = useState<InterviewData | null>(null);
  const [loadError, setLoadError] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const answerTypewriter = useTypewriter();
  const resetAnswerTypewriter = answerTypewriter.reset;
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [stateId, setStateId] = useState(interviewId);
  const session = useMemo(() => Symbol(interviewId), [interviewId]);
  const activeSession = useRef<symbol | null>(null);
  const isCurrent = useCallback(() => activeSession.current === session, [session]);

  // 实体切换时同步丢弃旧页状态；提交前再核对实体，避免新 GET 到达前操作旧面试。
  if (stateId !== interviewId) {
    setStateId(interviewId);
    setSessionData(null);
    setLoadError("");
    setAnswer("");
    setBusy(false);
    setError("");
  }
  const data = sessionData?.id === Number(interviewId) ? sessionData : null;

  useLayoutEffect(() => {
    activeSession.current = session;
    resetAnswerTypewriter();
    return () => { activeSession.current = null; };
  }, [session, resetAnswerTypewriter]);

  const setData = useCallback((next: SetStateAction<InterviewData | null>) => {
    if (isCurrent()) setSessionData(next);
  }, [isCurrent]);

  const refetch = useCallback(() => jsonFetch<InterviewData>(`/api/interviews/${interviewId}`), [interviewId]);

  useEffect(() => {
    let cancelled = false;
    refetch().then((next) => {
      if (!cancelled && isCurrent()) setData(next);
    }).catch((reason) => {
      if (!cancelled && isCurrent()) setLoadError(errorMessage(reason));
    });
    return () => { cancelled = true; };
  }, [refetch, loadAttempt, isCurrent, setData]);

  const current = data?.turns.find((turn) => !turn.answered_at);
  const answeredCount = data?.turns.filter((turn) => turn.answered_at).length ?? 0;

  function setTurnNotebook(turnId: number, notebookId: number | null) {
    setData((previous) => previous ? {
      ...previous,
      turns: previous.turns.map((turn) => turn.id === turnId ? { ...turn, notebook_id: notebookId } : turn),
    } : previous);
  }

  function updateTurnData(turnId: number, updated: Partial<InterviewTurn>) {
    setData((previous) => previous ? {
      ...previous,
      turns: previous.turns.map((turn) => turn.id === turnId ? { ...turn, ...updated } : turn),
    } : previous);
  }

  async function generateReportDirectly() {
    if (!isCurrent() || !data) return;
    setError(""); setBusy(true);
    try {
      await jsonFetch(`/api/interviews/${data.id}/finish`, { method: "POST" });
      if (!isCurrent()) return;
      const updated = await refetch();
      if (isCurrent()) setData(updated);
    } catch (reason) { if (isCurrent()) setError(errorMessage(reason)); }
    finally { if (isCurrent()) setBusy(false); }
  }

  async function submitAnswer() {
    if (!isCurrent() || !data || !current) return;
    if (!answer.trim()) { setError("请先输入回答"); return; }
    setError(""); setBusy(true); answerTypewriter.reset();
    try {
      await fetchSse<{ error?: string; natural_finished?: boolean }>(`/api/interviews/${data.id}/answer`, {
        body: { turn_id: current.id, answer },
        onDelta: (delta) => { if (isCurrent()) answerTypewriter.appendDelta(delta); },
        onDone: async (body) => {
          if (!isCurrent()) return;
          answerTypewriter.flush();
          const updated = await refetch();
          if (!isCurrent()) return;
          setData(updated);
          setAnswer("");
          if (body?.natural_finished && !updated.report && !updated.reverse_interview) {
            reverse.setShowChoiceModal(true);
          }
        },
        onError: (reason) => {
          if (isCurrent()) { setError(reason.message); answerTypewriter.reset(); }
        },
      });
    } catch (reason) {
      if (isCurrent()) {
        setError(errorMessage(reason));
        answerTypewriter.reset();
      }
    } finally { if (isCurrent()) setBusy(false); }
  }

  async function finish() {
    if (!isCurrent() || !data) return;
    const confirmed = await confirmDialog({
      title: "提前结束",
      message: "确定提前结束面试并生成总结报告？未答完的题目不再计入。",
      confirmText: "结束并生成报告",
    });
    if (confirmed && isCurrent()) await generateReportDirectly();
  }

  const reverse = useReverseInterview({
    interviewId: data?.id ?? null,
    refetch,
    onData: setData,
    onSkip: generateReportDirectly,
    isCurrent,
  });

  const seriesActions = useInterviewSeriesActions({
    interviewId: data?.id ?? null,
    seriesId: data?.series_id ?? null,
    isCurrent,
  });

  return {
    data, setData, loadError, answer, setAnswer, busy, error,
    retryLoad: () => { setLoadError(""); setLoadAttempt((attempt) => attempt + 1); },
    remediating: seriesActions.remediating,
    remedialError: seriesActions.remedialError,
    advancing: seriesActions.advancing,
    advanceError: seriesActions.advanceError,
    showReverseChoiceModal: reverse.showChoiceModal,
    setShowReverseChoiceModal: reverse.setShowChoiceModal,
    showReverseInputModal: reverse.showInputModal,
    setShowReverseInputModal: reverse.setShowInputModal,
    reverseBusy: reverse.busy,
    reverseError: reverse.error,
    answerTypewriter, current, answeredCount,
    setTurnNotebook, updateTurnData, submitAnswer, generateReportDirectly,
    finish,
    handleStartReverse: reverse.openInput,
    handleSkipReverse: reverse.skip,
    handleSubmitReverse: reverse.submit,
    startRemediation: seriesActions.startRemediation,
    advance: seriesActions.advance,
  };
}
