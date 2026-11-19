"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { confirmDialog } from "@/components/common/confirm-dialog";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import { errorMessage } from "@/lib/error-message";
import { readSalaryNegotiationHistory, type SalaryNegotiationHistory } from "@/lib/salary-negotiation-history";
import { hasNewSavedNegotiationTurn, readNegotiationFinalizeResponse, readNegotiationTurnResponse } from "@/lib/salary-negotiation-response";

type Kind = "turn" | "finalize" | "delete";
type Phase = "idle" | "turn" | "finalize" | "confirm-delete" | "delete" | "checking" | "unknown";
type Command = {
  kind: Kind; before: SalaryNegotiationHistory; draft: string; controller: AbortController;
  responseReceived: boolean; checking: boolean; cause: string;
};
type Options = {
  data: SalaryNegotiationHistory | null;
  userInput: string;
  finalWords: string;
  onHistory: (history: SalaryNegotiationHistory) => void;
  onTurnSaved: (submittedDraft: string) => void;
  onFinished: () => void;
  onRecovery: () => void;
  onDeleted: () => void;
};

/** 写命令同步互斥；未知结果先只读核对，切页后所有迟到响应失效。 */
export function useSalaryNegotiationActions(options: Options) {
  const [phase, setPhaseState] = useState<Phase>("idle");
  const phaseRef = useRef<Phase>("idle");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const latest = useRef(options);
  const mounted = useRef(false);
  const current = useRef<Command | null>(null);
  function setPhase(value: Phase) { phaseRef.current = value; setPhaseState(value); }
  useLayoutEffect(() => { latest.current = options; });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      current.current?.controller.abort();
      current.current = null;
    };
  }, []);

  function isCurrent(command: Command) {
    return mounted.current && current.current === command && !command.controller.signal.aborted;
  }
  function canStart() { return mounted.current && current.current === null; }
  function release() { current.current = null; setPhase("idle"); }
  function begin(kind: Kind, draft: string): Command | null {
    const before = latest.current.data;
    if (!canStart() || !before || (kind !== "delete" && before.status !== "ongoing")) return null;
    const command: Command = { kind, before, draft, controller: new AbortController(), responseReceived: false, checking: false, cause: "" };
    current.current = command;
    setPhase(kind === "delete" ? "confirm-delete" : kind);
    setError(""); setNotice("");
    return command;
  }
  function deleted(command: Command) {
    if (!isCurrent(command)) return;
    // 导航完成前保留锁，避免旧页面又接受一次操作。
    setError("");
    setPhase("delete");
    latest.current.onDeleted();
  }
  function accept(history: SalaryNegotiationHistory) {
    latest.current = { ...latest.current, data: history };
    latest.current.onHistory(history);
    if (history.status === "finished") latest.current.onFinished();
  }

  async function check(command: Command) {
    if (!isCurrent(command) || command.checking) return;
    command.checking = true;
    setPhase("checking"); setError("");
    latest.current.onRecovery();
    try {
      const raw = await jsonFetch<unknown>(`/api/tools/salary-negotiations/${command.before.id}`, {
        signal: command.controller.signal, cache: "no-store",
      });
      if (!isCurrent(command)) return;
      const saved = readSalaryNegotiationHistory(raw, command.before.id);
      accept(saved);
      if (command.kind !== "delete" && saved.status === "finished" && saved.report) {
        setNotice("已从存档读取结束状态与复盘；本次补充是否被采用无法按请求确认，请核对保存内容。");
        release(); return;
      }
      if (command.kind === "turn" && hasNewSavedNegotiationTurn(command.before, saved, command.draft.trim())) {
        setNotice("已读取到新增的同文回合，但无法确认是否来自本次请求。原话已保留，请核对后再操作，避免重复发送。");
        release(); return;
      }
      // 收到响应后也要先完整回读，再由用户决定是否重试；不自动重发或清稿。
      // 断连时服务端仍可能运行，单次未变化的 GET 不能证明未写入。
      if (command.responseReceived) {
        setError(`${command.cause}；已重新读取当前存档，原话与结束补充已保留，请核对后再决定是否重试。`);
        release(); return;
      }
      setError("操作结果尚未确认，服务端可能仍在处理。当前只读取存档，原话与结束补充已保留，请稍后重新读取操作状态。");
      setPhase("unknown");
    } catch (reason) {
      if (!isCurrent(command)) return;
      if (reason instanceof HttpError && reason.status === 404 && command.kind === "delete") {
        deleted(command); return;
      }
      setError(`操作结果尚未确认：${errorMessage(reason)}。原话与结束补充已保留，请重新读取操作状态。`);
      setPhase("unknown");
    } finally { command.checking = false; }
  }

  async function failed(command: Command, reason: unknown) {
    if (!isCurrent(command)) return;
    command.cause = errorMessage(reason);
    if (reason instanceof HttpError) {
      // 超时只说明等待结束，服务端仍可能运行；旧存档不能据此解锁重发。
      command.responseReceived = reason.status !== 408;
      if (command.kind === "delete" && reason.status === 404) { deleted(command); return; }
      if (reason.status >= 400 && reason.status < 500 && ![408, 409].includes(reason.status)) {
        setError(command.cause); release(); return;
      }
    }
    await check(command);
  }

  async function sendTurn() {
    const draft = latest.current.userInput;
    if (!draft.trim()) return;
    const command = begin("turn", draft);
    if (!command) return;
    try {
      const raw = await jsonFetch<unknown>(`/api/tools/salary-negotiations/${command.before.id}/turn`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ user_message: draft.trim(), expected_revision: command.before.revision }),
        signal: command.controller.signal,
      });
      if (!isCurrent(command)) return;
      command.responseReceived = true;
      const saved = readNegotiationTurnResponse(raw, command.before, draft.trim());
      accept(saved);
      latest.current.onTurnSaved(draft);
      if (latest.current.userInput === draft) latest.current = { ...latest.current, userInput: "" };
      release();
    } catch (reason) { await failed(command, reason); }
  }

  async function finalize() {
    const command = begin("finalize", latest.current.finalWords);
    if (!command) return;
    try {
      const raw = await jsonFetch<unknown>(`/api/tools/salary-negotiations/${command.before.id}/finalize`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ final_words: command.draft.trim(), expected_revision: command.before.revision }),
        signal: command.controller.signal,
      });
      if (!isCurrent(command)) return;
      command.responseReceived = true;
      accept(readNegotiationFinalizeResponse(raw, command.before));
      release();
    } catch (reason) { await failed(command, reason); }
  }

  async function remove() {
    const command = begin("delete", "");
    if (!command) return;
    try {
      const confirmed = await confirmDialog({ title: "删除博弈记录", message: `薪酬演练 #${command.before.id}「${command.before.target_role}」，企业类型：${command.before.target_company_tier || "未记录"}，期望薪资：${command.before.expected_salary}，保存于 ${command.before.created_at}。将删除本场背景、全部对话回合（当前 ${command.before.turns.length} 回合）及复盘，其他演练保留。确定删除？`, danger: true, signal: command.controller.signal });
      if (!isCurrent(command)) return;
      if (!confirmed) { release(); return; }
      setPhase("delete");
      const raw = await jsonFetch<unknown>(`/api/tools/salary-negotiations/${command.before.id}`, {
        method: "DELETE", signal: command.controller.signal,
      });
      if (!isCurrent(command)) return;
      command.responseReceived = true;
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || (raw as { ok?: unknown }).ok !== true) throw new Error("删除响应不完整");
      deleted(command);
    } catch (reason) { await failed(command, reason); }
  }

  function retryCheck() {
    const command = current.current;
    if (command && phaseRef.current === "unknown") void check(command);
  }
  return { phase, error, notice, busy: phase !== "idle", canStart, sendTurn, finalize, remove, retryCheck };
}
