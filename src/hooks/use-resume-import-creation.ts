"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { confirmDialog } from "@/components/common/confirm-dialog";
import { errorMessage } from "@/lib/error-message";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import { assertImportedResumeSaved, type ImportedResumeDraft } from "@/lib/resume-import-response";
import { readResumeOptions, type ResumeOption } from "./use-resume-options";
import { createRequestId } from "@/lib/client-request-id";
import { readResumeCreationReceipt } from "@/lib/resume-creation-contract";
import { assertResumeImportSessionUnchanged, discardResumeImportDraft, emptyResumeImportEditor, readResumeImportSession, replaceResumeImportSession, RESUME_IMPORT_SESSION_KEY, type ResumeImportEditorState, type ResumeImportSession } from "@/lib/resume-import-session";

type Command = { controller: AbortController; snapshot: ImportedResumeDraft | null; editor: ResumeImportEditorState | null; token: string; recovery: string | null | undefined; id?: number; receipt?: true; receiptState?: "succeeded" | "deleted"; posting?: boolean; checking: boolean; confirming: boolean; ready: boolean; cause: string; navigated?: boolean };
export type ImportCreationPhase = "idle" | "posting" | "replaying" | "checking" | "unknown" | "confirming" | "navigating";

/** 新命令可用原编号主动重试；旧命令只读核对，另建必须先核对并确认重复风险。 */
export function useResumeImportCreation(onCreated: (id: number) => void, options?: {
  getEditor: () => ResumeImportEditorState;
  onRestore: (editor: ResumeImportEditorState) => void;
}) {
  const [phase, setPhase] = useState<ImportCreationPhase>("idle");
  const [error, setError] = useState("");
  const [recovery, setRecovery] = useState<ResumeOption[] | null>(null);
  const [restoreError, setRestoreError] = useState("");
  const [restored, setRestored] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [rawRecovery, setRawRecovery] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);
  const [retrySupported, setRetrySupported] = useState(false);
  const mounted = useRef(false);
  const initializing = useRef(false);
  const discardCommand = useRef<AbortController | null>(null);
  const command = useRef<Command | null>(null);
  const latest = useRef(onCreated);
  const latestOptions = useRef(options);
  const editorRecovery = useRef<string | null | undefined>(undefined);
  useLayoutEffect(() => { latest.current = onCreated; latestOptions.current = options; });
  useLayoutEffect(() => {
    mounted.current = true;
    initializing.current = true;
    const lifecycle = new AbortController();
    let raw: string | null | undefined;
    try {
      raw = sessionStorage.getItem(RESUME_IMPORT_SESSION_KEY);
      const session = readResumeImportSession(raw);
      editorRecovery.current = session ? raw : sessionStorage.getItem(RESUME_IMPORT_SESSION_KEY);
      if (!session) initializing.current = false;
      if (session?.pending) command.current = { controller: new AbortController(), snapshot: session.pending.snapshot,
        editor: session.editor, token: session.pending.token, recovery: raw, id: session.pending.id, receipt: session.pending.receipt,
        checking: false, confirming: false, ready: false, cause: "上次创建结果尚未确认" };
      queueMicrotask(() => {
        if (lifecycle.signal.aborted || !mounted.current) return;
        if (session) { latestOptions.current?.onRestore(session.editor); setRestored(true); }
        if (session?.pending) {
          setRetrySupported(Boolean(session.pending.receipt));
          setPhase("unknown"); setError("已恢复上次导入和待核对的创建结果，请重新读取；不会自动解析或重新创建。");
        }
        initializing.current = false;
      });
    } catch (reason) {
      const cause = errorMessage(reason);
      command.current = { controller: new AbortController(), snapshot: null, editor: null, token: "", recovery: raw, checking: false, confirming: false, ready: false, cause };
      queueMicrotask(() => {
        if (lifecycle.signal.aborted || !mounted.current) return;
        setRestoreError(cause); setPhase("unknown");
        setError(`无法读取导入恢复信息：${cause}。此前创建仍可能已保存，请先读取简历列表核对。`);
        setRawRecovery(raw ?? null);
        initializing.current = false;
      });
    }
    return () => { lifecycle.abort(); mounted.current = false; command.current?.controller.abort(); command.current = null; discardCommand.current?.abort(); discardCommand.current = null; };
  }, []);
  const isCurrent = (current: Command) => mounted.current && command.current === current && !current.controller.signal.aborted;
  const canStart = () => mounted.current && !initializing.current && command.current === null && discardCommand.current === null;
  const canReplay = (current: Command | null) => Boolean(current && isCurrent(current) && !initializing.current &&
    current.receipt && current.snapshot && current.editor && !current.receiptState && !current.posting &&
    !current.checking && !current.confirming && !current.navigated);
  function persist(current: Command, value: ResumeImportSession | null) {
    if (current.recovery === undefined) throw new Error("无法核对原导入恢复记录，请刷新页面重新核对");
    current.recovery = replaceResumeImportSession(current.recovery, value);
    editorRecovery.current = current.recovery;
  }

  async function discard() {
    if (!canStart()) return;
    const controller = new AbortController();
    discardCommand.current = controller; setDiscarding(true);
    let recovery: string | null;
    try {
      if (editorRecovery.current === undefined) throw new Error("无法核对原导入恢复记录，请刷新页面重新核对");
      assertResumeImportSessionUnchanged(editorRecovery.current);
      recovery = editorRecovery.current;
    }
    catch (reason) {
      setError(`无法读取待清除的导入暂存：${errorMessage(reason)}。原稿仍保留。`);
      discardCommand.current = null; setDiscarding(false); return;
    }
    const confirmed = await confirmDialog({ title: "清除导入暂存", confirmText: "清除暂存", danger: true,
      message: "清除当前标签页暂存的原文和校对草稿，重新开始导入？已保存的简历不会被删除。", signal: controller.signal });
    if (!mounted.current || controller.signal.aborted || discardCommand.current !== controller) return;
    if (confirmed) {
      try {
        discardResumeImportDraft(recovery);
        editorRecovery.current = null;
        latestOptions.current?.onRestore(emptyResumeImportEditor());
        setRestored(false); setStorageError(""); setError("");
      } catch (reason) { setError(`无法清除导入暂存：${errorMessage(reason)}。原稿仍保留。`); }
    }
    discardCommand.current = null; setDiscarding(false);
  }

  function saveEditor(editor: ResumeImportEditorState): boolean {
    if (!canStart()) return false;
    try {
      if (editorRecovery.current === undefined) throw new Error("无法核对原导入恢复记录，请刷新页面重新核对");
      editorRecovery.current = replaceResumeImportSession(editorRecovery.current, { editor, pending: null });
      setStorageError("");
      return true;
    } catch (reason) { setStorageError(`暂存失败：${errorMessage(reason)}。当前内容仍在页面内，刷新或离页可能丢失，请先复制原文。`); return false; }
  }

  async function check(current: Command) {
    if (!isCurrent(current) || current.posting || current.checking || current.confirming || current.navigated) return;
    current.checking = true; current.ready = false;
    setPhase("checking"); setRecovery(null);
    try {
      // 回执在服务端与简历同事务提交，不能凭列表同文或不可信的创建 ID 认领结果。
      let receiptConfirmed = !current.receipt;
      if (current.receipt) {
        try {
          const raw = await jsonFetch<unknown>(`/api/resumes/requests/${current.token}`, { signal: current.controller.signal, cache: "no-store" });
          if (!isCurrent(current)) return;
          const receipt = readResumeCreationReceipt(raw, current.token);
          current.receiptState = receipt.status;
          setRetrySupported(false);
          if (receipt.status === "deleted") throw new Error("该次创建的简历已删除，请核对后决定是否另建");
          current.id = receipt.id;
          if (!current.editor || !current.snapshot) throw new Error("创建回执对应的草稿不完整");
          persist(current, { editor: current.editor, pending: { token: current.token, snapshot: current.snapshot, id: receipt.id, receipt: true } });
          receiptConfirmed = true;
        } catch (reason) {
          if (!isCurrent(current)) return;
          current.cause = errorMessage(reason);
        }
      }
      if (receiptConfirmed && current.id !== undefined && current.snapshot) {
        try {
          const saved = await jsonFetch<unknown>(`/api/resumes/${current.id}`, { signal: current.controller.signal, cache: "no-store" });
          if (!isCurrent(current)) return;
          assertImportedResumeSaved(saved, current.id, current.snapshot);
          persist(current, null);
          setError(""); setPhase("navigating"); latest.current(current.id); current.navigated = true; return;
        } catch (reason) {
          if (!isCurrent(current)) return;
          current.cause = errorMessage(reason);
        }
      }
      const raw = await jsonFetch<unknown>("/api/resumes", { signal: current.controller.signal, cache: "no-store" });
      if (!isCurrent(current)) return;
      const rows = readResumeOptions(raw);
      current.ready = true; setRecovery(rows);
      setError(`导入结果尚未确认：${current.cause}。已读取简历列表，请打开存档人工核对；同标题或同内容不能确认本次写入，空列表也不代表在途请求不会随后完成。`);
      setPhase("unknown");
    } catch (reason) {
      if (!isCurrent(current)) return;
      setError(`导入结果尚未确认：${current.cause}。读取简历列表失败：${errorMessage(reason)}。草稿已保留，请重新读取，避免重复创建。`);
      setPhase("unknown");
    } finally { current.checking = false; }
  }

  async function submit(current: Command, replaying = false) {
    if (!isCurrent(current) || current.posting || current.checking || current.confirming || current.navigated || !current.snapshot || !current.editor) return;
    const { snapshot, editor, token } = current;
    current.posting = true; current.ready = false;
    setPhase(replaying ? "replaying" : "posting"); setError(""); setRecovery(null);
    if (replaying) {
      try {
        if (current.recovery === undefined) throw new Error("无法核对原导入恢复记录，请刷新页面重新核对");
        assertResumeImportSessionUnchanged(current.recovery);
        const stored = readResumeImportSession(current.recovery);
        if (!stored?.pending?.receipt || stored.pending.token !== token ||
          JSON.stringify(stored.pending.snapshot) !== JSON.stringify(snapshot) || JSON.stringify(stored.editor) !== JSON.stringify(editor)) {
          throw new Error("导入暂存已改变，请重新核对原稿");
        }
      } catch (reason) {
        current.posting = false; setPhase("unknown");
        setError(`无法重试本次导入：${errorMessage(reason)}。本次未提交，原结果仍待核对。`); return;
      }
    }
    try {
      const raw = await jsonFetch<unknown>("/api/resumes", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": token }, body: JSON.stringify(snapshot), signal: current.controller.signal });
      if (!isCurrent(current)) return;
      const id = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { id?: unknown }).id : undefined;
      if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) throw new Error("创建响应缺少有效简历 ID");
      current.id = id;
      persist(current, { editor, pending: { token, snapshot, id, receipt: true } });
      current.posting = false;
      await check(current);
    } catch (reason) {
      if (!isCurrent(current)) return;
      // 409/408 可能来自旧世代或结果不明的请求，仍进入只读核对。
      current.posting = false;
      if (!replaying && reason instanceof HttpError && reason.status >= 400 && reason.status < 500 && ![408, 409].includes(reason.status)) {
        try { persist(current, { editor, pending: null }); }
        catch (storageReason) { current.cause = `请求已拒绝，但无法更新恢复记录：${errorMessage(storageReason)}`; await check(current); return; }
        command.current = null; setRetrySupported(false); setPhase("idle"); setError(errorMessage(reason)); return;
      }
      current.cause = errorMessage(reason);
      await check(current);
    } finally { current.posting = false; }
  }

  async function start(draft: ImportedResumeDraft) {
    if (!canStart()) return;
    const snapshot = structuredClone({ ...draft, title: draft.title.trim() || "导入的简历" });
    const editor = structuredClone(latestOptions.current?.getEditor() ?? { ...emptyResumeImportEditor(), draft });
    let token: string;
    let recovery: string;
    try {
      token = createRequestId();
      if (editorRecovery.current === undefined) throw new Error("无法核对原导入恢复记录，请刷新页面重新核对");
      recovery = replaceResumeImportSession(editorRecovery.current, { editor, pending: { token, snapshot, receipt: true } })!;
      editorRecovery.current = recovery;
    } catch (reason) { setError(`无法暂存创建恢复信息，本次未提交：${errorMessage(reason)}`); return; }
    const current: Command = { controller: new AbortController(), snapshot, editor, token, recovery, receipt: true, checking: false, confirming: false, ready: false, cause: "" };
    command.current = current;
    setRetrySupported(true);
    await submit(current);
  }

  async function replay() {
    const current = command.current;
    if (!current || !canReplay(current)) return;
    await submit(current, true);
  }

  async function allowRetry() {
    const current = command.current;
    if (!current || !isCurrent(current) || !current.ready || current.posting || current.checking || current.confirming || current.navigated) return;
    current.confirming = true; setPhase("confirming");
    const confirmed = await confirmDialog({ title: "允许再次创建简历", confirmText: "允许再次创建", danger: true,
      message: `简历：${current.snapshot?.title ?? "恢复信息损坏，标题未知"}。上次导入可能已经保存或仍会稍后完成；再次创建可能产生两份简历。确认已核对存档，${current.editor ? "保留草稿并允许再次创建" : "清除本页损坏的恢复信息并重新导入"}？`, signal: current.controller.signal });
    if (!isCurrent(current)) return;
    current.confirming = false;
    if (!confirmed) { setPhase("unknown"); return; }
    try { persist(current, { editor: current.editor ?? latestOptions.current?.getEditor() ?? emptyResumeImportEditor(), pending: null }); }
    catch (reason) { setPhase("unknown"); setError(`无法更新恢复信息：${errorMessage(reason)}。尚未允许再次创建。`); return; }
    command.current = null; setPhase("idle"); setRecovery(null);
    setRetrySupported(false);
    setRestoreError(""); setRawRecovery(null); setStorageError("");
    setError("已保留草稿并允许再次创建，请核对后再提交；这不会撤销上次请求。");
  }

  return { phase, error, recovery, restoreError, rawRecovery, restored, storageError, saveEditor, discard, discarding, locked: phase !== "idle" || discarding, canStart, start, allowRetry,
    retrySupported, retryAvailable: phase === "unknown" && retrySupported, replay,
    reread: () => { const current = command.current; if (current) void check(current); } };
}
