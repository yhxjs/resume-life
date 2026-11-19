"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { jsonFetch } from "@/lib/fetcher";
import { errorMessage } from "@/lib/error-message";
import type { InterviewData } from "@/hooks/interview-types";
import { assertInterviewReverseReceipt } from "@/lib/interview-command-receipts";

type PendingReverseRead = { confirmed: boolean; question: string; failure?: string };

/**
 * 反问环节：选择弹窗 → 输入弹窗 → 提交，或直接跳过并生成报告。
 * 弹窗可见性与提交状态都属于这一条流程，因此与作答/报告流程分开持有。
 */
export function useReverseInterview({
  interviewId,
  refetch,
  onData,
  onSkip,
  isCurrent,
  canStart,
}: {
  interviewId: number | null;
  refetch: () => Promise<InterviewData>;
  onData: (next: InterviewData) => void;
  /** 跳过反问时的去向（当前为直接生成总结报告） */
  onSkip: () => Promise<void>;
  isCurrent: () => boolean;
  canStart: () => boolean;
}) {
  const [showChoiceModal, setShowChoiceModal] = useState(false);
  const [showInputModal, setShowInputModal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const conflictPending = useRef(false);
  const [readRecovery, setReadRecovery] = useState<PendingReverseRead | null>(null);
  const pendingRead = useRef<PendingReverseRead | null>(null);
  const running = useRef(false);
  const completed = useRef(false);
  const [stateId, setStateId] = useState(interviewId);
  if (stateId !== interviewId) {
    setStateId(interviewId);
    setShowChoiceModal(false);
    setShowInputModal(false);
    setBusy(false);
    setError("");
    setConflict(false);
    setReadRecovery(null);
  }

  useLayoutEffect(() => {
    running.current = false;
    pendingRead.current = null;
    completed.current = false;
    conflictPending.current = false;
  }, [interviewId, isCurrent]);

  function isPending() {
    return running.current || pendingRead.current !== null || conflictPending.current;
  }

  function openInput() {
    if (!isCurrent() || interviewId === null || isPending() || completed.current || !canStart()) return;
    setShowChoiceModal(false);
    setShowInputModal(true);
  }

  async function skip() {
    if (!isCurrent() || isPending() || completed.current || !canStart()) return;
    setShowChoiceModal(false);
    setShowInputModal(false);
    await onSkip();
  }

  function setInputOpen(open: boolean) {
    if (open) openInput();
    else if (isCurrent() && !running.current && pendingRead.current === null) {
      conflictPending.current = false;
      setConflict(false);
      setShowInputModal(false);
    }
  }

  async function readResult(pending: PendingReverseRead) {
    if (!isCurrent()) return;
    pendingRead.current = pending;
    setReadRecovery(pending);
    try {
      const updated = await refetch();
      if (!isCurrent()) return;
      if (!updated || updated.id !== interviewId || !Array.isArray(updated.turns) || updated.reverse_interview === undefined) {
        throw new Error("服务器返回的反问状态不完整");
      }
      const saved = updated.reverse_interview;
      if (saved && (typeof saved.question !== "string" || typeof saved.answer !== "string" || !saved.evaluation)) {
        throw new Error("服务器返回的反问结果不完整");
      }
      if (pending.confirmed && !saved && !updated.report) throw new Error("已保存反问尚未同步，请稍后重新读取");
      onData(updated);
      pendingRead.current = null;
      setReadRecovery(null);
      if (saved || updated.report) {
        completed.current = true;
        setShowChoiceModal(false);
        // 完整记录只证明当前状态；另一个问题或报告不代表本次草稿已保存。
        const matches = saved?.question === pending.question;
        conflictPending.current = !matches;
        setConflict(!matches);
        setShowInputModal(!matches);
        setError(matches ? "" : saved
          ? "已读取到不同的反问问题，本地草稿已保留。请复制需要的内容后查看已保存结果。"
          : "本场总结报告已生成，未读取到本次反问。本地草稿已保留，请复制需要的内容后查看已保存结果。");
      } else {
        setError(pending.failure ?? "反问尚未保存，请检查问题后重新提交");
      }
    } catch (reason) {
      if (!isCurrent()) return;
      setError(`${pending.confirmed ? "反问已保存，读取结果失败" : "反问保存状态暂无法确认"}：${errorMessage(reason)}。请重新读取反问结果。`);
    }
  }

  async function retryRead() {
    const pending = pendingRead.current;
    if (!isCurrent() || !pending || running.current || !canStart()) return;
    running.current = true;
    setBusy(true);
    setError("");
    try { await readResult(pending); }
    finally { if (isCurrent()) { running.current = false; setBusy(false); } }
  }

  async function submit(questionText: string) {
    if (!isCurrent() || interviewId === null || isPending() || completed.current || !canStart()) return;
    const question = questionText.trim();
    if (!question) {
      setError("请输入您的提问内容");
      return;
    }
    running.current = true;
    setBusy(true);
    setError("");
    let pending: PendingReverseRead = { confirmed: false, question };
    try {
      const receipt = await jsonFetch<unknown>(`/api/interviews/${interviewId}/reverse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      assertInterviewReverseReceipt(receipt, interviewId, question);
      pending = { ...pending, confirmed: true };
      await readResult(pending);
    } catch (reason) {
      await readResult({ ...pending, failure: errorMessage(reason) });
    } finally {
      if (isCurrent()) { running.current = false; setBusy(false); }
    }
  }

  return {
    showChoiceModal,
    setShowChoiceModal,
    showInputModal,
    setShowInputModal: setInputOpen,
    busy,
    error,
    conflict,
    readRecovery,
    retryRead,
    isPending,
    openInput,
    skip,
    submit,
  };
}
