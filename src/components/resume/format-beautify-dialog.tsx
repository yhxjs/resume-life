"use client";

import { useMemo, useState } from "react";
import { Modal } from "@/components/common/modal";
import type { DescribableItem } from "@/lib/module-descriptions";
import {
  fillSampleValues,
  segmentForPreview,
  segmentsToHtml,
  type SampleFill,
  type StyledSegment,
} from "@/lib/metric-highlight";
import { PRESET_RICH_COLORS, stripRichText } from "@/lib/rich-text";
import { btnGhost, btnPrimary, inputCls, labelCls } from "@/lib/ui";

type FormatBeautifyDialogProps = {
  items: DescribableItem[];
  /** 写入选中条目：id → 最终富文本 HTML（已剥离预览标记） */
  onApply: (updates: { id: string; html: string }[]) => void;
};

type ItemFormatResult = {
  id: string;
  title: string;
  rawText: string;
  empty: boolean;
  segments: StyledSegment[];
  html: string;
  metricCount: number;
  sampleCount: number;
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

/** 对一段纯文本套用指定样式与示例值设置，产出预览片段、写入 HTML 及统计 */
function formatItemText(
  rawText: string,
  bold: boolean,
  color: string,
  samples: boolean
): { segments: StyledSegment[]; html: string; metricCount: number; sampleCount: number } {
  const filled = samples
    ? fillSampleValues(rawText)
    : { text: rawText, filled: [] as SampleFill[] };
  const segments = segmentForPreview(filled.text, { bold, color, samples: filled.filled });
  const metrics = segments.filter((s) => s.kind === "metric");
  return {
    segments,
    html: segmentsToHtml(segments),
    metricCount: metrics.length,
    sampleCount: metrics.filter((s) => s.isSample).length,
  };
}

/**
 * 纯粹的量化格式美化弹窗：
 * 不调用大模型修改经历文案，仅通过量化指标规则引擎对现有文本进行加粗、上色等排版美化。
 */
export function FormatBeautifyDialog({
  items,
  onApply,
}: FormatBeautifyDialogProps) {
  const [open, setOpen] = useState(false);
  const [metricBold, setMetricBold] = useState(true);
  const [metricColor, setMetricColor] = useState("inherit");
  const [fillSamples, setFillSamples] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  function handleOpen() {
    setMetricBold(true);
    setMetricColor("inherit");
    setFillSamples(false);
    // 默认全选非空条目
    setSelected(new Set(items.filter((it) => stripRichText(it.text).trim().length > 0).map((it) => it.id)));
    setOpen(true);
  }

  // 纯前端响应式计算，随样式配置实时变换
  const formattedItems: ItemFormatResult[] = useMemo(() => {
    return items.map((it) => {
      const rawText = stripRichText(it.text).trim();
      const empty = rawText.length === 0;
      const formatted = empty
        ? { segments: [], html: "", metricCount: 0, sampleCount: 0 }
        : formatItemText(rawText, metricBold, metricColor, fillSamples);
      return {
        id: it.id,
        title: it.title,
        rawText,
        empty,
        ...formatted,
      };
    });
  }, [items, metricBold, metricColor, fillSamples]);

  const totalSamples = formattedItems
    .filter((it) => selected.has(it.id))
    .reduce((sum, it) => sum + it.sampleCount, 0);

  const totalMetrics = formattedItems
    .filter((it) => selected.has(it.id))
    .reduce((sum, it) => sum + it.metricCount, 0);

  const appliedCount = formattedItems.filter((it) => selected.has(it.id) && !it.empty).length;

  function toggle(id: string) {
    setSelected((prev) => {
      const nextSelected = new Set(prev);
      if (nextSelected.has(id)) nextSelected.delete(id);
      else nextSelected.add(id);
      return nextSelected;
    });
  }

  function handleSelectAll() {
    const nonEmpties = formattedItems.filter((it) => !it.empty).map((it) => it.id);
    if (selected.size === nonEmpties.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(nonEmpties));
    }
  }

  function handleWrite() {
    const updates = formattedItems
      .filter((it) => selected.has(it.id) && !it.empty)
      .map((it) => ({ id: it.id, html: it.html }));
    if (updates.length === 0) return;
    onApply(updates);
    setOpen(false);
  }

  const triggerLabel = `🎨 格式美化（${items.length} 条）`;

  return (
    <>
      <button
        type="button"
        className={`${btnGhost} text-muted hover:text-ink`}
        onClick={handleOpen}
        disabled={items.length === 0}
        title="仅对现有文本中的量化指标进行加粗和高亮排版，不修改您的原文"
      >
        {triggerLabel}
      </button>

      <Modal open={open} title="格式美化" onClose={() => setOpen(false)}>
        <div className="space-y-4">
          <div>
            <h2 className="font-serif text-lg font-bold text-ink">🎨 格式美化 · 量化指标高亮</h2>
            <p className="mt-0.5 text-xs text-muted">
              基于当前经历文本自动识别量化指标并套用样式，不修改您的文字内容
            </p>
          </div>

          <div>
            <span className={labelCls}>量化成果样式</span>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <button
                type="button"
                aria-pressed={metricBold}
                onClick={() => setMetricBold(!metricBold)}
                className={`h-9 min-h-[36px] rounded-lg border px-3 text-sm font-bold transition-colors ${
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
                onChange={(e) => setMetricColor(e.target.value)}
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
                  onChange={(e) => setFillSamples(e.target.checked)}
                  className="h-4 w-4 accent-(--primary)"
                />
                自动填入示例值
              </label>
            </div>
            <p className="mt-1 text-[11px] text-faint">
              识别百分比、响应耗时、QPS、用户量等指标并自动着色，支持即时预览
            </p>
          </div>

          {totalSamples > 0 && (
            <div className="rounded-lg border border-accent/30 bg-accent-wash px-3 py-2 text-xs text-ink">
              ⚠ 已将 {totalSamples} 处量化占位符替换为示例值；写入后保留待确认标记，核实并修改后才能导出
            </div>
          )}

          {items.length > 0 && (
            <div>
              <div className="mb-1.5 flex items-center justify-between text-xs text-muted">
                <span>
                  共 {items.length} 条，选中 {appliedCount} 条
                  {totalMetrics > 0 ? `（共识别出 ${totalMetrics} 处量化指标）` : ""}
                </span>
                <button
                  type="button"
                  onClick={handleSelectAll}
                  className="text-primary hover:underline"
                >
                  {selected.size === formattedItems.filter((it) => !it.empty).length ? "全不选" : "全选"}
                </button>
              </div>
              <div className="divide-y divide-line rounded-lg border border-line">
                {formattedItems.map((item, index) => (
                  <div key={item.id} className="p-3">
                    <div className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4 accent-(--primary)"
                        checked={selected.has(item.id)}
                        disabled={item.empty}
                        onChange={() => toggle(item.id)}
                        aria-label={`写入第 ${index + 1} 条`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-ink">
                            <span className="font-mono text-xs text-faint">#{index + 1}</span>{" "}
                            {item.title || "（未命名）"}
                          </p>
                          {item.empty ? (
                            <span className="text-xs text-faint">（内容为空）</span>
                          ) : item.metricCount > 0 ? (
                            <span className="rounded bg-surface px-1.5 py-0.5 text-[11px] text-muted">
                              {item.metricCount} 处指标
                            </span>
                          ) : (
                            <span className="text-xs text-faint">（未检测到量化指标）</span>
                          )}
                        </div>
                        {!item.empty && (
                          <div className="mt-1 whitespace-pre-line text-sm leading-relaxed text-ink">
                            <PreviewSegments segments={item.segments} />
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-line pt-3">
            <button type="button" className={btnGhost} onClick={() => setOpen(false)}>
              取消
            </button>
            <button
              type="button"
              className={btnPrimary}
              onClick={handleWrite}
              disabled={appliedCount === 0}
            >
              应用到选中的 {appliedCount} 项
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
