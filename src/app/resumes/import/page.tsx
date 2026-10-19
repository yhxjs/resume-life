"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { MODULE_KEYS, MODULE_LABELS, defaultContent, type ModuleKey, type ProjectItem, type WorkItem } from "@/lib/modules";
import {
  BasicEditor,
  ListEditor,
  SkillsEditor,
  SummaryEditor,
  type ItemDraft,
} from "@/components/resume/module-editors";
import { ProjectsEditor, WorkEditor } from "@/components/resume/projects-editor";
import { ImportProofingWorkbench } from "@/components/resume/import-proofing-workbench";
import { SectionTitle } from "@/components/common/ui-bits";
import { LoadingOverlay } from "@/components/common/loading-overlay";
import { btnGhost, btnPrimary, textareaTallCls } from "@/lib/ui";
import { jsonFetch } from "@/lib/fetcher";
import { apiFetch } from "@/lib/api-fetch";
import { errorMessage } from "@/lib/error-message";

type Draft = { title: string; modules: Record<string, unknown> };

export default function ImportPage() {
  const router = useRouter();
  const [source, setSource] = useState<"paste" | "file">("paste");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [creating, setCreating] = useState(false);
  const [manualDraft, setManualDraft] = useState(false);
  const [recoveredText, setRecoveredText] = useState("");
  const [ocrInfo, setOcrInfo] = useState<{
    engine: "vision" | "local";
    pageCount: number;
    sourceType?: "pdf" | "image";
  } | null>(null);
  const [aiConfigured, setAiConfigured] = useState(true);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const parseControllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => parseControllerRef.current?.abort(), []);

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
    setError("");
    if (source === "paste" && !text.trim()) {
      setError("请先粘贴简历文本");
      return;
    }
    if (source === "file" && !file) {
      setError("请先选择文件（PDF / 图片 / Word / txt / md）");
      return;
    }
    setParsing(true);
    const controller = new AbortController();
    parseControllerRef.current = controller;
    try {
      let sourceText = text;
      if (source === "file") {
        const form = new FormData();
        form.append("file", file as File);
        form.append("extractOnly", "true");
        const extracted = await apiFetch("/api/import/parse", {
          method: "POST", body: form, signal: controller.signal,
        });
        const result = await extracted.json() as {
          extractedText?: string;
          ocr?: { engine: "vision" | "local"; pageCount: number; sourceType?: "pdf" | "image" };
          error?: string;
        };
        if (!extracted.ok || typeof result.extractedText !== "string") {
          throw new Error(result.error ?? "未能提取文件文本");
        }
        sourceText = result.extractedText;
        setOcrInfo(result.ocr ?? null);
      } else {
        setOcrInfo(null);
      }
      // 文本提取与 AI 解析分开：模型失败或连接中断时，原文已在页面中。
      setRecoveredText(sourceText);
      const data = await jsonFetch<Draft & { extractedText?: string }>("/api/import/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: sourceText }),
        signal: controller.signal,
      });
      setManualDraft(false);
      setDraft(data);
    } catch (err) {
      if (controller.signal.aborted) return;
      const raw = errorMessage(err);
      setError(
        /failed to fetch|networkerror|load failed/i.test(raw)
          ? "无法连接服务器：应用可能正在重启，请稍等几秒后重试"
          : raw
      );
    } finally {
      parseControllerRef.current = null;
      setParsing(false);
    }
  }

  function continueManually() {
    const modules: Record<string, unknown> = {};
    for (const key of MODULE_KEYS) modules[key] = defaultContent(key);
    setDraft({ title: "导入的简历", modules });
    setManualDraft(true);
    setError("");
  }

  async function confirm() {
    if (!draft) return;
    setError("");
    setCreating(true);
    try {
      const created = await jsonFetch<{ id: number }>("/api/resumes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: draft.title.trim() || "导入的简历", modules: draft.modules }),
      });
      router.push(`/resumes/${created.id}`);
    } catch (err) {
      setError(errorMessage(err));
      setCreating(false);
    }
  }

  function updateDraftModule(key: ModuleKey, content: unknown) {
    setDraft((prev) => (prev ? { ...prev, modules: { ...prev.modules, [key]: content } } : prev));
    return Promise.resolve();
  }

  if (draft) {
    return (
      <ImportProofingWorkbench
        draft={draft}
        sourceText={recoveredText}
        ocrInfo={ocrInfo}
        manualDraft={manualDraft}
        error={error}
        creating={creating}
        onTitleChange={(title) => setDraft((prev) => prev ? { ...prev, title } : prev)}
        onConfirm={() => void confirm()}
        onBack={() => setDraft(null)}
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
                    { key: "description", label: "备注", textarea: true, wide: true },
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
            上传 PDF / 图片 / Word 文件或直接粘贴简历文本，AI 自动解析为六大标准模块结构化草稿，核对无误后一键入库。
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

      {/* 导入模式分段控制器 */}
      <div className="relative rounded-2xl border border-line bg-card p-6 shadow-card-subtle space-y-5">
        <LoadingOverlay
          show={parsing}
          message={
            file?.name.toLowerCase().endsWith(".pdf")
              ? "正在读取 PDF 并进行 AI 结构化解析…"
              : /\.(png|jpe?g|webp|bmp)$/i.test(file?.name ?? "")
                ? "正在执行图片 OCR 识别并提取简历结构…"
                : "AI 正在深度解析简历内容并重构成六大模块…"
          }
          description="正在解析个人信息、教育、工作、项目经历与专业技能，请稍候…"
        />
        <div className="flex items-center justify-between border-b border-line pb-3.5">
          <span className="text-xs font-serif font-bold text-ink">选择导入来源</span>
          <div
            role="tablist"
            className="inline-flex rounded-xl border border-line bg-surface p-1 shadow-xs"
          >
            {(["paste", "file"] as const).map((s) => (
              <button
                key={s}
                role="tab"
                aria-selected={source === s}
                onClick={() => {
                  setSource(s);
                  setError("");
                  setRecoveredText("");
                  setOcrInfo(null);
                }}
                disabled={parsing}
                className={`rounded-lg px-4 py-1.5 text-xs sm:text-sm font-medium transition-all ${
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
              disabled={parsing}
              onChange={(e) => setText(e.target.value)}
              placeholder="把已有简历文本（包含个人信息、教育、工作、项目、技能等）完整粘贴到这里…"
            />
          ) : (
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.docx,.txt,.md,.markdown,.png,.jpg,.jpeg,.webp,.bmp"
                onChange={(e) => {
                  setFile(e.target.files?.[0] ?? null);
                  setRecoveredText("");
                  setOcrInfo(null);
                }}
                disabled={parsing}
                className="sr-only"
              />
              <button
                type="button"
                disabled={parsing}
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
            </div>
          )}
        </div>

        {error && (
          <div className="rounded-xl border border-danger/30 bg-danger-wash p-4 text-xs text-danger">
            {error}
          </div>
        )}

        {recoveredText && !parsing && error && (
          <div className="space-y-3 rounded-xl border border-line p-4">
            {ocrInfo && (
              <div className="flex items-center gap-2 rounded-lg border border-primary/20 bg-primary-soft/40 px-3 py-2 text-xs text-ink">
                <span className="font-semibold text-primary">
                  {ocrInfo.sourceType === "image" ? "图片识别方式：" : "扫描件识别方式："}
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
              onChange={(event) => setRecoveredText(event.target.value)}
            />
            <button className={btnGhost} onClick={continueManually} disabled={!recoveredText.trim()}>
              手工整理并继续导入
            </button>
          </div>
        )}

        <div className="flex items-center justify-between pt-2 border-t border-line/60">
          <span className="text-xs text-muted font-mono">
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
            disabled={parsing || (source === "paste" ? !text.trim() : !file)}
          >
            {parsing
              ? file?.name.toLowerCase().endsWith(".pdf")
                ? "解析中（扫描件将自动执行 OCR 识别）…"
                : /\.(png|jpe?g|webp|bmp)$/i.test(file?.name ?? "")
                ? "解析中（正在对图片执行 OCR 识别）…"
                : "AI 正在结构化解析中（约需 10-15 秒）…"
              : "开始智能解析 →"}
          </button>
        </div>
      </div>
    </div>
  );
}
