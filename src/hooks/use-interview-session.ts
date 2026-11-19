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
import { parseInterviewDetail } from "@/lib/interview-detail";
import { assertInterviewReportReceipt } from "@/lib/interview-command-receipts";

export type { InterviewData, InterviewTurn } from "@/hooks/interview-types";

type PendingResultRead = (
  | { kind: "answer"; turnId: number; submittedAnswer: string }
  | { kind: "report" }
) & { confirmed: boolean; failure?: string };

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
  const [confirmingFinish, setConfirmingFinish] = useState(false);
  const [error, setError] = useState("");
  const [pendingRead, setPendingRead] = useState<PendingResultRead | null>(null);
  const pendingReadRef = useRef<PendingResultRead | null>(null);
  const commandRunning = useRef(false);
  const answerTypewriter = useTypewriter();
  const resetAnswerTypewriter = answerTypewriter.reset;
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [stateId, setStateId] = useState(interviewId);
  const session = useMemo(() => Symbol(interviewId), [interviewId]);
  const readControllers = useRef(new Set<AbortController>());
  const confirmationController = useRef<AbortController | null>(null);
  const initialReadPending = useRef(false);
  const activeSession = useRef<symbol | null>(null);
  const isCurrent = useCallback(() => activeSession.current === session, [session]);

  // 实体切换时同步丢弃旧页状态；提交前再核对实体，避免新 GET 到达前操作旧面试。
  if (stateId !== interviewId) {
    setStateId(interviewId);
    setSessionData(null);
    setLoadError("");
    setAnswer("");
    setBusy(false);
    setConfirmingFinish(false);
    setError("");
    setPendingRead(null);
  }
  const data = sessionData?.id === Number(interviewId) ? sessionData : null;

  useLayoutEffect(() => {
    const controllers = new Set<AbortController>();
    const confirmation = new AbortController();
    confirmationController.current = confirmation;
    readControllers.current = controllers;
    activeSession.current = session;
    pendingReadRef.current = null;
    commandRunning.current = false;
    initialReadPending.current = false;
    resetAnswerTypewriter();
    return () => {
      activeSession.current = null;
      confirmation.abort();
      if (confirmationController.current === confirmation) confirmationController.current = null;
      for (const controller of controllers) controller.abort();
      controllers.clear();
    };
  }, [session, resetAnswerTypewriter]);

  const setData = useCallback((next: SetStateAction<InterviewData | null>) => {
    if (isCurrent()) setSessionData(next);
  }, [isCurrent]);

  const refetch = useCallback(async () => {
    if (!isCurrent()) throw new DOMException("面试页面已离开", "AbortError");
    const controller = new AbortController();
    const controllers = readControllers.current;
    controllers.add(controller);
    try {
      const next = await jsonFetch<unknown>(`/api/interviews/${interviewId}`, { cache: "no-store", signal: controller.signal });
      return parseInterviewDetail(next, Number(interviewId));
    } finally { controllers.delete(controller); }
  }, [interviewId, isCurrent]);

  useEffect(() => {
    let cancelled = false;
    initialReadPending.current = true;
    refetch().then((next) => {
      if (!cancelled && isCurrent()) {
        initialReadPending.current = false;
        setData(next);
      }
    }).catch((reason) => {
      if (!cancelled && isCurrent()) {
        initialReadPending.current = false;
        setLoadError(errorMessage(reason));
      }
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

  function startCommand(recovering = false) {
    if (!isCurrent() || !data || commandRunning.current || reverse.isPending() || (!recovering && pendingReadRef.current)) return false;
    commandRunning.current = true;
    setError("");
    setBusy(true);
    return true;
  }

  function endCommand() {
    if (!isCurrent()) return;
    commandRunning.current = false;
    setBusy(false);
  }

  /** An acknowledged write is retried by GET only; a lost response is reconciled before another POST. */
  async function readCommandResult(pending: PendingResultRead) {
    if (!isCurrent()) return;
    pendingReadRef.current = pending;
    setPendingRead(pending);
    try {
      const updated = await refetch();
      if (!isCurrent()) return;
      if (!updated || updated.id !== Number(interviewId) || !Array.isArray(updated.turns)) {
        throw new Error("服务器返回的面试状态不完整");
      }
      let saved = Boolean(updated.report);
      let matchesSubmittedAnswer = true;
      if (pending.kind === "answer") {
        const turn = updated.turns.find((item) => item.id === pending.turnId);
        if (!turn || typeof turn.answered_at !== "string" || typeof turn.answer !== "string") {
          throw new Error("服务器返回的作答记录不完整");
        }
        saved = Boolean(turn.answered_at);
        matchesSubmittedAnswer = turn.answer === pending.submittedAnswer.trim();
      }
      if (pending.confirmed && !saved) throw new Error("已保存结果尚未同步，请稍后重新读取");
      setData(updated);
      pendingReadRef.current = null;
      setPendingRead(null);
      if (!saved) {
        setError(pending.failure ?? "本次操作尚未保存，可检查后重新提交");
        answerTypewriter.reset();
        return;
      }
      if (pending.kind === "answer") {
        if (matchesSubmittedAnswer) {
          setAnswer((draft) => draft === pending.submittedAnswer ? "" : draft);
        } else {
          setError("该题已保存其他作答，已读取最新结果。本地草稿已保留，请核对题目后调整。");
        }
        if (updated.status === "finished" && !updated.report && !updated.reverse_interview) reverse.setShowChoiceModal(true);
      }
    } catch (reason) {
      if (!isCurrent()) return;
      const label = pending.confirmed
        ? pending.kind === "answer" ? "作答已保存，读取结果失败" : "报告已保存，读取结果失败"
        : "保存状态暂无法确认";
      setError(`${label}：${errorMessage(reason)}。请重新读取面试状态。`);
    }
  }

  async function retryResultRead() {
    const pending = pendingReadRef.current;
    if (!pending || !startCommand(true)) return;
    try { await readCommandResult(pending); }
    finally { endCommand(); }
  }

  async function generateReportDirectly() {
    if (!startCommand()) return;
    let pending: PendingResultRead = { kind: "report", confirmed: false };
    try {
      const receipt = await jsonFetch<unknown>(`/api/interviews/${data!.id}/finish`, { method: "POST" });
      assertInterviewReportReceipt(receipt, data!.id, data!.style === "mining");
      pending = { ...pending, confirmed: true };
      await readCommandResult(pending);
    } catch (reason) {
      await readCommandResult({ ...pending, failure: errorMessage(reason) });
    } finally { endCommand(); }
  }

  async function submitAnswer() {
    if (!isCurrent() || !data || !current) return;
    if (!answer.trim()) { setError("请先输入回答"); return; }
    if (!startCommand()) return;
    answerTypewriter.reset();
    let pending: PendingResultRead = { kind: "answer", turnId: current.id, submittedAnswer: answer, confirmed: false };
    try {
      await fetchSse(`/api/interviews/${data.id}/answer`, {
        body: { turn_id: current.id, answer },
        onDelta: (delta) => { if (isCurrent()) answerTypewriter.appendDelta(delta); },
        onDone: async () => {
          if (!isCurrent()) return;
          answerTypewriter.flush();
          pending = { ...pending, confirmed: true };
          await readCommandResult(pending);
        },
      });
    } catch (reason) {
      await readCommandResult({ ...pending, failure: errorMessage(reason) });
    } finally { endCommand(); }
  }

  async function finish() {
    const controller = confirmationController.current;
    if (!isCurrent() || !data || !controller || controller.signal.aborted || commandRunning.current || pendingReadRef.current || reverse.isPending()) return;
    // 确认也占用命令锁，但不显示模型生成状态；触发按钮保持可聚焦。
    commandRunning.current = true;
    setConfirmingFinish(true);
    let confirmed = false;
    try {
      const version = data.resume_version ? `，发布版本 v${data.resume_version}${data.resume_version_name ? ` · ${data.resume_version_name}` : ""}` : "";
      confirmed = await confirmDialog({
        title: "提前结束",
        message: `将提前结束面试 #${data.id}，简历「${data.resume_title}」${version}，创建时间：${data.created_at || "未记录"}。当前显示已保存 ${answeredCount} 题，报告仅依据服务器已保存的作答，未答完的题目不再计入。${answer.trim() ? "当前输入框还有未提交草稿，草稿不会提交或计分。" : ""}`,
        confirmText: "结束并生成报告",
        signal: controller.signal,
      });
    } finally {
      if (isCurrent()) {
        commandRunning.current = false;
        setConfirmingFinish(false);
      }
    }
    if (confirmed && !controller.signal.aborted && isCurrent()) await generateReportDirectly();
  }

  const reverse = useReverseInterview({
    interviewId: data?.id ?? null,
    refetch,
    onData: setData,
    onSkip: generateReportDirectly,
    isCurrent,
    canStart: () => !commandRunning.current && pendingReadRef.current === null,
  });

  const seriesActions = useInterviewSeriesActions({
    interviewId: data?.id ?? null,
    seriesId: data?.series_id ?? null,
    roundNo: data?.round_no ?? null,
    isCurrent,
  });

  return {
    data, setData, loadError, answer, setAnswer, busy, confirmingFinish, error,
    readRecovery: pendingRead ? { kind: pendingRead.kind, confirmed: pendingRead.confirmed } : null,
    retryResultRead,
    retryLoad: () => {
      if (!isCurrent() || initialReadPending.current || !loadError) return;
      initialReadPending.current = true;
      setLoadError(""); setLoadAttempt((attempt) => attempt + 1);
    },
    remediating: seriesActions.remediating,
    remedialError: seriesActions.remedialError,
    advancing: seriesActions.advancing,
    advanceError: seriesActions.advanceError,
    advanceReadRecovery: seriesActions.readRecovery,
    retryAdvanceRead: seriesActions.retryRead,
    showReverseChoiceModal: reverse.showChoiceModal,
    setShowReverseChoiceModal: reverse.setShowChoiceModal,
    showReverseInputModal: reverse.showInputModal,
    setShowReverseInputModal: reverse.setShowInputModal,
    reverseBusy: reverse.busy,
    reverseError: reverse.error,
    reverseConflict: reverse.conflict,
    reverseReadRecovery: reverse.readRecovery,
    retryReverseRead: reverse.retryRead,
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
