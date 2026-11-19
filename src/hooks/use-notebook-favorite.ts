"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import { errorMessage } from "@/lib/error-message";
import { readCreatedNotebookFavorite, readNotebookFavorite, type NotebookFavorite, type NotebookFavoriteSource } from "@/lib/notebook-records";

type Input = { source: NotebookFavoriteSource; sourceId: number; question: string; categoryId: number | null };
type Command = { input: Input; controller: AbortController; posting: boolean; checking: boolean; missing: boolean; existing?: NotebookFavorite };
type Phase = "idle" | "posting" | "checking" | "unknown" | "missing" | "existing";

/** 收藏结果必须按来源身份只读核对；未知命令和迟到响应不能重复写入或影响新会话。 */
export function useNotebookFavorite(onSaved: (saved: NotebookFavorite) => void) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [existing, setExisting] = useState<NotebookFavorite | null>(null);
  const mounted = useRef(false); const active = useRef<Command | null>(null); const savedRef = useRef(onSaved);
  useLayoutEffect(() => { savedRef.current = onSaved; });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; active.current?.controller.abort(); active.current = null; };
  }, []);
  const isCurrent = (command: Command) => mounted.current && active.current === command && !command.controller.signal.aborted;
  const canStart = () => mounted.current && active.current === null;
  function release() { active.current = null; setExisting(null); setPhase("idle"); }
  function finish(command: Command, saved: NotebookFavorite) {
    if (!isCurrent(command)) return;
    setError(""); setNotice("已按来源核对当前收藏及复习关联。"); release(); savedRef.current(saved);
  }
  async function check(command: Command, responseId?: number) {
    if (!isCurrent(command) || command.checking) return;
    command.checking = true; command.missing = false; command.existing = undefined;
    setExisting(null); setPhase("checking"); setError("");
    try {
      const { source, sourceId, categoryId } = command.input;
      const raw = await jsonFetch<unknown>(`/api/notebook/lookup?source=${source}&source_id=${sourceId}`, { cache: "no-store", signal: command.controller.signal });
      if (!isCurrent(command)) return;
      const saved = readNotebookFavorite(raw, source, sourceId);
      if (responseId !== undefined && saved.id !== responseId) throw new Error("收藏回包与当前来源记录不符");
      if (saved.category_id === categoryId) { finish(command, saved); return; }
      command.existing = saved; setExisting(saved); setPhase("existing");
      setError(`该来源当前已有收藏 #${saved.id}，位于${saved.category_id === null ? "未分类" : `分类 #${saved.category_id}`}，与本次选择不同。原选择已保留，不会覆盖现有快照或移动分类；请核对后使用现有收藏，或重新读取。`);
    } catch (reason) {
      if (!isCurrent(command)) return;
      if (reason instanceof HttpError && reason.status === 404) {
        command.missing = true; setPhase("missing");
        setError("当前未找到该来源的收藏，原题和分类选择已保留。上次请求仍可能稍后完成；可先重新读取，核对后再显式允许重试。");
      } else {
        setPhase("unknown"); setError(`收藏结果尚未确认：${errorMessage(reason)}。请先只读核对，不要重复提交。`);
      }
    } finally { command.checking = false; }
  }
  async function save(input: Input) {
    if (!canStart()) return;
    const command: Command = { input: { ...input }, controller: new AbortController(), posting: true, checking: false, missing: false };
    active.current = command; setPhase("posting"); setError(""); setNotice("");
    try {
      const raw = await jsonFetch<unknown>("/api/notebook", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: input.source, source_id: input.sourceId, category_id: input.categoryId }), signal: command.controller.signal });
      if (!isCurrent(command)) return;
      const created = readCreatedNotebookFavorite(raw);
      command.posting = false;
      await check(command, created.id);
    } catch (reason) {
      if (!isCurrent(command)) return;
      command.posting = false;
      if (reason instanceof HttpError && reason.status >= 400 && reason.status < 500 && reason.status !== 408 && reason.status !== 409) {
        setError(errorMessage(reason)); release(); return;
      }
      await check(command);
    }
  }
  function reread() { const command = active.current; if (command && !command.posting) void check(command); }
  function useExisting() { const command = active.current; if (command && !command.checking && command.existing) finish(command, command.existing); }
  function allowRetry() {
    const command = active.current;
    if (!command || command.checking || !command.missing || !isCurrent(command)) return;
    setError(""); setNotice("已保留分类选择并允许重试，尚未重新提交。上次请求仍可能完成；已有收藏时先核对，不会覆盖其快照或分类。"); release();
  }
  return { phase, error, notice, existing, busy: phase !== "idle", canStart, save, reread, useExisting, allowRetry };
}
