"use client";

import { useEffect, useRef, useState } from "react";
import { Modal } from "@/components/common/modal";
import type { DescribableItem } from "@/lib/module-descriptions";
import { normalizeNewlines, stripDraftHeaders, type PolishMode } from "@/lib/polish";
import {
  fillSampleValues,
  segmentForPreview,
  segmentsToHtml,
  type SampleFill,
  type StyledSegment,
} from "@/lib/metric-highlight";
import { PRESET_RICH_COLORS, stripRichText } from "@/lib/rich-text";
import { btnGhost, btnPrimary, inputCls, labelCls, textErr } from "@/lib/ui";
import { errorMessage } from "@/lib/error-message";
import { jsonFetch } from "@/lib/fetcher";

type MetricBeautifyDialogProps = {
  resumeId: string;
  moduleType: "work" | "projects";
  items: DescribableItem[];
  /** 写入选中条目：id → 富文本 HTML，示例保留待确认标记 */
  onApply: (updates: { id: string; html: string }[]) => void;
};

type ItemResult = {
  status: "ok" | "err";
  /** AI 返回的原始纯文本草稿，改样式时复用它重算，不重新调模型 */
  draft: string;
  segments: StyledSegment[];
  html: string;
  sampleCount: number;
  error?: string;
};

/** 预览片段渲染成 React 元素：加粗、上色，示例值再包一层下划线 */
function PreviewSegments({ segments }: { segments: StyledSegment[] }) {
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.kind === "text") return <span key={i}>{seg.text}</span>;
        const inner = (
          <span style={seg.color !== "inherit" ? { color: seg.color } : undefined}>{seg.text}</span>
        );
        const bolded = seg.bold ? <strong key={i}>{inner}</strong> : inner;
        return seg.isSample ? <u key={i}>{bolded}</u> : <span key={i}>{bolded}</span>;
      })}
    </>
  );
}

/**
 * 模块级批量 AI 美化：一次处理当前模块的全部条目，量化成果自动加粗/上色，
 * 示例预览带下划线，写入时保留待确认文本标记，防止被当作真实成果导出。
 */
export function MetricBeautifyDialog({
  resumeId,
  moduleType,
  items,
  onApply,
}: MetricBeautifyDialogProps) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<PolishMode>("star");
  const [targetRole, setTargetRole] = useState("");
  const [metricBold, setMetricBold] = useState(true);
  const [metricColor, setMetricColor] = useState("inherit");
  const [fillSamples, setFillSamples] = useState(false);
  const [results, setResults] = useState<Record<string, ItemResult>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  /** 正在单独重试的条目 id */
  const [retrying, setRetrying] = useState<Set<string>>(new Set());
  /** 本轮正在排队或生成的条目 id 集合 */
  const [generatingIds, setGeneratingIds] = useState<Set<string>>(new Set());
  /** 当前正在调接口生成的条目 id */
  const [currentGeneratingId, setCurrentGeneratingId] = useState<string | null>(null);

  /** 运行代号：弹窗重开或新一批生成都会自增，使在途请求的结果全部作废 */
  const runRef = useRef(0);
  /** 当前批次的取消信号：关闭、卸载或启动新批次时终止在途请求 */
  const abortRef = useRef<AbortController | null>(null);
  /** 样式选项的最新值：发起请求时读它，保证重试与重跑都用当前样式 */
  const styleRef = useRef({ bold: true, color: "inherit", samples: false });

  function invalidateRun() {
    runRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
  }

  useEffect(() => () => {
    runRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  function handleOpen() {
    invalidateRun();
    styleRef.current = { bold: true, color: "inherit", samples: false };
    setMode("star");
    setTargetRole("");
    setMetricBold(true);
    setMetricColor("inherit");
    setFillSamples(false);
    setResults({});
    // 默认全选有内容的条目，若全部为空则默认全选
    const nonEmptyIds = items
      .filter((it) => stripRichText(it.text).trim().length > 0)
      .map((it) => it.id);
    const initialSelected = new Set(nonEmptyIds.length > 0 ? nonEmptyIds : items.map((it) => it.id));
    setSelected(initialSelected);
    setRetrying(new Set());
    setGeneratingIds(new Set());
    setCurrentGeneratingId(null);
    setProgress({ done: 0, total: 0 });
    setRunning(false);
    setOpen(true);
  }

  /** 对一段 AI 草稿套用指定样式与示例值设置，产出预览片段与写入 HTML */
  function styleDraft(
    draft: string,
    bold: boolean,
    color: string,
    samples: boolean
  ): Pick<ItemResult, "segments" | "html" | "sampleCount"> {
    const filled = samples
      ? fillSampleValues(draft)
      : { text: draft, filled: [] as SampleFill[] };
    const segments = segmentForPreview(filled.text, { bold, color, samples: filled.filled });
    return {
      segments,
      html: segmentsToHtml(segments),
      // 与预览片段同源：只有真正被标记的示例片段才计入警示条，
      // 否则警示条会报出比下划线标注更多的处数。
      sampleCount: segments.filter((s) => s.kind === "metric" && s.isSample).length,
    };
  }

  /** 样式或示例值设置变化：用缓存的草稿重算，不重新调用 AI */
  function restyle(next: { bold?: boolean; color?: string; samples?: boolean }) {
    const bold = next.bold ?? styleRef.current.bold;
    const color = next.color ?? styleRef.current.color;
    const samples = next.samples ?? styleRef.current.samples;
    // 失败行也要跟着落定样式：handleGenerate 读的是 styleRef，
    // 不同步的话「生成（某行失败）→ 改颜色 → 重新生成全部」会让那一行用上新颜色。
    styleRef.current = { bold, color, samples };
    if (next.bold !== undefined) setMetricBold(next.bold);
    if (next.color !== undefined) setMetricColor(next.color);
    if (next.samples !== undefined) setFillSamples(next.samples);

    setResults((prev) => {
      const out: Record<string, ItemResult> = {};
      for (const [id, r] of Object.entries(prev)) {
        out[id] = r.status === "ok" ? { ...r, ...styleDraft(r.draft, bold, color, samples) } : r;
      }
      return out;
    });
  }

  /**
   * 调一次模型并套用样式，产出该条目的结果；失败时返回 err 结果而不抛出。
   * runAt 是发起时的运行代号：等待期间弹窗被重开或新一批生成启动时，本次结果已无人接收。
   */
  async function generateOne(item: DescribableItem, runAt: number, signal: AbortSignal): Promise<ItemResult> {
    if (runRef.current !== runAt || signal.aborted) {
      return { status: "err", draft: "", segments: [], html: "", sampleCount: 0, error: "已取消" };
    }
    try {
      const data = await jsonFetch<{ result?: { draft?: string } }>(
        `/api/resumes/${resumeId}/polish`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal,
          body: JSON.stringify({
            text: stripRichText(item.text),
            moduleType,
            mode,
            context: item.context,
            targetRole: targetRole.trim(),
          }),
        }
      );
      const rawDraft = data.result?.draft ?? "";
      const normalizedDraft = normalizeNewlines(rawDraft);
      const draft = stripDraftHeaders(normalizedDraft, item.context);
      if (!draft.trim()) throw new Error("润色结果为空，请重试");
      const s = styleRef.current;
      return { status: "ok", draft, ...styleDraft(draft, s.bold, s.color, s.samples) };
    } catch (err) {
      return {
        status: "err",
        draft: "",
        segments: [],
        html: "",
        sampleCount: 0,
        error: errorMessage(err),
      };
    }
  }

  async function handleGenerate() {
    const targetItems = items.filter((it) => selected.has(it.id));
    if (targetItems.length === 0) return;

    invalidateRun();
    const controller = new AbortController();
    abortRef.current = controller;
    const myRun = runRef.current;
    setRunning(true);
    // 在途的单条重试会被本次运行代号作废，一并清掉它的「生成中…」标记
    setRetrying(new Set());
    setGeneratingIds(new Set(targetItems.map((it) => it.id)));
    setProgress({ done: 0, total: targetItems.length });
    // 保留未在此批重新生成的条目已有结果
    const next: Record<string, ItemResult> = { ...results };
    try {
      for (let i = 0; i < targetItems.length; i += 1) {
        const item = targetItems[i]!;
        if (runRef.current !== myRun) return;
        setCurrentGeneratingId(item.id);
        const res = await generateOne(item, myRun, controller.signal);
        if (runRef.current !== myRun) return;
        next[item.id] = res;
        setResults({ ...next });
        setGeneratingIds((prev) => {
          const nextSet = new Set(prev);
          nextSet.delete(item.id);
          return nextSet;
        });
        setProgress({ done: i + 1, total: targetItems.length });
      }
      if (runRef.current !== myRun) return;
      // 保证成功条目在选中集合中
      setSelected((prev) => {
        const nextSel = new Set(prev);
        for (const item of targetItems) {
          if (next[item.id]?.status === "ok") {
            nextSel.add(item.id);
          }
        }
        return nextSel;
      });
    } finally {
      if (runRef.current === myRun) {
        abortRef.current = null;
        setRunning(false);
        setGeneratingIds(new Set());
        setCurrentGeneratingId(null);
      }
    }
  }

  /** 单条重试 / 单条生成：只重算该条并 merge 进 results，其余条目不动 */
  async function handleRetry(item: DescribableItem) {
    invalidateRun();
    const controller = new AbortController();
    abortRef.current = controller;
    const myRun = runRef.current;
    setRetrying((prev) => new Set(prev).add(item.id));
    try {
      const result = await generateOne(item, myRun, controller.signal);
      if (runRef.current !== myRun) return;
      setResults((prev) => ({ ...prev, [item.id]: result }));
      if (result.status === "ok") {
        setSelected((prev) => new Set(prev).add(item.id));
      }
    } finally {
      if (runRef.current === myRun) {
        abortRef.current = null;
        setRetrying((prev) => {
          const nextRetrying = new Set(prev);
          nextRetrying.delete(item.id);
          return nextRetrying;
        });
      }
    }
  }

  const okItems = items.filter((it) => results[it.id]?.status === "ok");
  // 只数「将写入」的条目：警示条描述的是即将落库的内容，未勾选/生成中的条目一律不计
  const totalSamples = items
    .filter((it) => selected.has(it.id) && results[it.id]?.status === "ok")
    .reduce((sum, it) => sum + (results[it.id]?.sampleCount ?? 0), 0);
  // 只数选中且成功的条目：重新生成后某个原来选中的 id 可能变成失败态
  const appliedCount = okItems.filter((it) => selected.has(it.id)).length;
  const hasResults = okItems.length > 0;
  const selectedCount = items.filter((it) => selected.has(it.id)).length;

  function handleClose() {
    invalidateRun();
    setRunning(false);
    setRetrying(new Set());
    setGeneratingIds(new Set());
    setCurrentGeneratingId(null);
    setOpen(false);
  }

  function handleSelectAll() {
    if (selected.size === items.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(items.map((it) => it.id)));
    }
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const nextSelected = new Set(prev);
      if (nextSelected.has(id)) nextSelected.delete(id);
      else nextSelected.add(id);
      return nextSelected;
    });
  }

  function handleWrite() {
    // segmentsToHtml 已限制标签并转义文本；写入侧由 splitRichTextToLines 统一清洗。
    const updates = items
      .filter((it) => selected.has(it.id) && results[it.id]?.status === "ok")
      .map((it) => ({ id: it.id, html: results[it.id]!.html }));
    if (updates.length === 0) return;
    onApply(updates);
    handleClose();
  }

  const triggerLabel = `✨ AI 美化（${items.length} 条）`;

  return (
    <>
      <button
        type="button"
        className={`${btnGhost} text-primary hover:text-primary-hover`}
        onClick={handleOpen}
        disabled={items.length === 0}
        title="一次美化本模块的全部条目，并自动给量化成果加粗上色"
      >
        {triggerLabel}
      </button>

      <Modal
        open={open}
        title="AI 美化"
        onClose={handleClose}
        loading={running}
        loadingText={`AI 经历量化美化中… (${progress.done}/${progress.total})`}
        loadingDescription="正在基于 STAR 原则与度量指标逐条分析扩写，请稍候…"
      >
        <div className="space-y-4">
          <div>
            <h2 className="font-serif text-lg font-bold text-ink">✨ AI 美化 · 经历量化</h2>
            <p className="mt-0.5 text-xs text-muted">
              共 {items.length} 条，支持选择部分或全部进行 AI 美化与量化
            </p>
          </div>

          <div>
            <span className={labelCls}>润色模式</span>
            <div
              className="mt-1.5 inline-flex rounded-lg bg-surface p-1"
              role="group"
              aria-label="润色模式"
            >
              <button
                type="button"
                className={`rounded-lg px-3.5 py-1.5 text-sm font-medium transition-all ${
                  mode === "star" ? "bg-card text-ink font-bold shadow-xs" : "text-muted hover:text-ink"
                }`}
                onClick={() => setMode("star")}
                aria-pressed={mode === "star"}
              >
                🌟 STAR 结构重构
              </button>
              <button
                type="button"
                className={`rounded-lg px-3.5 py-1.5 text-sm font-medium transition-all ${
                  mode === "quantify"
                    ? "bg-card text-ink font-bold shadow-xs"
                    : "text-muted hover:text-ink"
                }`}
                onClick={() => setMode("quantify")}
                aria-pressed={mode === "quantify"}
              >
                📊 深度量化扩写
              </button>
            </div>
          </div>

          <label className="block">
            <span className={labelCls}>目标岗位/偏向（选填）</span>
            <input
              className={`${inputCls} mt-1`}
              value={targetRole}
              onChange={(e) => setTargetRole(e.target.value)}
              placeholder="如：前端架构师 / 资深后端"
            />
          </label>

          <div>
            <span className={labelCls}>量化成果样式</span>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <button
                type="button"
                aria-pressed={metricBold}
                onClick={() => restyle({ bold: !metricBold })}
                disabled={running}
                className={`h-9 min-h-[36px] rounded-lg border px-3 text-sm font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                  metricBold
                    ? "border-primary bg-primary text-on-primary"
                    : "border-line bg-card text-ink hover:bg-surface"
                }`}
              >
                B 加粗
              </button>
              <select
                className={`${inputCls} w-auto`}
                value={metricColor}
                onChange={(e) => restyle({ color: e.target.value })}
                disabled={running}
                aria-label="量化成果颜色"
              >
                {PRESET_RICH_COLORS.map((c) => (
                  <option key={c.id} value={c.color}>
                    {c.label}
                  </option>
                ))}
              </select>
              <label className="flex cursor-pointer items-center gap-1.5 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={fillSamples}
                  onChange={(e) => restyle({ samples: e.target.checked })}
                  disabled={running}
                  className="h-4 w-4 accent-(--primary)"
                />
                自动填入示例值
              </label>
            </div>
            <p className="mt-1 text-[11px] text-faint">
              示例值仅供排版参考；写入后保留「待确认示例」标记，需核实并修改后才能导出
            </p>
          </div>

          <div className="flex justify-end">
            <button
              type="button"
              className={btnPrimary}
              onClick={handleGenerate}
              disabled={running || selectedCount === 0}
            >
              {running
                ? `美化中… ${progress.done}/${progress.total}`
                : selectedCount === 0
                  ? "请选择条目"
                  : !hasResults
                    ? selectedCount === items.length
                      ? "开始美化"
                      : `开始美化所选 (${selectedCount} 条)`
                    : selectedCount === items.length
                      ? "重新生成全部"
                      : `重新生成所选 (${selectedCount} 条)`}
            </button>
          </div>

          {totalSamples > 0 && (
            <div className="rounded-lg border border-accent/30 bg-accent-wash px-3 py-2 text-xs text-ink">
              ⚠ 已自动填入 {totalSamples} 处示例值；写入后仍会标记为待确认，导出前必须核实并修改
            </div>
          )}

          {items.length > 0 && (
            <div>
              <div className="mb-1.5 flex items-center justify-between text-xs text-muted">
                <span>
                  共 {items.length} 条，已选 {selected.size} 条进行美化
                </span>
                <button
                  type="button"
                  onClick={handleSelectAll}
                  disabled={running}
                  className="text-primary hover:underline disabled:opacity-50"
                >
                  {selected.size === items.length ? "全不选" : "全选"}
                </button>
              </div>
              <div className="divide-y divide-line rounded-lg border border-line">
                {items.map((item, index) => {
                  const r = results[item.id];
                  const empty = stripRichText(item.text).trim().length === 0;
                  return (
                    <div key={item.id} className="p-3">
                      <div className="flex items-center justify-between gap-2">
                        <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                          <input
                            type="checkbox"
                            className="h-4 w-4 shrink-0 rounded accent-(--primary)"
                            checked={selected.has(item.id)}
                            disabled={running}
                            onChange={() => toggle(item.id)}
                            title={
                              r?.status === "ok"
                                ? "已生成，勾选以写入简历"
                                : r?.status === "err"
                                  ? "生成失败，可重试或取消勾选"
                                  : "勾选以进行 AI 美化"
                            }
                            aria-label={`写入第 ${index + 1} 条`}
                          />
                          <span className="shrink-0 font-mono text-xs text-faint">#{index + 1}</span>
                          <span className="truncate text-sm font-medium text-ink">
                            {item.title || "（未命名）"}
                          </span>
                          {empty && (
                            <span className="shrink-0 text-xs text-faint">
                              （原内容为空，将生成框架）
                            </span>
                          )}
                        </label>
                        {!running && (
                          <div className="shrink-0 flex items-center gap-1">
                            {r?.status === "ok" && (
                              <button
                                type="button"
                                className={`${btnGhost} px-2 py-0.5 text-xs text-muted hover:text-ink min-h-[26px]`}
                                onClick={() => handleRetry(item)}
                                disabled={retrying.has(item.id)}
                                title="仅重新生成本条"
                              >
                                {retrying.has(item.id) ? "生成中…" : "单条重跑"}
                              </button>
                            )}
                            {!r && (
                              <button
                                type="button"
                                className={`${btnGhost} px-2 py-0.5 text-xs text-primary hover:text-primary-hover min-h-[26px]`}
                                onClick={() => handleRetry(item)}
                                disabled={retrying.has(item.id)}
                                title="仅美化本条"
                              >
                                {retrying.has(item.id) ? "生成中…" : "单条美化"}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                      {/* 当前正在调用模型生成此条目 */}
                      {(currentGeneratingId === item.id || retrying.has(item.id)) && (
                        <p className="mt-2 pl-6 text-xs text-muted animate-pulse">
                          生成中…
                        </p>
                      )}

                      {/* 本条目在当前批量生成队列中排队等待 */}
                      {generatingIds.has(item.id) && currentGeneratingId !== item.id && (
                        <p className="mt-2 pl-6 text-xs text-muted">
                          等待中…
                        </p>
                      )}

                      {/* 成功预览（当前非重新生成中） */}
                      {r?.status === "ok" &&
                        !generatingIds.has(item.id) &&
                        currentGeneratingId !== item.id &&
                        !retrying.has(item.id) && (
                          <div className="mt-2 pl-6 whitespace-pre-line text-sm leading-relaxed text-ink">
                            <PreviewSegments segments={r.segments} />
                          </div>
                        )}

                      {/* 失败提示（当前非重新生成中） */}
                      {r?.status === "err" &&
                        !generatingIds.has(item.id) &&
                        currentGeneratingId !== item.id &&
                        !retrying.has(item.id) && (
                          <div className="mt-2 pl-6 flex items-center gap-2">
                            <p className={`text-xs ${textErr}`}>失败：{r.error}</p>
                            <button
                              type="button"
                              className={`${btnGhost} px-2 py-1 text-xs min-h-[28px]`}
                              onClick={() => handleRetry(item)}
                              disabled={running || retrying.has(item.id)}
                            >
                              {retrying.has(item.id) ? "生成中…" : "重试"}
                            </button>
                          </div>
                        )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-line pt-3">
            <button type="button" className={btnGhost} onClick={handleClose}>
              取消
            </button>
            <button
              type="button"
              className={btnPrimary}
              onClick={handleWrite}
              disabled={running || appliedCount === 0}
              title={running ? "生成中，请等待本批完成后再写入" : undefined}
            >
              写入选中 {appliedCount} 条
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
