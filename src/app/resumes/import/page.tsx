"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MODULE_KEYS, MODULE_LABELS, defaultContent, type CustomItem, type ModuleKey, type ProjectItem, type WorkItem } from "@/lib/modules";
import {
  BasicEditor,
  ListEditor,
  SkillsEditor,
  SummaryEditor,
  type ItemDraft,
} from "@/components/resume/module-editors";
import { CustomEditor, ProjectsEditor, WorkEditor } from "@/components/resume/projects-editor";
import { ImportProofingWorkbench } from "@/components/resume/import-proofing-workbench";
import { SectionTitle } from "@/components/common/ui-bits";
import { LoadingOverlay } from "@/components/common/loading-overlay";
import { btnGhost, btnPrimary, textareaTallCls } from "@/lib/ui";
import { jsonFetch } from "@/lib/fetcher";
import { apiFetch } from "@/lib/api-fetch";
import { errorMessage } from "@/lib/error-message";
import { readImportedResumeDraft, readImportedResumeOcr, type ImportedResumeOcr } from "@/lib/resume-import-response";
import { useResumeImportCreation } from "@/hooks/use-resume-import-creation";
import { emptyResumeImportEditor, redactResumeImportRecovery, type ResumeImportEditorState } from "@/lib/resume-import-session";
import { readResumeImportSourceReceipt, type ResumeImportSourceReceipt } from "@/lib/resume-import-source-contract";

type Draft = { title: string; modules: Record<string, unknown> };

export default function ImportPage() {
  const router = useRouter();
  const [source, setSource] = useState<"paste" | "file">("paste");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [pdfAsImages, setPdfAsImages] = useState(false);
  const pdfAsImagesRef = useRef(false);
  const [reextractFile, setReextractFile] = useState(false);
  const reextractFileRef = useRef(false);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const draftRef = useRef<Draft | null>(null);
  const [manualDraft, setManualDraft] = useState(false);
  const [recoveredText, setRecoveredText] = useState("");
  const [recoveryReady, setRecoveryReady] = useState(false);
  const [sourceIssue, setSourceIssue] = useState<ResumeImportEditorState["sourceIssue"]>(null);
  const [ocrInfo, setOcrInfo] = useState<ImportedResumeOcr | null>(null);
  const [aiConfigured, setAiConfigured] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const parseControllerRef = useRef<AbortController | null>(null);
  const recoveredSourceRef = useRef<string | null>(null);
  const mountedRef = useRef(false);
  const editorRef = useRef<ResumeImportEditorState>(emptyResumeImportEditor());
  const supersededSources = useRef(new Set<string>());
  const sourceVersion = useRef(0);
  function releaseSources(keepId?: string) {
    for (const id of supersededSources.current) {
      if (id === keepId) continue;
      supersededSources.current.delete(id);
      void apiFetch("/api/import/source/discard", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceReceipt: id }) }).catch(() => {});
    }
  }
  const creation = useResumeImportCreation((id) => {
    if (editorRef.current.sourceReceipt) supersededSources.current.add(editorRef.current.sourceReceipt.id);
    releaseSources();
    router.push(`/resumes/${id}`);
  }, {
    getEditor: () => editorRef.current,
    onRestore: (saved) => {
      const previousReceipt = editorRef.current.sourceReceipt;
      if (previousReceipt && previousReceipt.id !== saved.sourceReceipt?.id) supersededSources.current.add(previousReceipt.id);
      editorRef.current = saved;
      sourceVersion.current++;
      setSourceIssue(saved.sourceIssue ?? null);
      // onRestore also follows a successful, CAS-protected explicit discard.
      releaseSources(saved.sourceReceipt?.id);
      setFile(null);
      pdfAsImagesRef.current = false; setPdfAsImages(false);
      reextractFileRef.current = false; setReextractFile(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
      setError("");
      setSource(saved.source); setText(saved.text);
      recoveredSourceRef.current = saved.recoveredText;
      setRecoveredText(saved.recoveredText ?? ""); setRecoveryReady(saved.recoveredText !== null);
      setOcrInfo(saved.ocrInfo); setManualDraft(saved.manualDraft);
      draftRef.current = saved.draft; setDraft(saved.draft);
    },
  });

  function remember(patch: Partial<ResumeImportEditorState>) {
    const previous = editorRef.current;
    const next = { ...previous, ...patch };
    if (previous.sourceReceipt && previous.sourceReceipt.id !== next.sourceReceipt?.id) supersededSources.current.add(previous.sourceReceipt.id);
    if (previous.recoveredText !== next.recoveredText || previous.sourceReceipt?.id !== next.sourceReceipt?.id) sourceVersion.current++;
    editorRef.current = next;
    if (Object.hasOwn(patch, "sourceIssue")) setSourceIssue(next.sourceIssue ?? null);
    const saved = creation.saveEditor(next);
    // A failed write leaves the old server source and recovery record intact;
    // a later successful save flushes every superseded source, not just the last one.
    if (saved) releaseSources(next.sourceReceipt?.id);
    return saved;
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      parseControllerRef.current?.abort();
      parseControllerRef.current = null;
    };
  }, []);

  function retainSource(value: string, received?: { receipt: ResumeImportSourceReceipt | null; issue?: ResumeImportEditorState["sourceIssue"] }) {
    reextractFileRef.current = false;
    setReextractFile(false);
    recoveredSourceRef.current = value;
    setRecoveredText(value);
    setRecoveryReady(true);
    const unchanged = editorRef.current.recoveredText === value;
    return remember({ recoveredText: value,
      sourceReceipt: received ? received.receipt : unchanged ? editorRef.current.sourceReceipt : null,
      sourceIssue: received ? received.issue ?? null : unchanged ? editorRef.current.sourceIssue : null });
  }

  function clearRecovery() {
    reextractFileRef.current = false;
    setReextractFile(false);
    recoveredSourceRef.current = null;
    setRecoveredText("");
    setRecoveryReady(false);
    setOcrInfo(null);
    setError("");
    remember({ recoveredText: null, ocrInfo: null, sourceReceipt: null, sourceIssue: null });
  }

  useEffect(() => {
    let cancelled = false;
    jsonFetch<{ configured?: boolean }>("/api/settings/configured")
      .then((s) => {
        if (!cancelled) setAiConfigured(Boolean(s.configured));
      })
      .catch(() => {
        // 状态探测失败时保持默认 true；真正解析时服务端还有配置校验兜底
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function parse() {
    if (!mountedRef.current || parseControllerRef.current || !creation.canStart()) return;
    const recoveredSource = reextractFileRef.current ? null : recoveredSourceRef.current;
    setError("");
    if (recoveredSource !== null && editorRef.current.sourceIssue) {
      return;
    }
    if (recoveredSource !== null && !recoveredSource.trim()) {
      setError("请先补充已保留的原文，或重新选择导入来源");
      return;
    }
    if (recoveredSource === null && source === "paste" && !text.trim()) {
      setError("请先粘贴简历文本");
      return;
    }
    if (recoveredSource === null && source === "file" && !file) {
      setError("请先选择文件（PDF / 图片 / Word / txt / md）");
      return;
    }
    setParsing(true);
    const controller = new AbortController();
    parseControllerRef.current = controller;
    let expectedSourceVersion = sourceVersion.current;
    const isCurrent = () => mountedRef.current && !controller.signal.aborted && parseControllerRef.current === controller && sourceVersion.current === expectedSourceVersion;
    try {
      let sourceText = recoveredSource ?? text;
      if (recoveredSource === null && source === "file") {
        const form = new FormData();
        form.append("file", file as File);
        form.append("extractOnly", "true");
        if (pdfAsImagesRef.current && file?.name.toLowerCase().endsWith(".pdf")) form.append("pdfMode", "image");
        const extracted = await apiFetch("/api/import/parse", {
          method: "POST", body: form, signal: controller.signal,
        });
        if (!isCurrent()) return;
        const result = await extracted.json() as {
          extractedText?: string;
          ocr?: { engine: "vision" | "local"; pageCount: number; sourceType?: "pdf" | "image" };
          error?: string;
          code?: string;
          sourceReceipt?: unknown;
        };
        if (!isCurrent()) return;
        if (!result || typeof result.extractedText !== "string" || !result.extractedText.trim()) {
          throw new Error(typeof result?.error === "string" ? result.error : "未能提取文件文本");
        }
        sourceText = result.extractedText;
        const receipt = readResumeImportSourceReceipt(result.sourceReceipt);
        const needsReceipt = file?.name.toLowerCase().endsWith(".docx") || result.sourceReceipt !== undefined || result.code === "IMPORT_SOURCE_CAPACITY";
        // 先保留有效原文，OCR 元信息异常也不能丢掉已读取的文本。
        const stored = retainSource(sourceText, { receipt, issue: needsReceipt && !receipt ? "unavailable" : null });
        expectedSourceVersion = sourceVersion.current;
        if (!extracted.ok) throw new Error(typeof result.error === "string" ? result.error : "文件来源暂不可用，已保留原文");
        if (needsReceipt && !receipt) throw new Error("文件来源信息未能保留，请重新上传文件或主动选择按普通文本继续");
        if (!stored) throw new Error("已保留页面内原文，但暂存失败；请先复制原文，恢复暂存后再解析");
        const ocr = result.ocr === undefined ? null : readImportedResumeOcr(result.ocr);
        setOcrInfo(ocr);
        remember({ ocrInfo: ocr });
        if (result.ocr !== undefined && !ocr) throw new Error("文件识别信息异常，已保留原文，可直接重试解析");
      } else if (recoveredSource === null) {
        setOcrInfo(null);
        remember({ ocrInfo: null });
      }
      // 文本提取与 AI 解析分开：模型失败或连接中断时，原文已在页面中。
      const stored = retainSource(sourceText);
      expectedSourceVersion = sourceVersion.current;
      if (!stored) throw new Error("已保留页面内原文，但暂存失败；请先复制原文，恢复暂存后再解析");
      const receipt = editorRef.current.sourceReceipt;
      const init = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: sourceText, ...(receipt ? { sourceReceipt: receipt.id } : {}) }),
        signal: controller.signal,
      };
      let data: unknown;
      if (receipt) {
        const response = await apiFetch("/api/import/parse", init);
        if (!isCurrent()) return;
        data = await response.json();
        if (!isCurrent()) return;
        if (!response.ok) {
          const result = data as { code?: unknown; error?: unknown } | null;
          if (response.status === 410 || result?.code === "IMPORT_SOURCE_EXPIRED") remember({ sourceIssue: "expired" });
          else if (response.status === 409 && result?.code === "IMPORT_SOURCE_MISMATCH") remember({ sourceIssue: "mismatch" });
          throw new Error(typeof result?.error === "string" ? result.error : `解析失败（${response.status}）`);
        }
      } else data = await jsonFetch<unknown>("/api/import/parse", init);
      if (!isCurrent()) return;
      const nextDraft = readImportedResumeDraft(data);
      if (!nextDraft) throw new Error("AI 解析响应不完整，已保留原文，请重试或手工整理");
      setManualDraft(false);
      draftRef.current = nextDraft;
      setDraft(nextDraft);
      remember({ draft: nextDraft, manualDraft: false });
    } catch (err) {
      if (!isCurrent()) return;
      const raw = errorMessage(err);
      setError(
        /failed to fetch|networkerror|load failed/i.test(raw)
          ? "无法连接服务器：应用可能正在重启，请稍等几秒后重试"
          : raw
      );
    } finally {
      if (parseControllerRef.current === controller) {
        parseControllerRef.current = null;
        if (mountedRef.current) setParsing(false);
      }
    }
  }

  function continueManually() {
    if (!mountedRef.current || parseControllerRef.current || !creation.canStart() || !recoveredSourceRef.current?.trim()) return;
    const modules: Record<string, unknown> = {};
    for (const key of MODULE_KEYS) modules[key] = defaultContent(key);
    draftRef.current = { title: "导入的简历", modules };
    setDraft(draftRef.current);
    setManualDraft(true);
    remember({ draft: draftRef.current, manualDraft: true });
    setError("");
  }

  function updateDraftModule(key: ModuleKey, content: unknown) {
    const current = draftRef.current;
    if (creation.canStart() && current) {
      draftRef.current = { ...current, modules: { ...current.modules, [key]: content } };
      setDraft(draftRef.current);
      remember({ draft: draftRef.current });
    }
    return Promise.resolve();
  }

  const recoveryPanel = <>
    {creation.restored && <p role="status" className="mt-4 text-sm text-muted">已恢复当前标签页的导入草稿；不会自动解析或提交。</p>}
    {creation.restored && source === "file" && !recoveryReady && !draft && <p className="text-sm text-muted">文件选择不会暂存；尚未提取原文时，请重新选择文件。</p>}
    {(draft || text || recoveryReady || creation.restored) && !creation.restoreError && <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-muted">
      <span>原文与草稿仅暂存在当前标签页。</span>
      <button type="button" className={btnGhost} disabled={parsing || (creation.locked && !creation.discarding)} onClick={() => { if (!parseControllerRef.current) void creation.discard(); }}>清除导入暂存</button>
    </div>}
    {creation.storageError && <p role="alert" className="mt-4 text-sm text-danger">{creation.storageError}</p>}
    {creation.error && <p role="alert" className="mt-4 text-sm text-danger [overflow-wrap:anywhere]">{creation.error}</p>}
    {(["replaying", "checking", "unknown", "confirming"].includes(creation.phase)) && (
      <section aria-label="导入结果核对" className="mt-5 space-y-3 rounded-xl border border-line p-4 [overflow-wrap:anywhere]">
        <p className="text-sm">{creation.restoreError ? "恢复信息读取失败。请先核对已保存的简历，再决定是否清除恢复信息。" : creation.retrySupported ? "草稿已保留。可继续本次导入，或重新读取已有结果。" : "草稿已保留。请先核对已保存的简历，避免重复创建。"}</p>
        {creation.rawRecovery !== null && <details>
          <summary className="cursor-pointer text-sm text-primary">查看原始恢复数据</summary>
          <textarea readOnly aria-label="原始导入恢复数据" className={`${textareaTallCls} mt-2`} value={redactResumeImportRecovery(creation.rawRecovery)} />
        </details>}
        {creation.recovery && (creation.recovery.length ? (
          <ul className="max-h-64 space-y-2 overflow-y-auto text-sm">
            {creation.recovery.map((row) => <li key={row.id}>
              <a href={`/resumes/${row.id}`} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                #{row.id} · {row.title || "未命名简历"}（新窗口核对）
              </a>
            </li>)}
          </ul>
        ) : <p className="text-sm text-muted">当前列表为空；原请求仍可能稍后完成。</p>)}
        {creation.retrySupported && <p className="text-sm text-muted">重试本次导入会继续提交原稿；已经保存时会取回原存档，不会另建一份。</p>}
        <div className="flex flex-wrap gap-2">
          <button type="button" className={btnGhost} disabled={creation.phase !== "unknown"} onClick={creation.reread}>重新读取导入结果</button>
          {creation.retrySupported && <button type="button" className={btnGhost} disabled={!creation.retryAvailable} onClick={() => void creation.replay()}>{creation.phase === "replaying" ? "正在重试…" : "重试本次导入"}</button>}
          <button type="button" className={btnGhost} disabled={(creation.phase !== "unknown" && creation.phase !== "confirming") || creation.recovery === null} onClick={() => void creation.allowRetry()}>已核对，允许再次创建</button>
        </div>
      </section>
    )}
  </>;

  if (draft) {
    return (
      <ImportProofingWorkbench
        draft={draft}
        sourceText={recoveredText}
        ocrInfo={ocrInfo}
        manualDraft={manualDraft}
        error={error}
        locked={creation.locked}
        creating={["posting", "replaying", "checking", "navigating"].includes(creation.phase)}
        recovery={recoveryPanel}
        onTitleChange={(title) => {
          if (!creation.canStart() || !draftRef.current) return;
          draftRef.current = { ...draftRef.current, title };
          setDraft(draftRef.current);
          remember({ draft: draftRef.current });
        }}
        onConfirm={() => { if (draftRef.current) void creation.start(draftRef.current); }}
        onBack={() => {
          if (!creation.canStart()) return;
          draftRef.current = null;
          setDraft(null);
          remember({ draft: null });
        }}
        renderEditors={(locate) => MODULE_KEYS.map((key) => (
            <section key={key}>
              <div className="mb-3 border-b border-line pb-1.5">
                <SectionTitle>{MODULE_LABELS[key]}</SectionTitle>
              </div>
              {key === "basic" && (
                <BasicEditor
                  content={draft.modules.basic as Record<string, string>}
                  onChange={(c) => updateDraftModule("basic", c)}
                  status="idle"
                  onProofingFieldFocus={locate}
                />
              )}
              {key === "education" && (
                <ListEditor
                  itemName="教育经历"
                  items={draft.modules.education as ItemDraft[]}
                  onChange={(items) => updateDraftModule("education", items)}
                  status="idle"
                  onProofingFieldFocus={(index, field) => locate(`education[${index}].${field}`)}
                  fields={[
                    { key: "school", label: "学校" },
                    { key: "degree", label: "学位" },
                    { key: "field", label: "专业" },
                    { key: "start", label: "开始" },
                    { key: "end", label: "结束" },
                    { key: "description", label: "备注", textarea: true, richText: true, wide: true },
                  ]}
                />
              )}
              {key === "work" && (
                <WorkEditor
                  itemName="工作经历"
                  items={draft.modules.work as WorkItem[]}
                  onChange={(items) => updateDraftModule("work", items)}
                  status="idle"
                  onProofingFieldFocus={(index, field) => locate(`work[${index}].${field}`)}
                />
              )}
              {key === "projects" && (
                <ProjectsEditor
                  itemName="项目经历"
                  items={draft.modules.projects as ProjectItem[]}
                  onChange={(items) => updateDraftModule("projects", items)}
                  status="idle"
                  onProofingFieldFocus={(index, field) => locate(`projects[${index}].${field}`)}
                />
              )}
              {key === "skills" && (
                <SkillsEditor
                  content={draft.modules.skills as { items: string[] }}
                  onChange={(c) => updateDraftModule("skills", c)}
                  status="idle"
                />
              )}
              {key === "summary" && (
                <SummaryEditor
                  content={draft.modules.summary as { text: string }}
                  onChange={(c) => updateDraftModule("summary", c)}
                  status="idle"
                />
              )}
              {key === "custom" && (
                <CustomEditor
                  itemName="自定义"
                  items={(draft.modules.custom ?? []) as CustomItem[]}
                  onChange={(items) => updateDraftModule("custom", items)}
                  status="idle"
                  onProofingFieldFocus={(index, field) => locate(`custom[${index}].${field}`)}
                />
              )}
            </section>
          ))}
      />
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-8">
      {/* 顶部标题与返回导航 */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <Link
              href="/resumes"
              className="text-xs text-primary hover:underline flex items-center gap-1 font-medium"
            >
              ← 返回简历管理中心
            </Link>
          </div>
          <h1 className="font-serif text-[28px] sm:text-[32px] font-bold text-ink leading-tight">
            导入已有简历
          </h1>
          <p className="mt-1 max-w-prose text-sm text-muted leading-relaxed">
            上传 PDF / 图片 / Word 文件或直接粘贴简历文本，AI 提取基本信息、经历、技能及证书奖项等内容，核对无误后一键入库。
          </p>
        </div>
      </div>

      {!aiConfigured && (
        <div className="rounded-xl border border-accent/30 bg-accent-wash p-4 text-xs sm:text-sm text-ink flex items-center justify-between gap-3">
          <span>尚未配置 AI 服务：解析前需在设置页配置模型凭证与解析模型。</span>
          <Link href="/settings" className="shrink-0 font-medium text-primary hover:underline">
            前往设置 →
          </Link>
        </div>
      )}

      {recoveryPanel}

      {/* 导入模式分段控制器 */}
      <div className="relative rounded-2xl border border-line bg-card p-6 shadow-card-subtle space-y-5">
        <LoadingOverlay
          show={parsing}
          message={
            source === "file" && (!recoveryReady || reextractFile) && file?.name.toLowerCase().endsWith(".pdf")
              ? pdfAsImages ? "正在按页面图片识别 PDF 并进行 AI 结构化解析…" : "正在读取 PDF 并进行 AI 结构化解析…"
              : source === "file" && !recoveryReady && /\.(png|jpe?g|webp|bmp)$/i.test(file?.name ?? "")
                ? "正在执行图片 OCR 识别并提取简历结构…"
                : "AI 正在提取简历内容并整理为结构化草稿…"
          }
          description="正在解析个人信息、教育、工作、项目经历与专业技能，请稍候…"
        />
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3.5">
          <span className="shrink-0 text-xs font-serif font-bold text-ink">选择导入来源</span>
          <div
            role="tablist"
            className="inline-flex max-w-full rounded-xl border border-line bg-surface p-1 shadow-xs"
          >
            {(["paste", "file"] as const).map((s) => (
              <button
                key={s}
                role="tab"
                aria-selected={source === s}
                onClick={() => {
                  if (parseControllerRef.current || !creation.canStart() || source === s) return;
                  setSource(s);
                  remember({ source: s });
                  clearRecovery();
                }}
                disabled={parsing || creation.locked}
                className={`rounded-lg px-3 sm:px-4 py-1.5 text-xs sm:text-sm font-medium transition-all ${s === "paste" ? "shrink-0 whitespace-nowrap" : "min-w-0"} ${
                  source === s
                    ? "bg-card text-ink font-bold shadow-xs"
                    : "text-muted hover:text-ink"
                }`}
              >
                {s === "paste" ? "粘贴文本" : "上传文件 (PDF/IMG/Word/Markdown)"}
              </button>
            ))}
          </div>
        </div>

        <div>
          {source === "paste" ? (
            <textarea
              className={`${textareaTallCls} min-h-72 font-sans text-xs sm:text-sm`}
              value={text}
              aria-label="简历原文"
              disabled={parsing || creation.locked}
              onChange={(e) => {
                if (parseControllerRef.current || !creation.canStart()) return;
                setText(e.target.value);
                remember({ text: e.target.value });
                clearRecovery();
              }}
              placeholder="把已有简历文本（包含个人信息、教育、工作、项目、技能等）完整粘贴到这里…"
            />
          ) : (
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.docx,.txt,.md,.markdown,.png,.jpg,.jpeg,.webp,.bmp"
                onChange={(e) => {
                  if (parseControllerRef.current || !creation.canStart()) return;
                  setFile(e.target.files?.[0] ?? null);
                  pdfAsImagesRef.current = false; setPdfAsImages(false);
                  reextractFileRef.current = false; setReextractFile(false);
                  if (recoveredSourceRef.current !== null) {
                    // Keep the current recoverable source until a replacement is extracted and saved.
                    reextractFileRef.current = true; setReextractFile(true);
                    setError("");
                  } else clearRecovery();
                }}
                disabled={parsing || creation.locked}
                className="sr-only"
              />
              <button
                type="button"
                disabled={parsing || creation.locked}
                onClick={() => fileInputRef.current?.click()}
                className="flex w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed border-line-strong bg-surface/40 p-10 text-center shadow-card-subtle transition-all hover:border-primary/60 hover:bg-surface/80 cursor-pointer"
              >
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary-soft text-primary font-serif font-bold text-2xl">
                  📄
                </div>
                <div className="space-y-1">
                  <span className="text-sm font-bold text-ink block">
                    {file ? file.name : "点击选择本地简历或拖拽至此"}
                  </span>
                  <span className="text-xs text-muted block">
                    支持 PDF（扫描件 OCR 最多 5 页，超出请拆分）、图片（PNG/JPG/WEBP 等）、Word（.docx）、.txt、.md，最大 10MB
                  </span>
                </div>
              </button>
              {file?.name.toLowerCase().endsWith(".pdf") && <div className="mt-4 space-y-2 text-sm">
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={pdfAsImages} disabled={parsing || creation.locked}
                    onChange={(event) => {
                      if (parseControllerRef.current || !creation.canStart()) return;
                      pdfAsImagesRef.current = event.target.checked; setPdfAsImages(event.target.checked);
                      reextractFileRef.current = true; setReextractFile(true);
                    }} />
                  按页面图片识别 PDF
                </label>
                <p className="text-xs text-muted">文字顺序不对或漏字时可选；最多 5 页，使用当前 OCR 设置。进入校对后可先返回重新解析，再切换此选项。</p>
                {recoveryReady && <p className="text-xs text-muted">{reextractFile ? "下次解析将重新提取文件；提取失败时保留已有原文。" : "已保留原文，重试仅重新解析原文；切换读取方式会重新提取文件。"}</p>}
              </div>}
            </div>
          )}
        </div>

        {error && (
          <div role="alert" className="rounded-xl border border-danger/30 bg-danger-wash p-4 text-xs text-danger">
            {error}
          </div>
        )}

        {sourceIssue && !parsing && <section aria-label="文件来源需要重新确认" className="space-y-3 rounded-xl border border-line p-4">
          <p className="text-sm">{sourceIssue === "expired" ? "原文件的表格来源已失效，原文仍保留。" : sourceIssue === "mismatch" ? "原文与文件来源不一致，尚未继续解析。" : "文件来源暂不可用，原文已保留，尚未按普通文本解析。"} 请重新上传，或明确选择不保留原文件表格来源继续。</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={btnGhost} disabled={creation.locked} onClick={() => {
              if (!creation.canStart() || parseControllerRef.current) return;
              setSource("file"); remember({ source: "file" });
              reextractFileRef.current = true; setReextractFile(true);
              fileInputRef.current?.click();
            }}>重新上传文件</button>
            <button type="button" className={btnGhost} disabled={creation.locked || !recoveredText.trim()} onClick={() => {
              if (!creation.canStart() || parseControllerRef.current) return;
              reextractFileRef.current = false; setReextractFile(false);
              if (remember({ sourceReceipt: null, sourceIssue: null })) void parse();
            }}>按普通文本继续</button>
          </div>
        </section>}

        {recoveryReady && !parsing && (
          <div className="space-y-3 rounded-xl border border-line p-4">
            {ocrInfo && (
              <div className="flex items-center gap-2 rounded-lg border border-primary/20 bg-primary-soft/40 px-3 py-2 text-xs text-ink">
                <span className="font-semibold text-primary">
                  {ocrInfo.sourceType === "image" ? "图片识别方式：" : "PDF 识别方式："}
                </span>
                <span>
                  采用 <strong>{ocrInfo.engine === "vision" ? "多模态视觉大模型（Vision LLM）" : "本地离线 OCR（Tesseract.js）"}</strong>
                  {ocrInfo.sourceType === "image" ? "" : `（共识别 ${ocrInfo.pageCount} 页）`}
                </span>
              </div>
            )}
            <label className="block text-sm font-medium" htmlFor="recovered-resume-text">
              已保留的原文，可直接修改
            </label>
            <textarea
              id="recovered-resume-text"
              className={textareaTallCls}
              value={recoveredText}
              disabled={creation.locked}
              onChange={(event) => {
                if (!parseControllerRef.current && creation.canStart()) retainSource(event.target.value);
              }}
            />
            <button className={btnGhost} onClick={continueManually} disabled={creation.locked || !recoveredText.trim()}>
              手工整理并继续导入
            </button>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-line/60">
          <span className="min-w-0 break-all text-xs text-muted font-mono">
            {source === "paste"
              ? text.trim()
                ? `已输入 ${text.trim().length} 字`
                : "请粘贴文本内容"
              : file
              ? `已选文件：${file.name}`
              : "请选择文件"}
          </span>
          <button
            className={btnPrimary}
            onClick={parse}
            disabled={parsing || creation.locked || Boolean(sourceIssue && !reextractFile) || (recoveryReady && !reextractFile ? !recoveredText.trim() : source === "paste" ? !text.trim() : !file)}
          >
            {parsing
              ? source === "file" && (!recoveryReady || reextractFile) && file?.name.toLowerCase().endsWith(".pdf")
                ? pdfAsImages ? "解析中（正在按页面图片识别 PDF）…" : "解析中（扫描件将自动执行 OCR 识别）…"
                : source === "file" && !recoveryReady && /\.(png|jpe?g|webp|bmp)$/i.test(file?.name ?? "")
                ? "解析中（正在对图片执行 OCR 识别）…"
                : "AI 正在结构化解析中（约需 10-15 秒）…"
              : "开始智能解析 →"}
          </button>
        </div>
      </div>
    </div>
  );
}
