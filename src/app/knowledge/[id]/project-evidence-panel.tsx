"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ChallengeConditionsEditor } from "@/components/defense/challenge-conditions";
import { challengeQuestion, readScanEvidenceFiles, selectEvidenceLines, sourceLines, type ChallengeConditions, type ScanEvidenceFile } from "@/lib/evidence-challenge";
import { projectSummaryEvidence } from "@/lib/project-summary-evidence";
import type { ProjectSummary } from "@/lib/summary";
import type { ProjectMaterialDetail } from "@/lib/project-materials";
import { readProjectMaterialSavedDetail } from "@/lib/project-material-save";
import { jsonFetch } from "@/lib/fetcher";
import { errorMessage } from "@/lib/error-message";
import { btnGhost, btnPrimary, inputCls, labelCls, textareaCls } from "@/lib/ui";
import { DirectoryPickerDialog } from "./directory-picker-dialog";
import { EvidenceRecommendationCard, RecommendationSparkles } from "./evidence-recommendation-card";

export function ProjectEvidencePanel({ projectId, materials, sourceFiles, hasMore, loadingMore, onLoadMore,
  savedSummary, repoPaths = [], onSourceFilesChange, onRepoPathSelected, onImportMaterial }: {
  projectId: number; materials: { id: number; title: string }[]; sourceFiles: ScanEvidenceFile[];
  hasMore: boolean; loadingMore: boolean; onLoadMore: () => void;
  savedSummary?: ProjectSummary; repoPaths?: string[];
  onSourceFilesChange?: (files: ScanEvidenceFile[]) => void;
  onRepoPathSelected?: (path: string) => void; onImportMaterial?: () => void;
}) {
  const [selection, setSelection] = useState("");
  const [material, setMaterial] = useState<ProjectMaterialDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [start, setStart] = useState(1);
  const [end, setEnd] = useState(1);
  const [conditions, setConditions] = useState<ChallengeConditions>({ mode: "scale", baseline: "", change: "" });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<{ id: number; count: number; questions?: string[] } | null>(null);
  const [generationMode, setGenerationMode] = useState<"manual" | "smart">("manual");
  const [recommendationCount, setRecommendationCount] = useState(3);
  const [summaryQuote, setSummaryQuote] = useState("");
  const [selectedSummary, setSelectedSummary] = useState<{ key: string; label: string; content: string } | null>(null);
  const [readingRepo, setReadingRepo] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const repoRead = useRef<AbortController | null>(null);
  const load = useRef<AbortController | null>(null);
  const submit = useRef<AbortController | null>(null);
  useEffect(() => () => { load.current?.abort(); submit.current?.abort(); repoRead.current?.abort(); }, []);

  const sections = projectSummaryEvidence(savedSummary);
  const noOptions = sourceFiles.length === 0 && materials.length === 0 && sections.length === 0;
  const archive = selection.startsWith("summary:") ? selectedSummary : null;
  const archiveChanged = archive && !sections.some(section => section.key === archive.key && section.content === archive.content);
  const scanFile = selection.startsWith("scan:") ? sourceFiles.find(file => `scan:${file.receipt}` === selection) : undefined;
  const content = archive?.content ?? scanFile?.content ?? material?.content ?? "";
  const lines = sourceLines(content);
  let quote = "", rangeError = "";
  if (archive) {
    if (archiveChanged) rangeError = "已保存档案已变化，请重新选择章节";
    else if (!summaryQuote.trim() || summaryQuote.length > 280 || !content.includes(summaryQuote)) rangeError = "请连续摘取 1–280 字档案原文，不要改写";
    else quote = summaryQuote;
  } else if (content) {
    try { quote = selectEvidenceLines(content, start, end); }
    catch (error) { rangeError = errorMessage(error); }
  }

  async function choose(next: string) {
    load.current?.abort();
    setSelection(next); setMaterial(null); setStart(1); setEnd(1); setCreated(null); setError(""); setLoading(false);
    const section = sections.find(section => `summary:${section.key}` === next) ?? null;
    setSelectedSummary(section);
    // UTF-16 length follows the server limit; never split a surrogate pair in the suggested excerpt.
    const prefix = section?.content.slice(0, 280) ?? "";
    setSummaryQuote(/[\uD800-\uDBFF]$/.test(prefix) ? prefix.slice(0, -1) : prefix);
    if (!next.startsWith("material:")) return;
    const id = Number(next.slice(9));
    const controller = new AbortController();
    load.current = controller;
    setLoading(true);
    try {
      const value = await jsonFetch<unknown>(`/api/projects/${projectId}/materials/${id}`, { signal: controller.signal });
      if (!controller.signal.aborted) setMaterial(readProjectMaterialSavedDetail(value, id));
    } catch (error) {
      if (!controller.signal.aborted) setError(errorMessage(error));
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }

  async function readRepo(paths: string[]) {
    if (repoRead.current || submit.current || !onSourceFilesChange) return;
    const controller = new AbortController();
    repoRead.current = controller;
    load.current?.abort(); setLoading(false); setReadingRepo(true); setError(""); setCreated(null);
    try {
      const result = await jsonFetch<{ sourceFiles: unknown }>(`/api/projects/${projectId}/evidence-sources`, {
        method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repoPaths: paths }),
      });
      if (controller.signal.aborted) return;
      const files = readScanEvidenceFiles(result.sourceFiles);
      if (!files.length) throw new Error("未读取到可选代码文件，请调整目录或导入设计材料");
      onSourceFilesChange(files);
      await choose(`scan:${files[0]!.receipt}`);
    } catch (error) { if (!controller.signal.aborted) setError(errorMessage(error)); }
    finally { if (!controller.signal.aborted) { repoRead.current = null; setReadingRepo(false); } }
  }

  async function create() {
    if (submit.current || readingRepo || !quote || (!scanFile && !material && !archive)) return;
    const controller = new AbortController();
    submit.current = controller; setSaving(true); setCreated(null); setError("");
    const smart = generationMode === "smart";
    try {
      const result = await jsonFetch<{ id: number; count: number; questions?: string[] }>(`/api/projects/${projectId}/evidence-drill${smart ? "/recommend" : ""}`, {
        method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(smart ? { count: recommendationCount } : conditions), startLine: start, endLine: end,
          ...(archive ? { summaryKey: archive.key, summaryContent: archive.content, summaryQuote: quote }
            : scanFile ? { scanFile } : { materialId: material!.id, revision: material!.revision }) }),
      });
      if (controller.signal.aborted) return;
      if (!Number.isSafeInteger(result.id) || result.id <= 0 || !Number.isSafeInteger(result.count) || result.count < 1
        || result.count > (smart ? recommendationCount : 1)
        || (smart && (!Array.isArray(result.questions) || result.questions.length !== result.count
          || result.questions.some(question => typeof question !== "string" || !question.trim())))) throw new Error("创建响应不完整");
      setCreated({ id: result.id, count: result.count, ...(smart ? { questions: result.questions } : {}) });
    } catch (error) {
      if (!controller.signal.aborted) setError(`${errorMessage(error)}${smart ? "；若连接中断，可先到练习列表确认是否已保存，再决定是否重新生成。" : "；可重试相同依据和条件，已保存的相同题目会直接复用。"}`);
    } finally {
      if (!controller.signal.aborted) { submit.current = null; setSaving(false); }
    }
  }

  return <section className="rounded-xl border border-line bg-card p-5 space-y-4">
    <div>
      <h2 className="font-serif text-lg font-bold text-ink">指着材料追问</h2>
      <p className="mt-1 text-xs text-muted">选择代码、设计材料或已保存的项目档案中的一段文字，再改变条件练习答辩。创建后，位置、摘录和假设会随题目保存。</p>
    </div>
    <fieldset disabled={saving} className="min-w-0 space-y-4 disabled:opacity-60">
      <label className={`${labelCls} block space-y-1`}>依据来源
        <select className={inputCls} value={selection} disabled={noOptions || readingRepo} onChange={event => void choose(event.target.value)}>
          <option value="">{noOptions ? "暂无可选依据，请先读取代码或导入材料" : "请选择材料、代码文件或已保存项目档案"}</option>
          {sourceFiles.map(file => <option key={file.receipt} value={`scan:${file.receipt}`}>{file.locator}</option>)}
          {materials.map(item => <option key={item.id} value={`material:${item.id}`}>材料 #{item.id} · {item.title}</option>)}
          {sections.map(section => <option key={section.key} value={`summary:${section.key}`}>已保存项目档案 · {section.label}（待核实）</option>)}
        </select>
      </label>
      {sourceFiles.length === 0 && materials.length === 0 && <p className="text-xs text-muted">
        {sections.length ? "当前只有已保存的项目档案，可先选择章节练习；档案可能含 AI 总结，不代表已核验源码。" : "当前项目还没有导入材料或已保存档案。旧扫描只保存总结，未留存代码文件。"}
        需要代码位置时，读取仓库文件即可，无需重新生成 AI 总结。
      </p>}
      <div className="flex flex-wrap gap-2">
        {onSourceFilesChange && <>
          {repoPaths.length > 0 && <button type="button" className={btnGhost} disabled={readingRepo} onClick={() => void readRepo(repoPaths)}>{readingRepo ? "正在读取代码文件…" : "从已记录目录读取代码"}</button>}
          <button type="button" className={btnGhost} disabled={readingRepo} onClick={() => setPickerOpen(true)}>选择代码目录并读取</button>
        </>}
        {onImportMaterial && <button type="button" className={btnGhost} onClick={onImportMaterial}>导入设计材料</button>}
      </div>
      {readingRepo && <p role="status" className="text-xs text-muted">正在读取所选目录中的代码文件，不调用 AI…</p>}
      {hasMore && <button type="button" className={btnGhost} disabled={loadingMore} onClick={onLoadMore}>{loadingMore ? "正在读取更多材料…" : "加载更多依据材料"}</button>}
      {sourceFiles.length > 0 && <p className="text-xs text-muted">代码文件仅保留在本页，有效期一小时；刷新页面或服务重启后可重新读取。创建的题目会长期保存所选摘录。</p>}
      {loading && <p role="status">正在读取原文…</p>}
      {selection.startsWith("material:") && !loading && !material && <button type="button" className={btnGhost} onClick={() => void choose(selection)}>重新读取依据</button>}
      {content && <>
        <p className="text-xs text-muted">{archive ? "已保存档案摘录：属于待核实的二手总结，不是源码或设计原文。未保存草稿不会进入本题。"
          : scanFile ? `${scanFile.capturedAt} · ${scanFile.truncated ? "仅采集文件前缀，后文未知" : "扫描时文本"}` : "以下行号对应保存的提取文本，不是原文档页码。"}</p>
        <pre className={`max-h-64 overflow-auto rounded-lg border border-line bg-surface p-3 text-xs ${archive ? "whitespace-pre-wrap break-words" : ""}`}>{archive ? content : lines.map((line, index) => `${index + 1}  ${line}`).join("\n")}</pre>
        {archive ? <label className={`${labelCls} block space-y-1`}>档案摘录（连续原文，最多 280 字）
          <textarea className={textareaCls} maxLength={280} value={summaryQuote} onChange={event => { setSummaryQuote(event.target.value); setCreated(null); }} />
        </label> : <div className="grid grid-cols-2 gap-3">
          <label className={labelCls}>起始行<input className={inputCls} type="number" min={1} max={lines.length} value={start} onChange={event => { setStart(Number(event.target.value)); setCreated(null); }} /></label>
          <label className={labelCls}>结束行<input className={inputCls} type="number" min={start} max={lines.length} value={end} onChange={event => { setEnd(Number(event.target.value)); setCreated(null); }} /></label>
        </div>}
        {rangeError ? <p role="alert" className="text-xs text-danger">{rangeError}</p> : <blockquote className="whitespace-pre-wrap break-words border-l-2 border-primary pl-3 text-sm">{quote}</blockquote>}
      </>}
      <div role="group" aria-label="出题模式" className="grid w-full grid-cols-2 gap-1 rounded-xl border border-line bg-surface p-1 sm:max-w-xs">
        <button type="button" aria-pressed={generationMode === "manual"} onClick={() => { setGenerationMode("manual"); setError(""); setCreated(null); }}
          className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-primary ${generationMode === "manual" ? "bg-card text-ink shadow-sm" : "text-muted hover:text-ink"}`}>手动</button>
        <button type="button" aria-pressed={generationMode === "smart"} onClick={() => { setGenerationMode("smart"); setError(""); setCreated(null); }}
          className={`flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-primary ${generationMode === "smart" ? "bg-primary text-on-primary shadow-sm" : "text-primary hover:bg-primary-soft"}`}><RecommendationSparkles />智能推荐</button>
      </div>
      {generationMode === "manual" ? <>
        <ChallengeConditionsEditor value={conditions} onChange={value => { setConditions(value); setCreated(null); }} />
        <p className="whitespace-pre-wrap text-xs text-muted">{challengeQuestion(conditions)}</p>
        <button type="button" className={btnPrimary} disabled={!quote || loading || readingRepo || (conditions.mode === "custom" && !conditions.change.trim())} onClick={() => void create()}>{saving ? "正在保存练习…" : "创建依据深挖题"}</button>
      </> : <EvidenceRecommendationCard count={recommendationCount} onCountChange={count => { setRecommendationCount(count); setCreated(null); }}
        busy={saving} disabled={!quote || loading || readingRepo} onGenerate={() => void create()} />}
    </fieldset>
    {saving && generationMode === "smart" && <p role="status" className="text-xs text-muted">正在分析所选摘录，生成并保存推荐题…</p>}
    {error && <p role="alert" className="text-sm text-danger">{error}{generationMode === "smart" && <> <Link className="underline" href="/drills">查看练习列表</Link></>}</p>}
    {created && <div className="space-y-3 rounded-xl border border-primary/20 bg-primary-soft/30 p-4">
      <p role="status" className="text-sm text-primary">{created.questions ? `已生成并保存 ${created.count} 道推荐题。` : "依据与条件已保存。"}<Link className="ml-1 underline" href={`/drills/${created.id}`}>开始答辩练习 →</Link></p>
      {created.questions && <ol className="space-y-2" aria-label="推荐题目">{created.questions.map((question, index) => <li key={index} className="flex gap-3 rounded-lg border border-line bg-card p-3 text-sm leading-relaxed">
        <span className="pt-0.5 text-xs font-semibold tabular-nums text-primary">{String(index + 1).padStart(2, "0")}</span><span className="min-w-0 whitespace-pre-wrap break-words text-ink">{question}</span>
      </li>)}</ol>}
    </div>}
    <DirectoryPickerDialog open={pickerOpen} projectId={projectId} initialPath={repoPaths[0]} onClose={() => setPickerOpen(false)}
      onSelect={path => { setPickerOpen(false); onRepoPathSelected?.(path); void readRepo([path]); }} />
  </section>;
}
