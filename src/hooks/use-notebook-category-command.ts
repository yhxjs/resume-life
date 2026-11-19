"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { confirmDialog } from "@/components/common/confirm-dialog";
import { errorMessage } from "@/lib/error-message";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import { readCreatedNotebookCategory, readNotebookCategories, readNotebookCategory, readNotebookCategoryAssignment, type NotebookCategory } from "@/lib/notebook-records";

export type NotebookCategoryCommand =
  | { kind: "create"; name: string }
  | { kind: "rename"; id: number; name: string }
  | { kind: "delete"; id: number; name: string; entryCount: number }
  | { kind: "move"; id: number; categoryId: number | null; question: string };
type CreatedCategory = Pick<NotebookCategory, "id" | "name">;
type ActiveCommand = {
  input: NotebookCategoryCommand;
  controller: AbortController;
  checking: boolean;
  uncertain: boolean;
  baselineCategoryIds: Set<number> | null;
};
type Phase = "idle" | "confirming" | "writing" | "checking" | "unknown";
const categoryRoot = "/api/notebook/categories";
function commandLabel(input: NotebookCategoryCommand) {
  return input.kind === "move" ? `错题 #${input.id} → ${input.categoryId === null ? "未分类" : `分类 #${input.categoryId}`}`
    : input.kind === "create" ? `分类「${input.name}」` : `分类 #${input.id}「${input.name}」`;
}

/** 固定本次对象；未知结果只能重读，不自动重复写入或用坏回包清空原稿。 */
export function useNotebookCategoryCommand(onCompleted: (command: NotebookCategoryCommand, created?: CreatedCategory) => void, onLockChange?: (locked: boolean) => void) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const active = useRef<ActiveCommand | null>(null);
  const mounted = useRef(false);
  const completedRef = useRef(onCompleted); const lockRef = useRef(onLockChange);
  useLayoutEffect(() => { completedRef.current = onCompleted; lockRef.current = onLockChange; });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; active.current?.controller.abort(); active.current = null; };
  }, []);
  const isCurrent = (command: ActiveCommand) => mounted.current && active.current === command && !command.controller.signal.aborted;
  function release() { active.current = null; setPhase("idle"); lockRef.current?.(false); }
  function finish(command: ActiveCommand, created?: CreatedCategory) {
    const input = command.input;
    const label = commandLabel(input);
    setError(""); setNotice(command.uncertain ? `已只读核对${label}当前符合本次选择，已请求刷新。` : `${label}操作完成，已请求刷新。`);
    release(); completedRef.current(input, created);
  }
  async function check(command: ActiveCommand) {
    if (!isCurrent(command) || command.checking) return;
    command.checking = true; command.uncertain = true; setPhase("checking"); setError("");
    const input = command.input;
    try {
      const url = input.kind === "create" ? categoryRoot : input.kind === "move" ? `/api/notebook/${input.id}` : `${categoryRoot}/${input.id}`;
      const value = await jsonFetch<unknown>(url, { signal: command.controller.signal, cache: "no-store" });
      if (!isCurrent(command)) return;
      if (input.kind === "create") {
        const existing = readNotebookCategories(value).find(category => category.name === input.name);
        if (existing && command.baselineCategoryIds?.has(existing.id) === false) { finish(command, existing); return; }
      } else if (input.kind === "move") {
        if (readNotebookCategoryAssignment(value, input.id) === input.categoryId) { finish(command); return; }
      } else {
        const category = readNotebookCategory(value, input.id);
        if (input.kind === "rename" && category.name === input.name) { finish(command); return; }
      }
      setError(`${commandLabel(input)}：当前读取的状态尚未符合本次操作，原稿已保留。上次请求仍可能稍后完成，请核对后再操作。`); release();
    } catch (reason) {
      if (!isCurrent(command)) return;
      if (reason instanceof HttpError && reason.status === 404 && input.kind !== "create") {
        if (input.kind === "delete") finish(command);
        else { setError(`${input.kind === "move" ? "错题" : "分类"}已不存在，原稿已保留，请关闭并刷新目录。`); release(); }
      } else {
        setError(`分类操作结果尚未确认（${commandLabel(input)}）：${errorMessage(reason)}。原稿已保留，请先只读核对，不要重复提交。`); setPhase("unknown");
      }
    } finally { command.checking = false; }
  }
  async function run(input: NotebookCategoryCommand) {
    if (!mounted.current || active.current) return;
    input = { ...input };
    if (input.kind === "create" || input.kind === "rename") {
      const name = input.name.trim();
      if (!name || name.length > 30) { setError(!name ? "请输入分类名称" : "分类名称不能超过 30 个字"); return; }
      input = { ...input, name };
    }
    const command: ActiveCommand = {
      input, controller: new AbortController(), checking: false, uncertain: false, baselineCategoryIds: null,
    };
    active.current = command; lockRef.current?.(true); setError(""); setNotice("");
    if (input.kind === "delete") {
      setPhase("confirming");
      const confirmed = await confirmDialog({ title: "删除分类", confirmText: "删除", danger: true,
        signal: command.controller.signal,
        message: `删除分类 #${input.id}「${input.name}」？当前列表显示 ${input.entryCount} 道题；其中错题仅变为未分类，收藏快照、复习卡、复习历史和求职准备关联继续保留。` });
      if (!isCurrent(command)) return;
      if (!confirmed) { release(); return; }
    }
    setPhase("writing");
    if (input.kind === "create") {
      try {
        const value = await jsonFetch<unknown>(categoryRoot, { signal: command.controller.signal, cache: "no-store" });
        if (!isCurrent(command)) return;
        command.baselineCategoryIds = new Set(readNotebookCategories(value).map(category => category.id));
      } catch {
        if (!isCurrent(command)) return;
      }
    }
    try {
      const url = input.kind === "create" ? categoryRoot : input.kind === "move" ? `/api/notebook/${input.id}` : `${categoryRoot}/${input.id}`;
      const method = input.kind === "create" ? "POST" : input.kind === "delete" ? "DELETE" : "PATCH";
      const body = input.kind === "delete" ? undefined : JSON.stringify(input.kind === "move" ? { category_id: input.categoryId } : { name: input.name });
      const value = await jsonFetch<unknown>(url, { method, ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body }), signal: command.controller.signal });
      if (!isCurrent(command)) return;
      if (input.kind === "create") finish(command, readCreatedNotebookCategory(value, input.name));
      else {
        if (!value || typeof value !== "object" || Array.isArray(value) || (value as { ok?: unknown }).ok !== true) throw new Error("分类操作响应不完整");
        finish(command);
      }
    } catch (reason) {
      if (!isCurrent(command)) return;
      if (reason instanceof HttpError && reason.status === 404 && input.kind === "delete") { finish(command); return; }
      if (reason instanceof HttpError && reason.status >= 400 && reason.status < 500 && reason.status !== 408) {
        setError(errorMessage(reason)); release(); return;
      }
      await check(command);
    }
  }
  return { phase, busy: phase !== "idle", error, notice, run,
    canStart: () => mounted.current && active.current === null,
    reread: () => { const command = active.current; if (command?.uncertain) void check(command); } };
}
