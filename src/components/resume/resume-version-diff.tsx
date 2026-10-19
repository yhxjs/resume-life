"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import type { ResumeSnapshot } from "@/lib/resume-version-types";
import { compareResumeVersions, type ResumeDiffRow } from "@/lib/resume-version-diff";
import { previewChanges, type PreviewChange } from "@/lib/resume-preview-changes";
import { changedTextRanges, type TextRange } from "@/lib/resume-inline-diff";
import { decodeHtmlEntities, stripRichText } from "@/lib/rich-text";
import { prepare, ResumeDoc } from "@/components/resume/doc";
import { RichText } from "@/components/resume/rich-text";

const statuses = { added: "+ 新增", removed: "− 删除", changed: "~ 修改", unchanged: "未变化" };
const tones = { added: "bg-primary-soft text-primary", removed: "bg-danger-wash text-danger", changed: "bg-accent-wash text-accent", unchanged: "bg-surface text-muted" };

function previewTarget(paper: HTMLElement, change: PreviewChange): HTMLElement | undefined {
  const moduleElement = Array.from(paper.querySelectorAll<HTMLElement>("[data-resume-module]"))
    .find((element) => element.dataset.resumeModule === change.moduleKey);
  if (change.entryIndex === undefined) return moduleElement;
  return Array.from(moduleElement?.querySelectorAll<HTMLElement>("[data-resume-entry]") ?? [])
    .find((element) => element.dataset.resumeEntry === String(change.entryIndex));
}

function domTextRanges(element: HTMLElement, spans: TextRange[]): Range[] {
  const nodes: { node: Text; start: number; end: number }[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let offset = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.data.length) nodes.push({ node, start: offset, end: offset + node.data.length });
    offset += node.data.length;
  }
  return spans.flatMap(({ start, end }) => {
    const first = nodes.find((part) => part.end > start);
    const last = nodes.find((part) => part.end >= end);
    if (!first || !last) return [];
    const range = document.createRange();
    range.setStart(first.node, start - first.start);
    range.setEnd(last.node, end - last.start);
    return [range];
  });
}

function SnapshotPreview({ snapshot, changes, paperRef }: { snapshot: ResumeSnapshot; changes: PreviewChange[]; paperRef: RefObject<HTMLDivElement | null> }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const resize = () => { if (container.clientWidth) setScale(container.clientWidth / 794); };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const paper = paperRef.current;
    if (!paper) return;
    for (const change of changes) {
      const target = previewTarget(paper, change);
      if (!target) continue;
      target.dataset.versionChange = change.status;
      target.dataset.versionLabel = { added: "新增", removed: "删除", changed: "修改" }[change.status];
    }
    return () => {
      paper.querySelectorAll<HTMLElement>("[data-version-change]").forEach((element) => {
        delete element.dataset.versionChange;
        delete element.dataset.versionLabel;
      });
    };
  }, [snapshot, changes, paperRef]);

  return <div ref={containerRef} className="min-w-0">
    {/* 缩放整张 A4 的布局尺寸，保留原始换行，长简历随内容自然撑开。 */}
    <div ref={paperRef} className="paper version-compare-paper mx-auto min-h-[297mm] w-[210mm] bg-white text-black" style={{ zoom: scale, "--version-badge-size": `${11 / scale}px`, "--version-outline-width": `${2 / scale}px` } as CSSProperties}>
      <ResumeDoc prepared={prepare(snapshot.title, snapshot.modules)} style={snapshot.resolved_style} />
    </div>
  </div>;
}

function Cell({ row, side }: { row: ResumeDiffRow; side: "before" | "after" }) {
  const text = row[side];
  if (text === null) return <span className="text-muted">— 无此内容</span>;
  if (row.status !== "changed") return <RichText content={text} />;
  const visibleText = (value: string) => stripRichText(value.includes("&lt;") && value.includes("&gt;") ? decodeHtmlEntities(value) : value);
  const beforeText = visibleText(row.before ?? "");
  const afterText = visibleText(row.after ?? "");
  const content = side === "before" ? beforeText : afterText;
  const spans = changedTextRanges(beforeText, afterText)[side];
  const parts = spans.flatMap(({ start, end }, index) => {
    const unchanged = content.slice(spans[index - 1]?.end ?? 0, start);
    const changed = content.slice(start, end);
    return [unchanged, side === "before"
      ? <del key={index} className="rounded bg-danger/15 text-danger decoration-danger">{changed}</del>
      : <ins key={index} className="rounded bg-primary/15 text-primary decoration-primary">{changed}</ins>];
  });
  return <>{parts}{content.slice(spans.at(-1)?.end ?? 0)}</>;
}

export function ResumeVersionDiff({ before, after, beforeLabel, afterLabel }: { before: ResumeSnapshot | null; after: ResumeSnapshot; beforeLabel: string; afterLabel: string }) {
  const [onlyChanges, setOnlyChanges] = useState(false);
  const beforePaperRef = useRef<HTMLDivElement>(null);
  const afterPaperRef = useRef<HTMLDivElement>(null);
  const rows = compareResumeVersions(before, after);
  const changed = rows.filter((row) => row.status !== "unchanged");
  const sections = Array.from(new Set(changed.map((row) => row.section)));
  const markers = useMemo(() => previewChanges(before, after), [before, after]);
  const styleChanged = before !== null && changed.some((row) => row.section === "排版设置" || row.key === "template");
  const nameChanged = before !== null && changed.some((row) => row.key === "title");

  useEffect(() => {
    const leftPaper = beforePaperRef.current;
    const rightPaper = afterPaperRef.current;
    if (!before || !leftPaper || !rightPaper || onlyChanges || typeof CSS === "undefined" || !CSS.highlights || typeof Highlight === "undefined") return;

    // Next 的 CSS 处理器尚不识别 ::highlight；交给浏览器解析，不影响纸张原本的布局样式。
    const highlightStyle = document.createElement("style");
    highlightStyle.textContent = `
      ::highlight(resume-version-before) { background-color: color-mix(in srgb, var(--danger) 32%, transparent); text-decoration: underline; text-decoration-color: var(--danger); }
      ::highlight(resume-version-after) { background-color: color-mix(in srgb, var(--primary) 32%, transparent); text-decoration: underline; text-decoration-color: var(--primary); }
    `;
    document.head.append(highlightStyle);
    const leftRanges: Range[] = [];
    const rightRanges: Range[] = [];
    for (const oldChange of markers.before) {
      if (oldChange.status !== "changed") continue;
      const oldModule = before.modules.find((module) => module.key === oldChange.moduleKey);
      const newModule = after.modules.find((module) => module.key === oldChange.moduleKey);
      if (!oldModule || !newModule) continue;
      let newIndex = oldChange.entryIndex;
      if (newIndex !== undefined) {
        if (!Array.isArray(oldModule.content) || !Array.isArray(newModule.content)) continue;
        const oldEntry = oldModule.content[newIndex] as { id?: unknown } | undefined;
        const id = String(oldEntry?.id ?? newIndex);
        newIndex = newModule.content.findIndex((entry, index) => String((entry as { id?: unknown })?.id ?? index) === id);
        if (newIndex < 0) continue;
      }
      const newChange = markers.after.find((change) => change.status === "changed" && change.moduleKey === oldChange.moduleKey && change.entryIndex === newIndex);
      if (!newChange) continue;
      const oldElement = previewTarget(leftPaper, oldChange);
      const newElement = previewTarget(rightPaper, newChange);
      if (!oldElement || !newElement) continue;
      const diff = changedTextRanges(oldElement.textContent ?? "", newElement.textContent ?? "");
      const oldRanges = domTextRanges(oldElement, diff.before);
      const newRanges = domTextRanges(newElement, diff.after);
      if (!oldRanges.length && !newRanges.length) continue;
      leftRanges.push(...oldRanges);
      rightRanges.push(...newRanges);
      oldElement.dataset.versionInline = "true";
      newElement.dataset.versionInline = "true";
    }
    if (leftRanges.length) CSS.highlights.set("resume-version-before", new Highlight(...leftRanges));
    if (rightRanges.length) CSS.highlights.set("resume-version-after", new Highlight(...rightRanges));
    return () => {
      CSS.highlights.delete("resume-version-before");
      CSS.highlights.delete("resume-version-after");
      highlightStyle.remove();
      for (const paper of [leftPaper, rightPaper]) {
        paper.querySelectorAll<HTMLElement>("[data-version-inline]").forEach((element) => { delete element.dataset.versionInline; });
      }
    };
  }, [before, after, markers, onlyChanges]);

  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p role="status" className="flex flex-wrap gap-3 text-sm">{(["added", "removed", "changed"] as const).map((status) => <span key={status} className={`rounded px-2 py-1 ${tones[status]}`}>{statuses[status]} <span className="font-mono">{changed.filter((row) => row.status === status).length}</span></span>)}</p>
      <label className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" checked={onlyChanges} onChange={(event) => setOnlyChanges(event.target.checked)} />仅看变化</label>
    </div>
    {onlyChanges && changed.length === 0 ? <p className="rounded-lg bg-surface px-4 py-8 text-center text-sm text-muted">这两个版本的内容与排版没有变化。</p> :
      <div className="overflow-x-auto rounded-lg border border-line" tabIndex={0} role="region" aria-label="简历左右对照">
        <div className={onlyChanges ? "min-w-[560px]" : "min-w-[720px]"}>
          <div className="grid grid-cols-2 border-b border-line bg-surface text-sm font-semibold"><div className="min-w-0 break-words border-r border-line p-3">修改前 · {beforeLabel}</div><div className="min-w-0 break-words p-3">修改后 · {afterLabel}</div></div>
          {onlyChanges ? sections.map((section) => <section key={section} aria-label={`${section}差异`}>
            <h3 className="border-b border-line bg-surface px-3 py-2 font-serif text-sm font-semibold">{section}</h3>
            {changed.filter((row) => row.section === section).map((row) => <div key={row.key} className="border-b border-line last:border-b-0">
              <div className="flex flex-wrap items-center gap-2 px-3 py-2"><span className={`rounded px-1.5 py-0.5 text-xs ${tones[row.status]}`}>{statuses[row.status]}</span><span className="break-words text-xs font-medium text-muted">{row.label}</span></div>
              <div className="grid grid-cols-2 text-sm leading-relaxed">
                <div className={`min-w-0 whitespace-pre-wrap break-words border-r border-line p-3 ${row.status === "removed" || row.status === "changed" ? "bg-danger-wash/50" : ""}`}><Cell row={row} side="before" /></div>
                <div className={`min-w-0 whitespace-pre-wrap break-words p-3 ${row.status === "added" || row.status === "changed" ? "bg-primary-soft/50" : ""}`}><Cell row={row} side="after" /></div>
              </div>
            </div>)}
          </section>) : <>
            {(styleChanged || nameChanged) && <div className="flex flex-wrap gap-2 border-b border-line px-3 py-2 text-xs text-accent">{styleChanged && <span className="rounded bg-accent-wash px-2 py-1">排版已修改</span>}{nameChanged && <span className="rounded bg-accent-wash px-2 py-1">简历名称已修改</span>}</div>}
            <div className="grid grid-cols-2 items-start bg-surface">
              <div className="min-w-0 p-3">{before ? <SnapshotPreview snapshot={before} changes={markers.before} paperRef={beforePaperRef} /> : <p className="py-12 text-center text-sm text-muted">未选择参照版本</p>}</div>
              <div className="min-w-0 p-3"><SnapshotPreview snapshot={after} changes={markers.after} paperRef={afterPaperRef} /></div>
            </div>
          </>}
        </div>
      </div>}
    <p className="text-xs leading-relaxed text-muted">{onlyChanges ? "按字段与条目显示差异，包含模块顺序、头像和排版设置。" : "纸张中以红色标记修改前文字、绿色标记修改后文字；整条新增或删除保留范围标记。勾选“仅看变化”可查看具体字段。"}窄屏可横向滚动查看左右对照。</p>
  </div>;
}
