"use client";

import { useEffect, useRef, useState } from "react";
import { confirmDialog } from "@/components/common/confirm-dialog";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import { errorMessage } from "@/lib/error-message";
import { readProjectMaterialImportConfirmation, readProjectMaterialImportPage,
  type ProjectMaterialImportExpected, type ProjectMaterialImportPage, type ProjectMaterialImportRecovery } from "@/lib/project-material-import";

type ImportCommand = {
  controller: AbortController;
  expected: ProjectMaterialImportExpected;
  uncertain: boolean;
  checking: boolean;
  confirming: boolean;
  cause: string;
  page: ProjectMaterialImportPage | null;
};

/** 未知结果只读核对；解除锁定需要人工确认，不把同名旧材料当作本次回执。 */
export function useProjectMaterialImport(id: string, canSubmit: () => boolean, onSaved: () => Promise<void>, onError: (message: string) => void) {
  const activeProject = useRef<string | null>(null);
  const command = useRef<ImportCommand | null>(null);
  const [state, setState] = useState<{ projectId: string; uploading: boolean; recovery: ProjectMaterialImportRecovery | null } | null>(null);
  useEffect(() => {
    activeProject.current = id;
    const currentCommand = command;
    const active = activeProject;
    return () => { active.current = null; currentCommand.current?.controller.abort(); currentCommand.current = null; };
  }, [id]);

  function isCurrent(current: ImportCommand) {
    return activeProject.current === id && command.current === current && !current.controller.signal.aborted;
  }
  function show(current: ImportCommand, phase: ProjectMaterialImportRecovery["phase"], message: string) {
    setState({ projectId: id, uploading: false, recovery: { phase, message, page: current.page } });
  }
  async function check(current: ImportCommand) {
    if (!isCurrent(current) || !current.uncertain || current.checking || current.confirming) return;
    current.checking = true; current.page = null;
    show(current, "checking", `导入结果尚未确认：${current.cause}。原稿已保留，正在只读核对材料列表。`);
    try {
      const value = await jsonFetch<unknown>(`/api/projects/${id}?limit=50`, { cache: "no-store", signal: current.controller.signal });
      if (!isCurrent(current)) return;
      current.page = readProjectMaterialImportPage(value, id);
      show(current, "unknown", `导入结果尚未确认：${current.cause}。已读取最近的材料，同名材料不能确认本次导入，空列表也不代表在途请求不会随后完成。请核对后再决定是否解除锁定。`);
    } catch (reason) {
      if (isCurrent(current)) show(current, "unknown", `导入结果尚未确认：${current.cause}。读取材料列表失败：${errorMessage(reason)}。原稿已保留，请重新读取，不要重复导入。`);
    } finally { current.checking = false; }
  }
  async function submitImport(request: (signal: AbortSignal) => Promise<Response>, expected: ProjectMaterialImportExpected): Promise<boolean> {
    if (activeProject.current !== id || command.current || !canSubmit()) return false;
    const current: ImportCommand = { controller: new AbortController(), expected, uncertain: false, checking: false, confirming: false, cause: "", page: null };
    command.current = current;
    onError(""); setState({ projectId: id, uploading: true, recovery: null });
    try {
      const response = await request(current.controller.signal);
      const body: unknown = await response.json().catch(() => null);
      if (!isCurrent(current)) return false;
      if (!response.ok) {
        const error = body && typeof body === "object" ? (body as { error?: unknown }).error : null;
        throw new HttpError(typeof error === "string" && error.trim() ? error : `HTTP ${response.status}`, response.status);
      }
      readProjectMaterialImportConfirmation(body, expected);
      await onSaved();
      return isCurrent(current);
    } catch (reason) {
      if (!isCurrent(current)) return false;
      if (reason instanceof HttpError && reason.status >= 400 && reason.status < 500 && reason.status !== 408) {
        onError(errorMessage(reason));
      } else {
        current.uncertain = true; current.cause = errorMessage(reason);
        await check(current);
      }
      return false;
    } finally {
      if (isCurrent(current) && !current.uncertain) { command.current = null; setState(null); }
    }
  }
  async function allowImportRetry() {
    const current = command.current;
    if (!current || !isCurrent(current) || !current.uncertain || !current.page || current.checking || current.confirming) return;
    current.confirming = true;
    show(current, "confirming", "等待确认解除导入锁定；原稿仍保留。");
    const confirmed = await confirmDialog({ title: "解除材料导入锁定", confirmText: "保留原稿并解除锁定", danger: true,
      message: `材料「${current.expected.title}」的上次导入可能已成功，或仍会稍后完成。再次导入可能产生重复。确认已核对材料列表，保留当前输入并解除锁定？`, signal: current.controller.signal });
    if (!isCurrent(current)) return;
    current.confirming = false;
    if (!confirmed) { show(current, "unknown", "导入结果仍未确认，原稿已保留，请继续核对材料；再次导入仍被锁定。"); return; }
    command.current = null;
    show(current, "idle", "已保留当前输入并解除锁定。上次请求仍可能随后完成，再次导入可能产生重复；请核对或修改输入后再提交。");
  }
  const currentState = state?.projectId === id ? state : null;
  const recovery = currentState?.recovery ?? null;
  return { submitImport, uploading: currentState?.uploading ?? false, importRecovery: recovery,
    importLocked: Boolean(currentState?.uploading || (recovery && recovery.phase !== "idle")),
    rereadImport: () => { const current = command.current; return current ? check(current) : Promise.resolve(); }, allowImportRetry };
}
