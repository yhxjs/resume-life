"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { createRequestId } from "@/lib/client-request-id";
import { errorMessage } from "@/lib/error-message";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import { readReviewSubmission, type ReviewSubmission, type ReviewSubmissionInput } from "@/lib/review-records";

type Command = { input: ReviewSubmissionInput; id: string; controller: AbortController; posting: boolean; checking: boolean; missing: boolean; conflict: boolean };
type Phase = "idle" | "posting" | "checking" | "unknown" | "missing";

/** 原提交不确定时冻结原答、自评及编号；只读恢复或显式幂等重放，不能换稿认领旧历史。 */
export function useReviewSubmission(onSaved: (result: ReviewSubmission) => void) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState(""); const [conflict, setConflict] = useState(false);
  const active = useRef<Command | null>(null); const mounted = useRef(false); const savedRef = useRef(onSaved); const conflicted = useRef(false);
  useLayoutEffect(() => { savedRef.current = onSaved; });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; active.current?.controller.abort(); active.current = null; };
  }, []);
  const isCurrent = (command: Command) => mounted.current && active.current === command && !command.controller.signal.aborted;
  const canStart = () => mounted.current && active.current === null;
  function release() { active.current = null; setPhase("idle"); }
  const clearConflict = useCallback(() => { if (active.current === null) { conflicted.current = false; setConflict(false); setError(""); } }, []);
  async function check(command: Command, attemptId?: number) {
    if (!isCurrent(command) || command.posting || command.checking) return;
    command.checking = true; command.missing = false; setPhase("checking"); setError("");
    try {
      const raw = await jsonFetch<unknown>(`/api/reviews/${command.input.cardId}/requests/${command.id}`, { cache: "no-store", signal: command.controller.signal });
      if (!isCurrent(command)) return;
      const result = readReviewSubmission(raw, command.input, command.id);
      if (attemptId !== undefined && result.attempt.id !== attemptId) throw new Error("保存回包与提交历史不符");
      setError(""); conflicted.current = false; setConflict(false); release(); savedRef.current(result);
    } catch (reason) {
      if (!isCurrent(command)) return;
      if (reason instanceof HttpError && reason.status === 404) {
        if (command.conflict) { conflicted.current = true; setConflict(true); setError("复习进度已变更，本次提交尚未找到，请重新加载最新进度后再决定是否保存。"); release(); }
        else { command.missing = true; setPhase("missing"); setError("当前未找到本次提交；在途请求仍可能完成。原答、自评和提交编号已保留，可重新读取，或显式重试同一提交，不会重复计次。"); }
      } else { setPhase("unknown"); setError(`保存结果尚未确认：${errorMessage(reason)}。请先重新读取保存状态。`); }
    } finally { command.checking = false; }
  }
  async function post(command: Command) {
    if (!isCurrent(command) || command.posting || command.checking) return;
    command.posting = true; command.missing = false; setPhase("posting"); setError("");
    try {
      const { cardId, answer, grade, expectedReviewCount, timeZone } = command.input;
      const raw = await jsonFetch<unknown>(`/api/reviews/${cardId}`, { method: "POST", signal: command.controller.signal,
        body: JSON.stringify({ answer, grade, expected_review_count: expectedReviewCount, request_id: command.id, time_zone: timeZone }) });
      if (!isCurrent(command)) return;
      const result = readReviewSubmission(raw, command.input);
      command.posting = false; await check(command, result.attempt.id);
    } catch (reason) {
      if (!isCurrent(command)) return;
      command.posting = false;
      if (reason instanceof HttpError && reason.status >= 400 && reason.status < 500 && reason.status !== 408 && reason.status !== 409) {
        setError(errorMessage(reason)); release(); return;
      }
      command.conflict = reason instanceof HttpError && reason.status === 409;
      await check(command);
    }
  }
  async function save(input: ReviewSubmissionInput) {
    if (!canStart() || conflicted.current) return;
    const command: Command = { input: { ...input }, id: "", controller: new AbortController(), posting: false, checking: false, missing: false, conflict: false };
    active.current = command; setError("");
    try { command.id = createRequestId(); } catch (reason) { setError(errorMessage(reason)); release(); return; }
    await post(command);
  }
  function reread() { const command = active.current; if (command) void check(command); }
  function retry() { const command = active.current; if (command?.missing) void post(command); }
  return { phase, error, conflict, busy: phase !== "idle", canStart, save, reread, retry, clearConflict };
}
