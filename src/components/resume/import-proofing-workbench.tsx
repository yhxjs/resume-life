"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { collectProofingFields, findSourceMatches } from "@/lib/import-proofing";
import { btnGhost, btnPrimary, inputCls, textErr, textOk } from "@/lib/ui";
import { motionSafeScrollBehavior } from "@/lib/reduced-motion";

type Draft = { title: string; modules: Record<string, unknown> };
type OcrInfo = { engine: "vision" | "local"; pageCount: number; sourceType?: "pdf" | "image" };

export function ImportProofingWorkbench({
  draft, sourceText, ocrInfo, manualDraft, creating, error,
  onTitleChange, onConfirm, onBack, renderEditors,
}: {
  draft: Draft;
  sourceText: string;
  ocrInfo: OcrInfo | null;
  manualDraft: boolean;
  creating: boolean;
  error: string;
  onTitleChange: (title: string) => void;
  onConfirm: () => void;
  onBack: () => void;
  renderEditors: (onLocate: (id: string) => void) => ReactNode;
}) {
  const fields = useMemo(() => collectProofingFields(draft.modules), [draft.modules]);
  const [selection, setSelection] = useState<{ id: string; value: string; index: number } | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const [revealRequest, setRevealRequest] = useState(0);
  const sourceSectionRef = useRef<HTMLElement>(null);
  const sourcePaneRef = useRef<HTMLDivElement>(null);
  const currentMarkRef = useRef<HTMLElement>(null);
  const selectedField = fields.find((field) => field.id === selection?.id);
  const matches = useMemo(
    () => selectedField ? findSourceMatches(sourceText, selectedField) : [],
    [sourceText, selectedField]
  );
  const selectedIndex = selectedField && selection?.value === selectedField.value
    ? Math.min(selection.index, Math.max(matches.length - 1, 0)) : 0;

  function locate(id: string, revealSource = false) {
    const field = fields.find((candidate) => candidate.id === id);
    if (!field) return;
    setSelection({ id, value: field.value, index: 0 });
    if (revealSource) setRevealRequest((current) => current + 1);
  }

  function move(delta: -1 | 1) {
    if (!selectedField || matches.length < 2) return;
    setSelection({ id: selectedField.id, value: selectedField.value,
      index: (selectedIndex + delta + matches.length) % matches.length });
  }

  useEffect(() => {
    const section = sourceSectionRef.current;
    if (!revealRequest || window.innerWidth >= 1024 || !section || typeof window.scrollTo !== "function") return;
    window.scrollTo({ top: window.scrollY + section.getBoundingClientRect().top - 80, behavior: motionSafeScrollBehavior() });
  }, [revealRequest]);

  useEffect(() => {
    const pane = sourcePaneRef.current;
    const mark = currentMarkRef.current;
    if (!pane || !mark || typeof pane.scrollTo !== "function") return;
    const paneTop = pane.getBoundingClientRect().top;
    const markTop = mark.getBoundingClientRect().top;
    pane.scrollTo({ top: pane.scrollTop + markTop - paneTop - 64, behavior: motionSafeScrollBehavior() });
  }, [selectedField?.id, selectedField?.value, selectedIndex, matches]);

  async function copySource() {
    try {
      await navigator.clipboard.writeText(sourceText);
      setCopyStatus("原文已复制");
    } catch {
      setCopyStatus("复制失败，请手动选择原文");
    }
  }

  const sourceParts: ReactNode[] = [];
  let cursor = 0;
  for (const [index, match] of matches.entries()) {
    sourceParts.push(sourceText.slice(cursor, match.start));
    const current = index === selectedIndex;
    sourceParts.push(<mark
      key={`${match.start}-${match.end}`}
      ref={current ? currentMarkRef : undefined}
      aria-current={current ? "location" : undefined}
      data-match-index={index}
      className={`rounded-sm px-0.5 ${current
        ? "bg-accent-wash text-ink outline-2 outline-accent"
        : "bg-primary-soft text-ink"}`}
    >{sourceText.slice(match.start, match.end)}</mark>);
    cursor = match.end;
  }
  sourceParts.push(sourceText.slice(cursor));

  return (
    <div className="mx-auto max-w-[1500px]">
      <div className="border-b border-line pb-4">
        <div>
          <h1 className="font-serif text-[26px] font-bold leading-tight">确认解析草稿</h1>
          <p className="mt-1 text-sm text-muted">
            {manualDraft ? "根据左侧原文整理字段，确认后正式入库。" : "核对原文与解析字段，修正后确认导入。"}
          </p>
        </div>
      </div>
      {error && <p className={`mt-3 text-sm ${textErr}`} role="alert">{error}</p>}

      <div className="mt-5 grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.12fr)] xl:gap-8">
        <section ref={sourceSectionRef} className="min-w-0 lg:sticky lg:top-4 lg:self-start" aria-label="原文校对区">
          <div className="overflow-hidden rounded-lg border border-line bg-card">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-surface px-4 py-3">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-ink">导入原文</h2>
                <p className="text-xs text-muted">
                  {ocrInfo
                    ? `${ocrInfo.sourceType === "image" ? "图片" : "扫描件"} · ${ocrInfo.engine === "vision" ? "视觉模型 OCR" : "本地离线 OCR"} · ${ocrInfo.pageCount} 页`
                    : "原始文本 · 只读"}
                </p>
              </div>
              <button type="button" className={btnGhost} onClick={() => void copySource()} title="复制完整原文">复制原文</button>
            </div>
            <div ref={sourcePaneRef} aria-label="导入原文" className="max-h-[58vh] min-h-64 overflow-y-auto px-4 py-4 lg:max-h-[calc(100vh-13rem)]">
              <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-7 text-ink">{sourceParts}</pre>
            </div>
            <div className="border-t border-line px-4 py-2 text-xs text-muted">
              <span role="status" aria-label="原文定位状态" aria-live="polite">
                {selectedField
                  ? matches.length
                    ? `${selectedField.label} · 第 ${selectedIndex + 1} / ${matches.length} 处`
                    : `${selectedField.label} · 原文未找到`
                  : "选择右侧字段以定位原文"}
              </span>
              {copyStatus && <span className="ml-3" aria-live="polite">{copyStatus}</span>}
            </div>
          </div>
        </section>

        <div className="min-w-0">
          <section className="border-b border-line pb-5" aria-label="易错字段">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-ink">易错字段</h2>
                <p className="mt-0.5 text-xs text-muted">日期、联系方式、学校、公司与量化指标</p>
              </div>
              {selectedField && matches.length > 1 && <div className="flex items-center gap-2">
                <button type="button" className={btnGhost} onClick={() => move(-1)} aria-label="上一个匹配" title="上一个匹配">←</button>
                <span className="text-xs tabular-nums text-muted">{selectedIndex + 1} / {matches.length}</span>
                <button type="button" className={btnGhost} onClick={() => move(1)} aria-label="下一个匹配" title="下一个匹配">→</button>
              </div>}
            </div>
            {fields.length ? <ul className="mt-3 max-h-64 divide-y divide-line overflow-y-auto border-y border-line">
              {fields.map((field) => <li key={field.id}>
                <button type="button" onClick={() => locate(field.id, true)} aria-label={`定位原文：${field.label}`}
                  aria-pressed={selectedField?.id === field.id}
                  className={`flex w-full min-w-0 items-center gap-3 px-2 py-2.5 text-left transition-colors hover:bg-surface focus-visible:outline-2 focus-visible:outline-primary ${selectedField?.id === field.id ? "bg-accent-wash" : ""}`}>
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs text-muted">{field.label}</span>
                    <span className="block break-words text-sm font-medium text-ink">{field.value}</span>
                    <span className={`mt-0.5 block text-xs ${selectedField?.id === field.id
                      ? matches.length ? textOk : textErr
                      : "text-muted"}`}>
                      {selectedField?.id === field.id
                        ? matches.length ? "原文已定位" : "原文未找到"
                        : "待核对"}
                    </span>
                  </span>
                  <span className="shrink-0 rounded border border-accent/30 bg-accent-wash px-2 py-0.5 text-xs text-accent">{field.category}</span>
                </button>
              </li>)}
            </ul> : <p className="mt-3 text-sm text-muted">草稿中暂无可核对的易错字段。</p>}
          </section>

          <label className="mt-5 block max-w-lg">
            <span className="text-xs font-medium text-muted">简历标题</span>
            <input className={`${inputCls} mt-1`} value={draft.title} onChange={(event) => onTitleChange(event.target.value)} />
          </label>
          <div className="mt-6 space-y-8">{renderEditors(locate)}</div>
          <div className="mt-8 flex flex-wrap gap-3 border-t border-line pt-5">
            <button type="button" className={btnPrimary} onClick={onConfirm} disabled={creating}>{creating ? "创建中…" : "确认导入"}</button>
            <button type="button" className={btnGhost} onClick={onBack} disabled={creating}>返回重新解析</button>
          </div>
        </div>
      </div>
    </div>
  );
}
