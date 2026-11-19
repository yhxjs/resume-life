"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import { errorMessage } from "@/lib/error-message";
import { readSalaryNegotiationHistory } from "@/lib/salary-negotiation-history";
import { validateGeneratedNegotiationOpening, type HrStyle } from "@/lib/salary-negotiation";
import { createRequestId } from "@/lib/client-request-id";
import { clearPendingSalaryCreation, readPendingSalaryCreation, SALARY_CREATION_STORAGE_KEY, savePendingSalaryCreation } from "@/lib/salary-creation-storage";

export type SalaryNegotiationStartInput = {
  target_company_tier: string;
  target_role: string;
  expected_salary: string;
  current_or_competing_offer: string;
  hr_style: HrStyle;
};
type Command = {
  requestId: string;
  snapshot: SalaryNegotiationStartInput;
  controller: AbortController;
  checking: boolean;
};
type Phase = "idle" | "posting" | "checking" | "unknown" | "review" | "navigating";
type Options = { historyReady: boolean; onUnknown: () => void; onCreated: (id: number) => void; onRestore?: (input: SalaryNegotiationStartInput) => void };

/** 创建响应先核对已保存的身份与背景；未知结果只读恢复，不自动重复创建。 */
export function useSalaryNegotiationCreation(options: Options) {
  const [phase, setPhaseState] = useState<Phase>("idle");
  const phaseRef = useRef<Phase>("idle");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [canCheckRequest, setCanCheckRequest] = useState(false);
  const mounted = useRef(false);
  const current = useRef<Command | null>(null);
  const storageBlocked = useRef(false);
  const blockedRecovery = useRef<{ raw: string | null } | null>(null);
  const latest = useRef(options);
  // 事件入口读取当前阶段，旧渲染留下的恢复回调不能释放后续命令。
  function setPhase(value: Phase) { phaseRef.current = value; setPhaseState(value); }
  useLayoutEffect(() => { latest.current = options; });
  useLayoutEffect(() => {
    mounted.current = true;
    let recovery: { raw: string | null } | null = null;
    try {
      recovery = { raw: sessionStorage.getItem(SALARY_CREATION_STORAGE_KEY) };
      const pending = readPendingSalaryCreation(recovery.raw);
      if (pending) {
        const restored: Command = { ...pending, controller: new AbortController(), checking: false };
        current.current = restored;
        latest.current.onRestore?.({ ...pending.snapshot });
        queueMicrotask(() => {
          if (!mounted.current || current.current !== restored) return;
          setCanCheckRequest(true); setPhase("unknown");
          setError("已恢复上次创建请求，请重新读取创建结果；不会自动重新提交或调用模型。");
        });
      }
    } catch (reason) {
      storageBlocked.current = true;
      blockedRecovery.current = recovery;
      queueMicrotask(() => {
        if (!mounted.current || !storageBlocked.current) return;
        setPhase("review"); setError(`无法读取创建恢复信息：${errorMessage(reason)}。请先核对历史记录，再显式允许新建。`);
      });
    }
    return () => {
      mounted.current = false;
      current.current?.controller.abort();
      current.current = null;
    };
  }, []);

  function isCurrent(command: Command) {
    return mounted.current && current.current === command && !command.controller.signal.aborted;
  }
  function canStart() { return mounted.current && current.current === null && !storageBlocked.current; }
  function release() { current.current = null; setCanCheckRequest(false); setPhase("idle"); }

  async function check(command: Command, responseId?: number) {
    if (!isCurrent(command) || command.checking) return;
    command.checking = true;
    setPhase("checking"); setError("");
    try {
      // 每次重新读取请求归属，不能凭同文背景认领旧记录，也不能缓存坏回执中的 ID。
      const receipt = await jsonFetch<unknown>(`/api/tools/salary-negotiations/requests/${command.requestId}`, {
        signal: command.controller.signal, cache: "no-store",
      });
      if (!isCurrent(command)) return;
      if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw new Error("创建请求回执不完整");
      const result = receipt as { request_id?: unknown; status?: unknown; id?: unknown };
      if (result.request_id !== command.requestId) throw new Error("创建请求回执编号不符");
      if (result.status === "pending") throw new Error("创建请求仍在处理中；稍后可再次只读核对");
      if (result.status === "failed" || result.status === "deleted") {
        setError(result.status === "failed" ? "该创建请求已失败，未完成本次创建；请核对历史后再显式允许新建。" : "该请求创建的演练已删除，不会复活；请核对历史后再显式允许新建。");
        setPhase("review"); latest.current.onUnknown(); return;
      }
      if (result.status !== "succeeded" || typeof result.id !== "number" || !Number.isSafeInteger(result.id) || result.id <= 0) throw new Error("创建请求回执不完整");
      if (responseId !== undefined && result.id !== responseId) throw new Error("创建响应与请求回执记录不符");
      const id = result.id;
      const raw = await jsonFetch<unknown>(`/api/tools/salary-negotiations/${id}`, {
        signal: command.controller.signal, cache: "no-store",
      });
      if (!isCurrent(command)) return;
      const saved = readSalaryNegotiationHistory(raw, id);
      if ((Object.keys(command.snapshot) as (keyof SalaryNegotiationStartInput)[]).some((key) => saved[key] !== command.snapshot[key])) {
        throw new Error("创建结果与本次提交的背景不符");
      }
      const opening = saved.turns[0];
      if (!opening || opening.turn_no !== 1 || opening.user_message !== "" || !saved.created_at.trim() || opening.created_at !== saved.created_at ||
        !validateGeneratedNegotiationOpening({
          initial_offer: saved.initial_offer, hr_response: opening.hr_response, hr_tactics: opening.hr_tactics,
          hr_mindset: opening.hr_mindset, mentor_analysis: opening.mentor_analysis,
        })) {
        throw new Error("创建结果缺少完整的开场与评估");
      }
      clearPendingSalaryCreation(command);
      setPhase("navigating");
      latest.current.onCreated(saved.id);
    } catch (reason) {
      if (!isCurrent(command)) return;
      setError(`创建结果尚未确认：${errorMessage(reason)}。原始表单已保留，请重新读取创建结果；不会重复调用模型。`);
      setPhase("unknown");
    } finally { command.checking = false; }
  }

  async function start(input: SalaryNegotiationStartInput) {
    if (!canStart()) return;
    if (!input.target_role.trim() || !input.expected_salary.trim()) {
      setError("请填写目标岗位与期望薪资"); return;
    }
    let command: Command;
    try {
      command = { requestId: createRequestId(), snapshot: { ...input }, controller: new AbortController(), checking: false };
      savePendingSalaryCreation({ requestId: command.requestId, snapshot: command.snapshot });
    } catch (reason) {
      setError(`无法保存创建恢复信息，本次未提交：${errorMessage(reason)}`); return;
    }
    current.current = command;
    setCanCheckRequest(true);
    setPhase("posting"); setError(""); setNotice("");
    try {
      const raw = await jsonFetch<unknown>("/api/tools/salary-negotiations", {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": command.requestId }, body: JSON.stringify(command.snapshot), signal: command.controller.signal,
      });
      if (!isCurrent(command)) return;
      const id = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { id?: unknown }).id : undefined;
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) throw new Error("创建响应缺少有效记录 ID");
      await check(command, id);
    } catch (reason) {
      if (!isCurrent(command)) return;
      if (reason instanceof HttpError && reason.status >= 400 && reason.status < 500 && ![408, 409].includes(reason.status)) {
        try { clearPendingSalaryCreation(command); }
        catch (storageError) {
          setError(`请求已拒绝，但无法移除恢复信息：${errorMessage(storageError)}。请先核对历史记录。`);
          setPhase("review"); latest.current.onUnknown(); return;
        }
        setError(errorMessage(reason)); release(); return;
      }
      setError(`创建结果尚未确认：${errorMessage(reason)}。仍可能已经保存，请先核对下方历史记录；不会自动重新创建。`);
      setPhase("review");
      latest.current.onUnknown();
    }
  }

  function retryCheck() {
    const command = current.current;
    if (command && (phaseRef.current === "unknown" || phaseRef.current === "review")) void check(command);
  }
  function reviewUnresolved() {
    if (!mounted.current || phaseRef.current !== "unknown" || !current.current || current.current.checking) return;
    setError("此前创建仍可能在服务端完成。请先核对历史记录；另建演练会使用新编号，可能产生两份记录，不会撤销原请求。");
    setPhase("review"); latest.current.onUnknown();
  }
  function allowRetry() {
    if (!mounted.current || phaseRef.current !== "review" || current.current?.checking || (!current.current && !storageBlocked.current) || !latest.current.historyReady) return;
    try {
      const expected = current.current ?? blockedRecovery.current;
      if (!expected) throw new Error("无法核对创建恢复信息，请刷新页面后重试");
      clearPendingSalaryCreation(expected);
    }
    catch (reason) { setError(`无法移除创建恢复信息：${errorMessage(reason)}`); return; }
    storageBlocked.current = false;
    blockedRecovery.current = null;
    setError("");
    setNotice("已允许再次创建；此前请求仍可能已保存，请先确认历史记录，避免创建重复演练。");
    release();
  }

  return { phase, error, notice, busy: phase !== "idle", canStart, start, retryCheck, reviewUnresolved, allowRetry, canCheckRequest };
}
