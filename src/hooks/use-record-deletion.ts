"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { confirmDialog } from "@/components/common/confirm-dialog";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import { errorMessage } from "@/lib/error-message";

type Target = { id: number; title: string };
type Phase = "idle" | "confirming" | "deleting" | "checking" | "unknown";
export type DeletionPolicy = {
  baseUrl: string;
  confirmTitle: string;
  confirmText?: string;
  confirmMessage: (id: number, title: string) => string;
  recordLabel: string;
  listLabel: string;
} & ({
  validateExisting: (value: unknown, id: number) => void;
  readExisting?: never;
} | {
  /** 没有单项 GET 的域可用完整列表核对；false 必须表示已验证目标不存在。 */
  readExisting: (id: number, signal: AbortSignal) => Promise<boolean>;
  validateExisting?: never;
});
type Command = Target & { controller: AbortController; policy: DeletionPolicy; checking: boolean; uncertain: boolean };

/** 删除串行执行；每次命令固定对象及协议，未确认结果只能只读核对。 */
export function useRecordDeletion(policy: DeletionPolicy, onDeleted: (id: number) => void) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [target, setTarget] = useState<Target | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [deletedIds, setDeletedIds] = useState<ReadonlySet<number>>(() => new Set());
  const removed = useRef(new Set<number>());
  const mounted = useRef(false);
  const current = useRef<Command | null>(null);
  const onDeletedRef = useRef(onDeleted);

  useLayoutEffect(() => { onDeletedRef.current = onDeleted; });
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

  function release() {
    current.current = null;
    setPhase("idle");
    setTarget(null);
  }

  function complete(command: Command) {
    removed.current.add(command.id);
    setDeletedIds(new Set(removed.current));
    setError("");
    setNotice(`已确认${command.policy.recordLabel} #${command.id} 不存在，已请求刷新${command.policy.listLabel}。`);
    release();
    onDeletedRef.current(command.id);
  }

  async function check(command: Command, cause: string) {
    if (!isCurrent(command) || command.checking) return;
    command.checking = true;
    command.uncertain = true;
    setPhase("checking");
    setError("");
    const label = command.policy.recordLabel;
    try {
      let exists: boolean;
      if (command.policy.readExisting) {
        exists = await command.policy.readExisting(command.id, command.controller.signal);
      } else {
        const value = await jsonFetch<unknown>(`${command.policy.baseUrl}/${command.id}`, { signal: command.controller.signal, cache: "no-store" });
        if (!isCurrent(command)) return;
        command.policy.validateExisting(value, command.id);
        exists = true;
      }
      if (!isCurrent(command)) return;
      if (!exists) { complete(command); return; }
      setError(`${cause}；${label} #${command.id} 目前仍存在，请核对后再决定是否删除。`);
      release();
    } catch (err) {
      if (!isCurrent(command)) return;
      if (!command.policy.readExisting && err instanceof HttpError && err.status === 404) {
        complete(command);
      } else {
        setError(`${label} #${command.id} 的删除结果尚未确认：${errorMessage(err)}。请先重新读取删除状态。`);
        setPhase("unknown");
      }
    } finally {
      command.checking = false;
    }
  }

  async function remove(id: number, title: string) {
    if (!mounted.current || current.current || removed.current.has(id) || !Number.isSafeInteger(id) || id <= 0) return;
    const command: Command = { id, title, policy, controller: new AbortController(), checking: false, uncertain: false };
    current.current = command;
    setTarget({ id, title });
    setPhase("confirming");
    setError("");
    setNotice("");
    const confirmed = await confirmDialog({ title: policy.confirmTitle, message: policy.confirmMessage(id, title), danger: true, signal: command.controller.signal,
      ...(policy.confirmText ? { confirmText: policy.confirmText } : {}) });
    if (!isCurrent(command)) return;
    if (!confirmed) { release(); return; }
    setPhase("deleting");
    try {
      const result = await jsonFetch<unknown>(`${command.policy.baseUrl}/${id}`, { method: "DELETE", signal: command.controller.signal });
      if (!isCurrent(command)) return;
      if (!result || typeof result !== "object" || Array.isArray(result) || (result as { ok?: unknown }).ok !== true) throw new Error("删除响应不完整");
      complete(command);
    } catch (err) {
      if (!isCurrent(command)) return;
      if (err instanceof HttpError && err.status === 404) {
        complete(command);
      } else if (err instanceof HttpError && err.status >= 400 && err.status < 500 && err.status !== 408) {
        setError(`${command.policy.recordLabel} #${id}：${errorMessage(err)}`);
        release();
      } else {
        await check(command, errorMessage(err));
      }
    }
  }

  function retryCheck() {
    const command = current.current;
    if (command?.uncertain) void check(command, "上次删除响应异常");
  }

  return { phase, target, error, notice, deletedIds, busy: phase !== "idle", canStart: () => mounted.current && current.current === null, remove, retryCheck };
}
