"use client";

import { ResumeVersionBadge, type ResumeVersionBinding } from "@/components/resume/resume-version-badge";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { PreparationReturnLink } from "@/components/application/preparation-return-link";
import { useParams } from "next/navigation";
import { confirmDialog } from "@/components/common/confirm-dialog";
import { Loading, LoadError } from "@/components/common/ui-bits";
import { LoadingOverlay } from "@/components/common/loading-overlay";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import {
  INTRO_KIND_LABELS,
  INTRO_MAX_SENTENCES,
  INTRO_MAX_TEXT_CHARS,
  introDurationLabel,
  introWordCount,
  validateIntroSentences,
  readStoredIntroSentences,
  isIntroKind,
  type IntroKind,
  type IntroSentence,
} from "@/lib/intro";
import { btnGhost, btnPrimary, textareaShortCls, textErr } from "@/lib/ui";
import { errorMessage } from "@/lib/error-message";
import { formatIntroHistoryDate, validateExistingIntro } from "@/lib/intro-history";

type IntroVersion = { kind: IntroKind; sentences: IntroSentence[]; revision: string; read_error?: string; raw_sentences?: string };
type IntroData = ResumeVersionBinding & {
  id: number;
  resume_id: number;
  resume_title: string;
  jd: string;
  created_at: string;
  versions: IntroVersion[];
};

type PendingWrite = { kind: IntroKind; revision: string; session: number; failure: string };

function isIntroVersion(value: unknown): value is IntroVersion {
  if (!value || typeof value !== "object") return false;
  const v = value as IntroVersion;
  if (!isIntroKind(v.kind) || typeof v.revision !== "string" || !/^[a-f0-9]{64}$/.test(v.revision)) return false;
  if (v.read_error !== undefined) return typeof v.read_error === "string" && Boolean(v.read_error) &&
    typeof v.raw_sentences === "string" && Array.isArray(v.sentences) && v.sentences.length === 0;
  return !readStoredIntroSentences(JSON.stringify(v.sentences)).error;
}

function isIntroData(value: unknown, id: number): value is IntroData {
  try {
    validateExistingIntro(value, id);
    return true;
  } catch {
    return false;
  }
}

export default function IntroPage() {
  const params = useParams<{ id: string }>();
  return <IntroDetail key={params.id} introId={params.id} />;
}

function IntroDetail({ introId }: { introId: string }) {
  const [data, setData] = useState<IntroData | null>(null);
  const [loadError, setLoadError] = useState("");
  const [kind, setKind] = useState<IntroKind>("30s");
  const [maskOn, setMaskOn] = useState(false);
  const [revealed, setRevealed] = useState<ReadonlySet<number>>(new Set());
  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [busy, setBusy] = useState<"save" | "comment" | "regen" | "reload" | null>(null);
  const [actionError, setActionError] = useState("");
  const [hasConflict, setHasConflict] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const editSession = useRef(0);
  const mounted = useRef(false);
  const commandRunning = useRef(false);
  const regenerationConfirmation = useRef<AbortController | null>(null);
  const pendingWrite = useRef<PendingWrite | null>(null);
  const [readRecovery, setReadRecovery] = useState(false);
  const [recoveryError, setRecoveryError] = useState("");

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      regenerationConfirmation.current?.abort();
      regenerationConfirmation.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    jsonFetch<IntroData>(`/api/intros/${introId}`, { cache: "no-store" })
      .then((d) => {
        if (cancelled) return;
        if (!isIntroData(d, Number(introId))) throw new Error("服务器返回的自我介绍记录不完整");
        setData(d);
        if (d.versions.length > 0 && !d.versions.some((v) => v.kind === "30s")) {
          setKind(d.versions[0]!.kind);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(errorMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [introId, loadAttempt]);

  if (loadError && !data) return <LoadError message={loadError} onRetry={() => { setLoadError(""); setLoadAttempt((attempt) => attempt + 1); }} />;
  if (!data) return <Loading />;

  const current = data.versions.find((v) => v.kind === kind);
  const sentences = current?.sentences ?? [];
  const missingComments = sentences.filter((s) => !s.comment).length;

  function applyVersion(updated: IntroVersion) {
    if (!mounted.current) return;
    setData((prev) =>
      prev
        ? { ...prev, versions: prev.versions.map((v) => (v.kind === updated.kind ? updated : v)) }
        : prev
    );
  }

  function showActionError(error: unknown, session: number) {
    if (!mounted.current || editSession.current !== session) return;
    setActionError(errorMessage(error));
    if (error instanceof HttpError && error.status === 409) setHasConflict(true);
  }

  function startCommand(readOnly = false) {
    if (!mounted.current || commandRunning.current || (!readOnly && pendingWrite.current)) return false;
    commandRunning.current = true;
    if (!readOnly) setRecoveryError("");
    return true;
  }

  async function readWriteResult(pending: PendingWrite) {
    if (!mounted.current) return;
    pendingWrite.current = pending;
    setReadRecovery(true);
    setRecoveryError("");
    try {
      const latest = await jsonFetch<IntroData>(`/api/intros/${introId}`, { cache: "no-store" });
      if (!mounted.current) return;
      if (!isIntroData(latest, Number(introId))) throw new Error("服务器返回的自我介绍记录不完整");
      const saved = latest.versions.find((v) => v.kind === pending.kind);
      if (!saved) throw new Error("服务器未返回原操作版本");
      if (saved.revision !== pending.revision && saved.read_error) throw new Error("最新版本原稿异常，请先检查原稿或备份");
      applyVersion(saved);
      pendingWrite.current = null;
      setReadRecovery(false);
      const changed = saved.revision !== pending.revision;
      setRecoveryError(changed
        ? `已读取${INTRO_KIND_LABELS[pending.kind]}的最新保存版本，请核对；可能包含其他页面的修改，当前编辑草稿已保留。`
        : `${INTRO_KIND_LABELS[pending.kind]}尚未读取到新修订：${pending.failure}。上次请求仍可能稍后完成；草稿已保留，请核对后再决定是否重试。`);
      if (editSession.current === pending.session) {
        setActionError(changed ? "" : pending.failure);
        setHasConflict(false);
      }
    } catch (reason) {
      if (mounted.current) setRecoveryError(`${INTRO_KIND_LABELS[pending.kind]}保存状态暂无法确认：${errorMessage(reason)}。请重新读取保存状态。`);
    }
  }

  async function recoverWrite(reason: unknown, session: number) {
    if (!mounted.current) return;
    if (reason instanceof HttpError && reason.status >= 400 && reason.status < 500 && reason.status !== 408) {
      showActionError(reason, session);
      return;
    }
    await readWriteResult({ kind, revision: current!.revision, session, failure: errorMessage(reason) });
  }

  async function retryWriteRead() {
    const pending = pendingWrite.current;
    if (!pending || !startCommand(true)) return;
    setBusy("reload");
    try { await readWriteResult(pending); }
    finally { endCommand(); }
  }

  function checkWriteResponse(value: unknown): asserts value is IntroVersion {
    if (!isIntroVersion(value) || value.kind !== kind || value.read_error || value.revision === current?.revision) {
      throw new Error("服务器返回的版本写入结果不完整");
    }
  }

  function endCommand() {
    if (!mounted.current) return;
    commandRunning.current = false;
    setBusy(null);
  }

  async function loadLatestVersion() {
    if (!startCommand()) return;
    const session = editSession.current;
    setBusy("reload");
    try {
      const latest = await jsonFetch<IntroData>(`/api/intros/${data!.id}`, { cache: "no-store" });
      if (!mounted.current || editSession.current !== session) return;
      if (!isIntroData(latest, data!.id)) throw new Error("服务器返回的自我介绍记录不完整");
      const latestVersion = latest.versions.find((version) => version.kind === kind);
      if (editingIdx !== null && !latestVersion?.sentences[editingIdx]) {
        setActionError("版本句子已删除，请先复制当前草稿再刷新页面");
        return;
      }
      setData(latest);
      setActionError(editingIdx === null ? "已获取最新版本" : "已获取最新版本，草稿已保留；请核对已保存句子后再次保存");
    } catch (err) {
      showActionError(err, session);
    } finally {
      endCommand();
    }
  }

  function switchVersion(next: IntroKind) {
    if (next === kind) return;
    editSession.current += 1;
    setKind(next);
    setRevealed(new Set());
    setEditingIdx(null);
    setActionError("");
    setHasConflict(false);
  }

  function setMask(next: boolean) {
    if (current?.read_error || pendingWrite.current) return;
    editSession.current += 1;
    setMaskOn(next);
    setRevealed(new Set());
    setEditingIdx(null);
    setActionError("");
    setHasConflict(false);
  }

  function toggleReveal(idx: number) {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  function startEdit(idx: number) {
    if (current?.read_error) return;
    editSession.current += 1;
    setEditingIdx(idx);
    setEditDraft(sentences[idx]?.text ?? "");
    setActionError("");
    setHasConflict(false);
  }

  async function saveEdit() {
    if (current?.read_error || editingIdx === null || !editDraft.trim()) return;
    const next = sentences.map((s, i) =>
      i === editingIdx ? { text: editDraft, comment: "" } : s
    );
    const validated = validateIntroSentences(next);
    if ("error" in validated) {
      setActionError(validated.error);
      return;
    }
    if (!startCommand()) return;
    const session = editSession.current;
    setBusy("save");
    setActionError("");
    try {
      const updated = await jsonFetch<IntroVersion>(
        `/api/intros/${data!.id}/versions/${kind}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sentences: next, baseRevision: current?.revision }),
        }
      );
      checkWriteResponse(updated);
      if (updated.sentences.length !== next.length || updated.sentences.some((s, i) => s.text !== next[i]!.text || s.comment !== next[i]!.comment)) {
        throw new Error("服务器返回的保存内容与提交草稿不一致");
      }
      applyVersion(updated);
      if (mounted.current && editSession.current === session) {
        setEditingIdx(null);
        setHasConflict(false);
      }
    } catch (err) {
      await recoverWrite(err, session);
    } finally {
      endCommand();
    }
  }

  async function recomment() {
    if (current?.read_error) return;
    if (!startCommand()) return;
    const session = editSession.current;
    setBusy("comment");
    setActionError("");
    try {
      const updated = await jsonFetch<IntroVersion>(
        `/api/intros/${data!.id}/recomment`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind, baseRevision: current?.revision }),
        }
      );
      checkWriteResponse(updated);
      if (updated.sentences.length !== sentences.length || updated.sentences.some((s, i) => s.text !== sentences[i]!.text)) {
        throw new Error("服务器返回的点评正文与原句不一致");
      }
      applyVersion(updated);
      if (mounted.current && editSession.current === session) setHasConflict(false);
    } catch (err) {
      await recoverWrite(err, session);
    } finally {
      endCommand();
    }
  }

  async function regenerate() {
    if (!startCommand()) return;
    const confirmation = new AbortController();
    regenerationConfirmation.current = confirmation;
    const session = editSession.current;
    const label = INTRO_KIND_LABELS[kind];
    let submitted = false;
    try {
      if (!(await confirmDialog({
        title: `重新生成${label}`,
        message: `将丢弃当前「${label}」的全部句子与点评，按简历与 JD 重新生成，确定？`,
        signal: confirmation.signal,
      }))) return;
      if (!mounted.current || editSession.current !== session) return;
      setBusy("regen");
      setActionError("");
      submitted = true;
      const updated = await jsonFetch<IntroVersion>(
        `/api/intros/${data!.id}/regenerate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind, baseRevision: current?.revision }),
        }
      );
      checkWriteResponse(updated);
      applyVersion(updated);
      if (!mounted.current || editSession.current !== session) return;
      setRevealed(new Set());
      setEditingIdx(null);
      setHasConflict(false);
    } catch (err) {
      if (submitted) await recoverWrite(err, session);
      else showActionError(err, session);
    } finally {
      if (regenerationConfirmation.current === confirmation) regenerationConfirmation.current = null;
      endCommand();
    }
  }

  const charCount = introWordCount(sentences);
  const durationSeconds = Math.round(charCount / 4);
  const secondsPerSentence = sentences.length > 0 ? Math.round(durationSeconds / sentences.length) : 0;

  return (
    <div className="mx-auto max-w-7xl space-y-8 wrap-anywhere">
      <PreparationReturnLink />
      {/* 顶部面包屑与状态头 */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <Link
              href="/intros"
              className="text-xs font-medium text-muted transition-colors hover:text-primary"
            >
              ← 返回自我介绍工坊
            </Link>
            <span className="text-xs text-faint">/</span>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary-soft px-2.5 py-0.5 text-[11px] font-medium text-primary">
              <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-primary" />
              <span>演练与背诵</span>
            </span>
          </div>
          <h1 className="font-serif text-[26px] sm:text-[30px] font-bold text-ink leading-tight">
            自我介绍演练台 <span className="font-sans text-base sm:text-lg font-normal text-muted">· {data.resume_title}</span>{" "}<ResumeVersionBadge {...data} />
          </h1>
          <p className="mt-1 text-xs text-muted">
            创建时间：<span className="font-mono">{formatIntroHistoryDate(data.created_at)}</span> · 当前有 {data.versions.length} 个版本
          </p>
        </div>

        {/* 版本切换与背诵模式开关 */}
        <div className="flex flex-wrap items-center gap-2.5">
          <div className="inline-flex rounded-xl border border-line bg-card p-1 shadow-xs text-xs">
            {data.versions.map((v) => {
              const active = v.kind === kind;
              return (
                <button
                  key={v.kind}
                  type="button"
                  onClick={() => switchVersion(v.kind)}
                  aria-pressed={active}
                  className={`rounded-lg px-3.5 py-1.5 font-medium transition-all ${
                    active
                      ? "bg-primary text-on-primary font-bold shadow-xs"
                      : "text-muted hover:text-ink"
                  }`}
                >
                  {INTRO_KIND_LABELS[v.kind]}
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={() => setMask(!maskOn)}
            disabled={busy !== null || readRecovery || Boolean(current?.read_error)}
            className={`flex items-center gap-1.5 rounded-xl border px-3.5 py-1.5 text-xs font-bold transition-colors shadow-xs ${
              maskOn
                ? "border-accent bg-accent text-white hover:bg-accent/90"
                : "border-accent/40 bg-accent-wash text-accent hover:bg-accent hover:text-white"
            }`}
          >
            <span aria-hidden="true">🎭</span>
            <span>{maskOn ? "退出脱稿背诵" : "开启脱稿背诵遮罩"}</span>
          </button>
        </div>
      </div>

      {/* 岗位 JD 折叠卡片 */}
      <details className="group rounded-2xl border border-line bg-card p-4 shadow-card-subtle transition-all">
        <summary className="cursor-pointer text-xs font-serif font-bold text-muted hover:text-ink flex items-center justify-between list-none">
          <span className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-primary" />
            <span>查看本份自我介绍对标的目标岗位要求（JD）</span>
          </span>
          <span className="font-mono text-[11px] text-faint group-open:rotate-180 transition-transform">▼</span>
        </summary>
        <div className="mt-3 border-t border-line/60 pt-3 text-xs text-ink/90 leading-relaxed font-sans whitespace-pre-wrap max-h-52 overflow-y-auto bg-surface/30 p-3 rounded-xl">
          {data.jd}
        </div>
      </details>

      {recoveryError && <div className="space-y-2 rounded-xl border border-line bg-card p-4">
        <p role={readRecovery ? "alert" : "status"} className="text-sm text-ink">{recoveryError}</p>
        {readRecovery && <button type="button" className={btnGhost} onClick={retryWriteRead} disabled={busy !== null}>
          {busy === "reload" ? "读取中…" : "重新读取保存状态"}
        </button>}
      </div>}

      {!current ? (
        <p className="text-sm text-faint">数据异常：缺少版本内容。</p>
      ) : (
        /* 主体双栏：左演练卡片流，右朗读时长与心法指南 */
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          {/* 左侧逐句演练主面板（8 栏） */}
          <div className="space-y-4 lg:col-span-8">
            <div className="relative rounded-2xl border border-line bg-card p-6 shadow-card-subtle space-y-5">
              <LoadingOverlay
                show={busy === "regen" || busy === "comment"}
                message={busy === "regen" ? "AI 正在重新构思自我介绍…" : "AI 正在重新逐句深度点评…"}
                description={busy === "regen" ? "依据关联简历与 JD 重新生成本版，请稍候…" : "仅依据已保存句子与 JD 点评表达和相关性，不核验经历真伪。"}
              />
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3.5">
                <div className="flex items-center gap-2">
                  <span className="h-[9px] w-[9px] rounded-[1px] bg-primary" />
                  <h2 className="font-serif text-base font-bold text-ink">
                    {INTRO_KIND_LABELS[kind]} · 逐句精雕与背诵
                  </h2>
                </div>
                {!current.read_error && <div className="flex items-center gap-3 text-xs text-faint font-mono">
                  <span>共 {sentences.length} 句</span>
                  <span>约 {charCount} 字</span>
                  <span>预估 {introDurationLabel(charCount)}</span>
                </div>}
              </div>

              {current.read_error && (
                <div className="space-y-3">
                  <div role="alert" className="rounded-xl border border-danger/30 bg-danger-wash p-3 text-sm text-danger">
                    <p>本版原稿数据异常：{current.read_error}</p>
                    <p className="mt-1 text-xs">原始数据已保留，未过滤句子或自动修复。请先检查原稿；确认重新构思会替换本版，另一版保留。</p>
                  </div>
                  <details className="rounded-xl border border-line p-3">
                    <summary className="cursor-pointer text-xs font-bold text-ink">查看原始数据（只读）</summary>
                    <pre aria-label={`${INTRO_KIND_LABELS[kind]}原始数据`} className="mt-3 max-h-80 overflow-y-auto whitespace-pre-wrap wrap-anywhere text-xs text-muted">{current.raw_sentences ?? "原始数据未返回，请导出备份检查。"}</pre>
                  </details>
                  <button type="button" className={btnGhost} onClick={regenerate} disabled={busy !== null || readRecovery}>
                    {busy === "regen" ? "AI 重拟中…" : "重新构思本版"}
                  </button>
                </div>
              )}

              {/* 遮罩控制快捷栏 */}
              {!current.read_error && (maskOn ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-accent/25 bg-accent-wash/60 p-3 text-xs">
                  <span className="font-medium text-accent flex items-center gap-1.5">
                    <span>💡 脱稿模式：</span>
                    <span className="text-muted">点击单句遮罩可单独揭开/重新遮蔽</span>
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className="rounded-lg border border-line bg-card px-2.5 py-1 text-xs text-ink hover:border-primary"
                      onClick={() => setRevealed(new Set(sentences.map((_, i) => i)))}
                      disabled={revealed.size === sentences.length}
                    >
                      全部显示
                    </button>
                    <button
                      type="button"
                      className="rounded-lg border border-line bg-card px-2.5 py-1 text-xs text-ink hover:border-primary"
                      onClick={() => setRevealed(new Set())}
                      disabled={revealed.size === 0}
                    >
                      全部遮蔽
                    </button>
                  </div>
                </div>
              ) : (
                /* 非遮罩模式下的辅助操作 */
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
                  <span>修改句子后原点评会清空，可另行重新点评；点评依据已保存正文与 JD。</span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      className={btnGhost}
                      onClick={recomment}
                      disabled={busy !== null || readRecovery}
                    >
                      {busy === "comment" ? "AI 点评中…" : "重新点评整篇"}
                    </button>
                    <button
                      type="button"
                      className={btnGhost}
                      onClick={regenerate}
                      disabled={busy !== null || readRecovery}
                    >
                      {busy === "regen" ? "AI 重拟中…" : "重新构思本版"}
                    </button>
                  </div>
                </div>
              ))}

              {missingComments > 0 && !maskOn && (
                <div className="flex items-center justify-between rounded-xl bg-accent-wash px-3.5 py-2 text-xs text-accent">
                  <span>有 {missingComments} 句文字已手工修改，点评尚未同步。</span>
                  <button
                    type="button"
                    onClick={recomment}
                    disabled={busy !== null || readRecovery}
                    className="font-bold underline hover:opacity-80"
                  >
                    立即同步点评
                  </button>
                </div>
              )}

              {/* 逐句卡片列表 */}
              {editingIdx !== null && !sentences[editingIdx] && <div className="space-y-2 rounded-xl border border-line p-4">
                <p role="alert" className="text-sm text-ink">最新版本已不含原编辑位置，未提交草稿仍保留；请先复制草稿再核对原稿。</p>
                <textarea aria-label="原编辑位置的保留草稿" className={textareaShortCls} value={editDraft}
                  onChange={(event) => { editSession.current += 1; setEditDraft(event.target.value); }} />
                <button type="button" className={btnGhost} onClick={() => { editSession.current += 1; setEditingIdx(null); }}>关闭草稿</button>
              </div>}
              <div className="space-y-3 pt-1">
                {sentences.map((s, i) => {
                  const isRevealed = revealed.has(i);
                  return (
                    <div
                      key={i}
                      className="group rounded-xl border border-line bg-surface/20 p-4 transition-all hover:border-primary/40 hover:bg-card"
                    >
                      {maskOn ? (
                        /* 背诵遮罩形态 */
                        <button
                          type="button"
                          onClick={() => toggleReveal(i)}
                          aria-pressed={isRevealed}
                          className="w-full text-left"
                        >
                          <div className="flex items-center justify-between pb-2">
                            <span className="font-mono text-xs font-bold text-primary">
                              第 {String(i + 1).padStart(2, "0")} 句
                            </span>
                            <span className="text-[10px] text-faint">
                              {isRevealed ? "点击遮蔽" : "点击揭开"}
                            </span>
                          </div>
                          <p
                            className={`font-serif text-[15px] sm:text-base leading-relaxed text-ink transition-all ${
                              isRevealed ? "" : "select-none blur-[5px] opacity-70"
                            }`}
                          >
                            {s.text}
                          </p>
                        </button>
                      ) : (
                        /* 正常演练与编辑形态 */
                        <div>
                          {editingIdx === i ? (
                            <div className="space-y-3">
                              {hasConflict && <p className="text-xs text-muted">当前已保存：{s.text}</p>}
                              <textarea
                                aria-label={`${INTRO_KIND_LABELS[kind]}第 ${i + 1} 句`}
                                aria-describedby={`intro-edit-limit-${kind}-${i}`}
                                className={`${textareaShortCls} font-sans text-xs sm:text-sm`}
                                value={editDraft}
                                onChange={(e) => {
                                  editSession.current += 1;
                                  setEditDraft(e.target.value);
                                }}
                              />
                              <p id={`intro-edit-limit-${kind}-${i}`} className="text-xs text-muted">
                                {editDraft.length}/{INTRO_MAX_TEXT_CHARS} 字 · 每句上限 {INTRO_MAX_TEXT_CHARS} 字，每版上限 {INTRO_MAX_SENTENCES} 句
                              </p>
                              <div className="flex items-center justify-end gap-2">
                                <button
                                  type="button"
                                  className={btnGhost}
                                  onClick={() => {
                                    editSession.current += 1;
                                    setEditingIdx(null);
                                    setActionError("");
                                    setHasConflict(false);
                                  }}
                                >
                                  取消
                                </button>
                                <button
                                  type="button"
                                  className={btnPrimary}
                                  onClick={saveEdit}
                                  disabled={busy !== null || readRecovery || !editDraft.trim()}
                                >
                                  {busy === "save" ? "保存中…" : "保存修改"}
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div>
                              <div className="flex items-start justify-between gap-3">
                                <div className="flex items-start gap-2.5">
                                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary-soft font-mono text-[10px] font-bold text-primary mt-0.5">
                                    {String(i + 1).padStart(2, "0")}
                                  </span>
                                  <p className="font-serif text-[15px] sm:text-base leading-relaxed text-ink">
                                    {s.text}
                                  </p>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => startEdit(i)}
                                  className="shrink-0 text-xs text-muted hover:text-primary underline px-1 py-0.5"
                                >
                                  微调
                                </button>
                              </div>

                              {/* 教练点评 */}
                              <div className="mt-3 flex items-start gap-2 border-t border-line/50 pt-2 text-xs leading-relaxed text-muted">
                                <span className="font-bold text-accent shrink-0">💡 点评：</span>
                                <span>{s.comment || <span className="text-faint">文字已修改，点击上方重新点评更新</span>}</span>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {actionError && <p role="alert" className={`mt-3 text-sm ${textErr}`}>{actionError}</p>}
              {hasConflict && (
                <button type="button" className={btnGhost} onClick={loadLatestVersion} disabled={busy !== null || readRecovery}>
                  {busy === "reload" ? "获取中…" : "获取最新版本（保留草稿）"}
                </button>
              )}
            </div>
          </div>

          {/* 右侧朗读时长估算与破局心法（4 栏） */}
          {!current.read_error && <div className="space-y-5 lg:col-span-4">
            {/* 按全文字数估算朗读时长 */}
            <div className="rounded-2xl border border-line bg-card p-6 shadow-card-subtle text-center space-y-3">
              <h3 className="font-serif text-sm font-bold text-ink">预估朗读时长</h3>
              <div className="font-mono text-4xl font-bold text-primary tracking-wider py-1">
                {introDurationLabel(charCount)}
              </div>
              <p className="text-xs text-muted">
                按约 4 字/秒估算，平均约 {secondsPerSentence} 秒/句；仅供篇幅参考，以实际朗读为准。
              </p>
              <div className="flex items-center justify-center gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setMask(true)}
                  disabled={busy !== null || readRecovery}
                  className="rounded-xl bg-primary px-4 py-2 text-xs font-bold text-white shadow-xs hover:bg-primary-hover transition-colors"
                >
                  进入脱稿盲练
                </button>
              </div>
            </div>

            {/* 脱稿背诵三阶心法 */}
            <div className="rounded-2xl border border-line bg-card p-6 shadow-card-subtle space-y-3.5">
              <div className="flex items-center justify-between border-b border-line pb-2.5">
                <h3 className="font-serif text-sm font-bold text-ink">脱稿训练三阶心法</h3>
                <span className="rounded bg-accent-wash px-2 py-0.5 text-[10px] font-bold text-accent">
                  实战指南
                </span>
              </div>
              <ul className="space-y-3 text-xs leading-relaxed text-muted">
                <li className="flex items-start gap-2">
                  <span className="font-mono font-bold text-primary">01.</span>
                  <span><strong>声情并茂：</strong>大声朗读 3 遍，找到重音关键词（核心数据、系统专有名词）与换气停顿点。</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="font-mono font-bold text-primary">02.</span>
                  <span><strong>遮罩回忆：</strong>开启模糊遮罩尝试复述，想不起时点击单句揭开，再重新遮蔽练习。</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="font-mono font-bold text-primary">03.</span>
                  <span><strong>眼神交流：</strong>脱稿讲述时目光直视屏幕或考官，语速平稳，保持从容自信的气场。</span>
                </li>
              </ul>
            </div>
          </div>}
        </div>
      )}
    </div>
  );
}
