"use client";

import { useId, useMemo, useState } from "react";
import { SectionTitle } from "@/components/common/ui-bits";
import { cardCls } from "@/lib/ui";
import type { LlmDailyUsage, LlmFeatureUsage, LlmModelUsage } from "@/lib/llm-call-log";

type MetricType = "tokens" | "calls";
type ChartType = "bar" | "area";

const CHART_WIDTH = 800;
const CHART_HEIGHT = 240;
const PAD_LEFT = 52;
const PAD_RIGHT = 16;
const PAD_TOP = 20;
const PAD_BOTTOM = 34;
const PLOT_WIDTH = CHART_WIDTH - PAD_LEFT - PAD_RIGHT;
const PLOT_HEIGHT = CHART_HEIGHT - PAD_TOP - PAD_BOTTOM;

function calcY(val: number, maxVal: number): number {
  const ratio = Math.min(Math.max(val / maxVal, 0), 1);
  return PAD_TOP + (1 - ratio) * PLOT_HEIGHT;
}

function calcX(idx: number, count: number): number {
  if (count <= 1) return PAD_LEFT + PLOT_WIDTH / 2;
  return PAD_LEFT + (idx / (count - 1)) * PLOT_WIDTH;
}

function compactNumber(val: number): string {
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(1)}M`;
  if (val >= 1_000) return `${(val / 1_000).toFixed(1)}k`;
  return String(val);
}

function formatDateLabel(dateStr: string): string {
  // 转换 "YYYY-MM-DD" 为 "MM-DD"
  if (dateStr.length >= 10) {
    return dateStr.slice(5, 10);
  }
  return dateStr;
}

export function LlmDailyTrendChart({ daily }: { daily: LlmDailyUsage[] }) {
  const [metric, setMetric] = useState<MetricType>("tokens");
  const [chartType, setChartType] = useState<ChartType>("bar");
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const gradientId = useId();

  // 计算当前指标的值数组
  const { values, maxVal, totalVal } = useMemo(() => {
    const vals = daily.map((d) =>
      metric === "tokens" ? d.inputTokens + d.outputTokens : d.calls
    );
    const max = Math.max(...vals, 0);
    const sum = vals.reduce((acc, v) => acc + v, 0);
    // 为避免最大值为 0 时除以零，保底为 10（tokens）或 5（calls）
    return {
      values: vals,
      maxVal: max > 0 ? max : metric === "tokens" ? 100 : 5,
      totalVal: sum,
    };
  }, [daily, metric]);

  const count = daily.length;

  // 计算每个柱子的 X 与宽度
  const barSlotWidth = count > 0 ? PLOT_WIDTH / count : PLOT_WIDTH;
  const barWidth = Math.max(Math.min(barSlotWidth * 0.65, 28), 3);

  // 生成面积/折线路径
  const { linePath, areaPath } = useMemo(() => {
    if (count === 0) return { linePath: "", areaPath: "" };
    if (count === 1) {
      const x = PAD_LEFT + PLOT_WIDTH / 2;
      const y = calcY(values[0] ?? 0, maxVal);
      return {
        linePath: `M ${x - 20} ${y} L ${x + 20} ${y}`,
        areaPath: `M ${x - 20} ${PAD_TOP + PLOT_HEIGHT} L ${x - 20} ${y} L ${x + 20} ${y} L ${x + 20} ${PAD_TOP + PLOT_HEIGHT} Z`,
      };
    }

    const points = values.map((val, idx) => ({
      x: calcX(idx, count),
      y: calcY(val, maxVal),
    }));

    if (points.length === 0) return { linePath: "", areaPath: "" };
    const firstP = points[0]!;
    const lastP = points[points.length - 1]!;

    const line = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
    const area = `${line} L ${lastP.x.toFixed(1)} ${PAD_TOP + PLOT_HEIGHT} L ${firstP.x.toFixed(1)} ${PAD_TOP + PLOT_HEIGHT} Z`;

    return { linePath: line, areaPath: area };
  }, [count, values, maxVal]);

  // X 轴日期标注动态步长抽样
  const dateStep = useMemo(() => {
    if (count <= 8) return 1;
    if (count <= 16) return 2;
    if (count <= 32) return 4;
    return Math.ceil(count / 8);
  }, [count]);

  const activeDay = hoverIndex !== null && hoverIndex >= 0 && hoverIndex < count ? daily[hoverIndex] : null;

  return (
    <div className={`${cardCls} p-4 flex flex-col justify-between`}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
        <SectionTitle>用量趋势走势</SectionTitle>
        <div className="flex flex-wrap items-center gap-2">
          {/* 指标切换 */}
          <div className="inline-flex rounded-lg border border-line bg-surface p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setMetric("tokens")}
              aria-pressed={metric === "tokens"}
              className={`rounded-md px-2.5 py-1 font-medium transition-colors ${
                metric === "tokens"
                  ? "bg-card text-primary shadow-xs"
                  : "text-muted hover:text-ink"
              }`}
            >
              Tokens 消耗
            </button>
            <button
              type="button"
              onClick={() => setMetric("calls")}
              aria-pressed={metric === "calls"}
              className={`rounded-md px-2.5 py-1 font-medium transition-colors ${
                metric === "calls"
                  ? "bg-card text-primary shadow-xs"
                  : "text-muted hover:text-ink"
              }`}
            >
              调用次数
            </button>
          </div>

          {/* 图表类型切换 */}
          <div className="inline-flex rounded-lg border border-line bg-surface p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setChartType("bar")}
              aria-pressed={chartType === "bar"}
              className={`rounded-md px-2.5 py-1 font-medium transition-colors ${
                chartType === "bar"
                  ? "bg-card text-primary shadow-xs"
                  : "text-muted hover:text-ink"
              }`}
            >
              柱状图
            </button>
            <button
              type="button"
              onClick={() => setChartType("area")}
              aria-pressed={chartType === "area"}
              className={`rounded-md px-2.5 py-1 font-medium transition-colors ${
                chartType === "area"
                  ? "bg-card text-primary shadow-xs"
                  : "text-muted hover:text-ink"
              }`}
            >
              平滑折线
            </button>
          </div>
        </div>
      </div>

      {/* SVG 画布区域 */}
      <div className="relative mt-4 w-full select-none" onMouseLeave={() => setHoverIndex(null)}>
        <svg
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          className="w-full h-auto overflow-visible"
          role="img"
          aria-label="每日用量趋势图"
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.32" />
              <stop offset="100%" stopColor="var(--primary)" stopOpacity="0.02" />
            </linearGradient>
          </defs>

          {/* Y 轴刻度横线与数字 (4 等分) */}
          {[0, 0.33, 0.66, 1].map((ratio) => {
            const y = PAD_TOP + (1 - ratio) * PLOT_HEIGHT;
            const tickVal = Math.round(maxVal * ratio);
            return (
              <g key={ratio}>
                <line
                  x1={PAD_LEFT}
                  y1={y}
                  x2={CHART_WIDTH - PAD_RIGHT}
                  y2={y}
                  stroke="currentColor"
                  strokeDasharray="4 4"
                  className="text-line"
                />
                <text
                  x={PAD_LEFT - 8}
                  y={y + 4}
                  textAnchor="end"
                  className="fill-muted font-mono text-[11px]"
                >
                  {compactNumber(tickVal)}
                </text>
              </g>
            );
          })}

          {/* 底部基线 */}
          <line
            x1={PAD_LEFT}
            y1={PAD_TOP + PLOT_HEIGHT}
            x2={CHART_WIDTH - PAD_RIGHT}
            y2={PAD_TOP + PLOT_HEIGHT}
            stroke="currentColor"
            className="text-line-strong"
          />

          {/* 无数据时的空状态提示文案 */}
          {totalVal === 0 && (
            <text
              x={PAD_LEFT + PLOT_WIDTH / 2}
              y={PAD_TOP + PLOT_HEIGHT / 2}
              textAnchor="middle"
              className="fill-faint font-serif text-xs"
            >
              所选时间区间内无调用数据
            </text>
          )}

          {/* 折线 / 面积模式 */}
          {chartType === "area" && totalVal > 0 && (
            <>
              <path d={areaPath} fill={`url(#${gradientId})`} />
              <path
                d={linePath}
                fill="none"
                stroke="var(--primary)"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {values.map((val, idx) => {
                const cx = calcX(idx, count);
                const cy = calcY(val, maxVal);
                const isHover = hoverIndex === idx;
                return (
                  <circle
                    key={idx}
                    cx={cx}
                    cy={cy}
                    r={isHover ? 5 : count <= 14 ? 3 : 2}
                    fill={isHover ? "var(--primary)" : "var(--card)"}
                    stroke="var(--primary)"
                    strokeWidth={isHover ? "2" : "1.5"}
                    className="transition-all"
                  />
                );
              })}
            </>
          )}

          {/* 柱状模式 */}
          {chartType === "bar" &&
            daily.map((_, idx) => {
              const val = values[idx] ?? 0;
              const slotX = PAD_LEFT + idx * barSlotWidth;
              const barX = slotX + (barSlotWidth - barWidth) / 2;
              const barY = calcY(val, maxVal);
              const barH = Math.max(PAD_TOP + PLOT_HEIGHT - barY, val > 0 ? 3 : 0);
              const isHover = hoverIndex === idx;

              return (
                <rect
                  key={idx}
                  x={barX}
                  y={barY}
                  width={barWidth}
                  height={barH}
                  rx={2}
                  fill={isHover ? "var(--primary-hover)" : "var(--primary)"}
                  opacity={isHover ? 1 : 0.88}
                  className="transition-all"
                />
              );
            })}

          {/* 交互热区与高亮指示 */}
          {daily.map((_, idx) => {
            const slotX = PAD_LEFT + idx * barSlotWidth;
            const isHover = hoverIndex === idx;
            return (
              <g key={idx}>
                {isHover && (
                  <rect
                    x={slotX}
                    y={PAD_TOP}
                    width={barSlotWidth}
                    height={PLOT_HEIGHT}
                    fill="var(--surface-2)"
                    opacity="0.35"
                    className="pointer-events-none"
                  />
                )}
                {/* 覆盖整个槽位的透明交互区域 */}
                <rect
                  x={slotX}
                  y={PAD_TOP}
                  width={barSlotWidth}
                  height={PLOT_HEIGHT + PAD_BOTTOM}
                  fill="transparent"
                  className="cursor-pointer"
                  onMouseEnter={() => setHoverIndex(idx)}
                />
              </g>
            );
          })}

          {/* X 轴日期标注 */}
          {daily.map((d, idx) => {
            const shouldShow =
              idx === 0 ||
              idx === count - 1 ||
              idx % dateStep === 0;

            if (!shouldShow) return null;
            const x = count === 1 ? PAD_LEFT + PLOT_WIDTH / 2 : PAD_LEFT + idx * barSlotWidth + barSlotWidth / 2;
            const isHover = hoverIndex === idx;

            return (
              <text
                key={idx}
                x={x}
                y={PAD_TOP + PLOT_HEIGHT + 18}
                textAnchor="middle"
                className={`font-mono text-[11px] select-none ${
                  isHover ? "fill-primary font-semibold" : "fill-muted"
                }`}
              >
                {formatDateLabel(d.date)}
              </text>
            );
          })}
        </svg>

        {/* 鼠标悬停详细 Tooltip 浮层 */}
        {activeDay && hoverIndex !== null && (
          <div
            className="absolute z-20 pointer-events-none rounded-lg border border-line bg-card/95 backdrop-blur-xs p-3 shadow-card-float text-xs"
            style={{
              top: "10px",
              left: `${Math.min(Math.max(12, ((hoverIndex + 0.5) / count) * 100), 75)}%`,
              transform: "translateX(-50%)",
            }}
          >
            <div className="font-mono font-medium text-ink border-b border-line pb-1.5 mb-1.5 flex items-center justify-between gap-4">
              <span>{activeDay.date}</span>
              <span className="text-primary font-semibold">
                {metric === "tokens"
                  ? `${(activeDay.inputTokens + activeDay.outputTokens).toLocaleString("zh-CN")} tokens`
                  : `${activeDay.calls} 次调用`}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[11px]">
              <span className="text-muted">成功调用:</span>
              <span className="text-right text-ink">{activeDay.calls} 次</span>
              {activeDay.failed > 0 && (
                <>
                  <span className="text-danger">失败/中断:</span>
                  <span className="text-right text-danger font-semibold">{activeDay.failed} 次</span>
                </>
              )}
              <span className="text-muted">输入 tokens:</span>
              <span className="text-right text-ink">{activeDay.inputTokens.toLocaleString("zh-CN")}</span>
              <span className="text-muted">输出 tokens:</span>
              <span className="text-right text-ink">{activeDay.outputTokens.toLocaleString("zh-CN")}</span>
              <span className="text-muted">缓存命中:</span>
              <span className="text-right text-ink">{activeDay.cachedTokens.toLocaleString("zh-CN")}</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function LlmDistributionChart({
  byFeature,
  byModel,
}: {
  byFeature: LlmFeatureUsage[];
  byModel: LlmModelUsage[];
}) {
  const [dimension, setDimension] = useState<"feature" | "model">("feature");

  const currentList = dimension === "feature" ? byFeature : byModel;
  const totalTokens = useMemo(
    () => currentList.reduce((sum, item) => sum + item.tokens, 0),
    [currentList]
  );
  const maxTokens = useMemo(
    () => Math.max(...currentList.map((item) => item.tokens), 0),
    [currentList]
  );

  return (
    <div className={`${cardCls} p-4 flex flex-col justify-between`}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
        <SectionTitle>用量分布结构</SectionTitle>
        <div className="inline-flex rounded-lg border border-line bg-surface p-0.5 text-xs">
          <button
            type="button"
            onClick={() => setDimension("feature")}
            aria-pressed={dimension === "feature"}
            className={`rounded-md px-2.5 py-1 font-medium transition-colors ${
              dimension === "feature"
                ? "bg-card text-primary shadow-xs"
                : "text-muted hover:text-ink"
            }`}
          >
            功能来源
          </button>
          <button
            type="button"
            onClick={() => setDimension("model")}
            aria-pressed={dimension === "model"}
            className={`rounded-md px-2.5 py-1 font-medium transition-colors ${
              dimension === "model"
                ? "bg-card text-primary shadow-xs"
                : "text-muted hover:text-ink"
            }`}
          >
            模型规格
          </button>
        </div>
      </div>

      <div className="mt-4 flex-1 space-y-3.5">
        {currentList.length === 0 ? (
          <div className="h-44 flex items-center justify-center text-xs text-faint font-serif">
            暂无分布统计记录
          </div>
        ) : (
          currentList.slice(0, 8).map((item, index) => {
            const name = "feature" in item ? item.feature : item.model;
            const percent = totalTokens > 0 ? ((item.tokens / totalTokens) * 100).toFixed(1) : "0.0";
            const barWidthPercent = maxTokens > 0 ? Math.max((item.tokens / maxTokens) * 100, 2) : 0;

            return (
              <div key={name || index} className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium text-ink truncate max-w-[55%]" title={name}>
                    {name || "未知"}
                  </span>
                  <div className="flex items-center gap-2 font-mono tabular-nums">
                    <span className="text-muted text-[11px]">{item.calls} 次</span>
                    <span className="font-medium text-ink">{item.tokens.toLocaleString("zh-CN")}</span>
                    <span className="w-12 text-right text-muted text-[11px] font-semibold">{percent}%</span>
                  </div>
                </div>
                {/* 占比条形轨道 */}
                <div className="h-2 w-full rounded-full bg-surface-2 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-300 ${
                      index === 0 ? "bg-primary" : "bg-primary/75"
                    }`}
                    style={{ width: `${barWidthPercent}%` }}
                  />
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
