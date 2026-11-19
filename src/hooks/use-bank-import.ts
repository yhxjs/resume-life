"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { confirmDialog } from "@/components/common/confirm-dialog";
import { bankImportQuestions, MAX_BANK_IMPORT, readBankImportPage, type BankImportPage, type BankKind } from "@/lib/bank";
import { errorMessage } from "@/lib/error-message";
import { HttpError, jsonFetch } from "@/lib/fetcher";

type Draft = { direction: string; kind: BankKind; text: string };
type ImportCommand = { controller: AbortController; draft: Draft; uncertain: boolean; checking: boolean; confirming: boolean; ready: boolean; cause: string };

export function useBankImport(refresh: () => void, canMutate: () => boolean = () => true) {
  const [draft, setDraft] = useState<Draft>({ direction: "", kind: "tech", text: "" });
  const draftRef = useRef(draft);
  const [phase, setPhase] = useState<"idle" | "submitting" | "checking" | "unknown" | "confirming">("idle");
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [recovery, setRecovery] = useState<BankImportPage | null>(null);
  const active = useRef(false);
  const command = useRef<ImportCommand | null>(null);

  useLayoutEffect(() => {
    active.current = true;
    return () => { active.current = false; command.current?.controller.abort(); command.current = null; };
  }, []);

  function isCurrent(current: ImportCommand) {
    return active.current && command.current === current && !current.controller.signal.aborted;
  }

  function change(patch: Partial<Draft>) {
    if (!active.current || command.current || !canMutate()) return;
    const next = { ...draftRef.current, ...patch };
    draftRef.current = next; setDraft(next); setNotice(null);
  }

  async function check(current: ImportCommand) {
    if (!isCurrent(current) || !current.uncertain || current.checking || current.confirming) return;
    current.checking = true; current.ready = false;
    setPhase("checking"); setRecovery(null);
    try {
      const params = new URLSearchParams({ kind: current.draft.kind, limit: "50" });
      if (current.draft.direction) params.set("direction", current.draft.direction);
      const value = await jsonFetch<unknown>(`/api/bank?${params}`, { signal: current.controller.signal, cache: "no-store" });
      if (!isCurrent(current)) return;
      const page = readBankImportPage(value, current.draft.direction, current.draft.kind);
      current.ready = true; setRecovery(page);
      setNotice({ kind: "err", text: `导入结果尚未确认：${current.cause}。已重新读取当前题库，请人工核对；同文题目不能确认本批次的写入归属，空列表也不代表在途请求不会随后完成。` });
      refresh();
    } catch (reason) {
      if (!isCurrent(current)) return;
      setNotice({ kind: "err", text: `导入结果尚未确认：${current.cause}。读取题库失败：${errorMessage(reason)}。原稿已保留，请先重新读取题库，不要重复导入。` });
    } finally {
      current.checking = false;
      if (isCurrent(current)) setPhase("unknown");
    }
  }

  async function submit() {
    const input = draftRef.current;
    const count = bankImportQuestions(input.text).length;
    if (!active.current || command.current || !canMutate() || count === 0) return;
    if (count > MAX_BANK_IMPORT) { setNotice({ kind: "err", text: `每次最多导入 ${MAX_BANK_IMPORT} 道题，请分批导入` }); return; }
    const current: ImportCommand = { controller: new AbortController(), draft: { ...input, direction: input.direction.trim() }, uncertain: false, checking: false, confirming: false, ready: false, cause: "" };
    command.current = current; setPhase("submitting"); setNotice(null); setRecovery(null);
    try {
      const value = await jsonFetch<unknown>("/api/bank", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(current.draft), signal: current.controller.signal });
      if (!isCurrent(current)) return;
      if (!value || typeof value !== "object" || Array.isArray(value) || (value as { count?: unknown }).count !== count) throw new Error("导入完成响应与本批次题数不符");
      const cleared = { ...draftRef.current, text: "" };
      draftRef.current = cleared; setDraft(cleared);
      setNotice({ kind: "ok", text: `成功导入 ${count} 道题${current.draft.direction ? `（方向：${current.draft.direction}）` : ""}` });
      command.current = null; setPhase("idle"); refresh();
    } catch (reason) {
      if (!isCurrent(current)) return;
      if (reason instanceof HttpError && reason.status >= 400 && reason.status < 500 && reason.status !== 408) {
        setNotice({ kind: "err", text: errorMessage(reason) }); command.current = null; setPhase("idle");
        return;
      }
      current.uncertain = true; current.cause = errorMessage(reason);
      setNotice({ kind: "err", text: `导入结果尚未确认：${current.cause}。原稿已保留，正在只读核对题库，不会自动重复导入。` });
      await check(current);
    }
  }

  async function allowRetry() {
    const current = command.current;
    if (!current || !isCurrent(current) || current.checking || current.confirming || !current.ready) return;
    current.confirming = true; setPhase("confirming");
    const confirmed = await confirmDialog({ title: "允许再次导入", confirmText: "允许再次导入", message: `本批次包含 ${bankImportQuestions(current.draft.text).length} 道题，方向：${current.draft.direction || "未指定"}。上次导入可能已经成功，或仍会稍后完成；再次导入会新增题目，可能产生重复。确认已核对题库，保留原稿并允许再次导入？`, danger: true, signal: current.controller.signal });
    if (!isCurrent(current)) return;
    current.confirming = false;
    if (!confirmed) { setPhase("unknown"); return; }
    command.current = null; setPhase("idle"); setRecovery(null);
    setNotice({ kind: "err", text: "已保留原稿并允许再次导入，请核对或修改后再提交；这不会撤销上次请求，上次写入仍可能随后完成。" });
  }

  return { draft, change, count: bankImportQuestions(draft.text).length, phase, locked: phase !== "idle", notice, recovery, submit, allowRetry,
    canStart: () => active.current && command.current === null,
    reread: () => { const current = command.current; if (current) void check(current); } };
}
