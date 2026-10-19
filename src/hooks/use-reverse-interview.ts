"use client";

import { useState } from "react";
import { jsonFetch } from "@/lib/fetcher";
import { errorMessage } from "@/lib/error-message";
import type { InterviewData } from "@/hooks/interview-types";

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
}: {
  interviewId: number | null;
  refetch: () => Promise<InterviewData>;
  onData: (next: InterviewData) => void;
  /** 跳过反问时的去向（当前为直接生成总结报告） */
  onSkip: () => Promise<void>;
  isCurrent: () => boolean;
}) {
  const [showChoiceModal, setShowChoiceModal] = useState(false);
  const [showInputModal, setShowInputModal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [stateId, setStateId] = useState(interviewId);
  if (stateId !== interviewId) {
    setStateId(interviewId);
    setShowChoiceModal(false);
    setShowInputModal(false);
    setBusy(false);
    setError("");
  }

  function openInput() {
    if (!isCurrent() || interviewId === null) return;
    setShowChoiceModal(false);
    setShowInputModal(true);
  }

  async function skip() {
    if (!isCurrent()) return;
    setShowChoiceModal(false);
    await onSkip();
  }

  async function submit(questionText: string) {
    if (!isCurrent() || interviewId === null) return;
    const question = questionText.trim();
    if (!question) {
      setError("请输入您的提问内容");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await jsonFetch(`/api/interviews/${interviewId}/reverse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
      });
      if (!isCurrent()) return;
      setShowInputModal(false);
      const updated = await refetch();
      if (isCurrent()) onData(updated);
    } catch (reason) {
      if (isCurrent()) setError(errorMessage(reason));
    } finally {
      if (isCurrent()) setBusy(false);
    }
  }

  return {
    showChoiceModal,
    setShowChoiceModal,
    showInputModal,
    setShowInputModal,
    busy,
    error,
    openInput,
    skip,
    submit,
  };
}
