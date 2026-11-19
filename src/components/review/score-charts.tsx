"use client";

import { useEffect, useId, useRef, useState } from "react";
import { DIMENSIONS, overallOf, type ScoreMap } from "@/lib/scores";
import { btnGhost } from "@/lib/ui";
import type { ReviewSessionPoint } from "@/lib/review-dashboard";
export type { ReviewSessionPoint } from "@/lib/review-dashboard";

export const DIM_COLORS: Record<keyof ScoreMap, string> = {
  depth: "var(--primary)", structure: "var(--accent)",
  authenticity: "var(--ink)", completeness: "var(--danger)",
};
const PAGE_SIZE = 20;
const kindLabel = (kind: ReviewSessionPoint["kind"]) => kind === "drill" ? "练习" : "面试";
function sessionDate(value: string): string {
  if (!value) return "未记录时间";
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/** 图表使用实际容器宽度作为坐标宽度，字号不随窄屏整体缩小。 */
function useChartWidth(enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => {
    const container = ref.current;
    if (!enabled || !container || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(entries => {
      const next = entries[0]?.contentRect.width;
      if (next && Number.isFinite(next)) setWidth(next);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [enabled]);
  return { ref, width };
}

/** 每页保留完整场次，不抽样丢弃历史；图表与可键盘操作的明细共用相同窗口。 */
export function TrendChart({ sessions }: { sessions: ReviewSessionPoint[] }) {
  const { ref, width: W } = useChartWidth(sessions.length > 0);
  const descriptionId = useId();
  const [requestedPage, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(sessions.length / PAGE_SIZE));
  const page = Math.min(requestedPage, pages - 1);
  const end = sessions.length - page * PAGE_SIZE;
  const start = Math.max(0, end - PAGE_SIZE);
  const visible = sessions.slice(start, end);
  const H = 280, padL = 32, padR = 24, padT = 18, padB = 36;
  const plotW = Math.max(1, W - padL - padR), plotH = H - padT - padB;
  const x = (i: number) => padL + (visible.length <= 1 ? plotW / 2 : i * plotW / (visible.length - 1));
  const y = (value: number) => padT + (1 - value / 10) * plotH;
  const labelCount = Math.min(visible.length, Math.max(2, Math.floor(plotW / 64)));
  const labels = new Set(Array.from({ length: labelCount }, (_, i) => labelCount <= 1 ? 0 : Math.round(i * (visible.length - 1) / (labelCount - 1))));
  if (!sessions.length) return <p className="py-8 text-center text-sm text-muted">暂无场次数据</p>;

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p role="status" className="text-sm text-muted">第 {start + 1}–{end} 场 / 共 {sessions.length} 场</p>
        {pages > 1 && <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={btnGhost} disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>更早场次</button>
          <label className="flex items-center gap-2 text-xs text-muted">
            <span>场次范围</span>
            <select aria-label="选择场次范围" className="max-w-full rounded-lg border border-line bg-card px-2 py-2 text-sm text-ink" value={page} onChange={event => setPage(Number(event.target.value))}>
              {Array.from({ length: pages }, (_, index) => {
                const last = sessions.length - index * PAGE_SIZE;
                return <option key={index} value={index}>第 {Math.max(1, last - PAGE_SIZE + 1)}–{last} 场</option>;
              })}
            </select>
          </label>
          <button type="button" className={btnGhost} disabled={page === 0} onClick={() => setPage(page - 1)}>较新场次</button>
        </div>}
      </div>
      <p id={descriptionId} className="text-xs leading-relaxed text-muted">横轴按最近作答时间排列场次序号；完整时间和分数见下方明细。切换场次不改变总览统计。</p>
      <div ref={ref} className="w-full min-w-0">
        <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="四维评分趋势折线图" aria-describedby={descriptionId}>
          {[0, 2, 4, 6, 8, 10].map(value => <g key={value}>
            <line x1={padL} x2={W - padR} y1={y(value)} y2={y(value)} stroke="var(--line)" />
            <text x={padL - 6} y={y(value) + 4} textAnchor="end" fontSize={12} fill="var(--muted)" className="font-mono">{value}</text>
          </g>)}
          {visible.map((session, i) => labels.has(i) ? <text key={session.id} x={x(i)} y={H - 12} textAnchor="middle" fontSize={12} fill="var(--muted)" className="font-mono">{start + i + 1}</text> : null)}
          {DIMENSIONS.map(dimension => <g key={dimension.key}>
            {visible.length > 1 && <polyline points={visible.map((session, i) => `${x(i)},${y(session.avg[dimension.key])}`).join(" ")} fill="none" stroke={DIM_COLORS[dimension.key]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
            {visible.map((session, i) => {
              const title = `${dimension.label} ${session.avg[dimension.key].toFixed(1)} 分 · 第 ${start + i + 1} 场 ${kindLabel(session.kind)}「${session.label}」· ${sessionDate(session.date)}`;
              return session.kind === "drill"
                ? <circle key={session.id} cx={x(i)} cy={y(session.avg[dimension.key])} r={3.5} fill={DIM_COLORS[dimension.key]}><title>{title}</title></circle>
                : <rect key={session.id} x={x(i) - 3.5} y={y(session.avg[dimension.key]) - 3.5} width={7} height={7} rx={1} fill={DIM_COLORS[dimension.key]}><title>{title}</title></rect>;
            })}
          </g>)}
        </svg>
      </div>
      <details className="rounded-xl border border-line bg-surface/30 p-3 sm:p-4">
        <summary className="cursor-pointer text-sm font-medium text-primary focus-visible:outline-2 focus-visible:outline-primary">查看本页场次明细</summary>
        <ol aria-label="本页场次明细" className="mt-4 space-y-4">
          {visible.map((session, index) => <li key={session.id} className="min-w-0 rounded-lg border border-line bg-card p-3 text-sm">
            <p className="font-medium text-ink">第 {start + index + 1} 场 · {kindLabel(session.kind)}</p>
            <p className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{session.label}</p>
            <p className="mt-1 whitespace-pre-wrap text-xs text-muted [overflow-wrap:anywhere]">{sessionDate(session.date)} · {session.count} 题已评分 · 综合 {session.overall.toFixed(1)} 分</p>
            <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {DIMENSIONS.map(dimension => <div key={dimension.key}>
                <dt className="text-xs text-muted">{dimension.label}</dt>
                <dd className="mt-1 font-mono text-base text-ink">{session.avg[dimension.key].toFixed(1)}</dd>
              </div>)}
            </dl>
          </li>)}
        </ol>
      </details>
    </div>
  );
}

/** 图形提供概览，表格提供不依赖颜色或悬停的精确数值。 */
export function RadarChart({ series }: { series: { label: string; avg: ScoreMap | null; color: string }[] }) {
  const W = 320, H = 276, cx = W / 2, cy = 138, R = 84;
  const axes = DIMENSIONS.map((d, i) => ({ d, angle: -Math.PI / 2 + i * Math.PI / 2 }));
  const pt = (i: number, value: number): [number, number] => {
    const angle = axes[i]!.angle;
    return [cx + Math.cos(angle) * R * value / 10, cy + Math.sin(angle) * R * value / 10];
  };
  const ring = (value: number) => axes.map((_, i) => pt(i, value).join(",")).join(" ");
  return (
    <div className="w-full min-w-0 max-w-sm">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="练习与面试的四维雷达对比图">
        {[2.5, 5, 7.5, 10].map(value => <polygon key={value} points={ring(value)} fill="none" stroke={value === 10 ? "var(--line-strong)" : "var(--line)"} />)}
        {axes.map((axis, i) => {
          const [x, y] = pt(i, 10);
          return <line key={axis.d.key} x1={cx} y1={cy} x2={x} y2={y} stroke="var(--line)" />;
        })}
        {[5, 10].map(value => <text key={value} x={cx + 6} y={cy - R * value / 10 + 13} fontSize={16} fill="var(--muted)" className="font-mono">{value}</text>)}
        {series.map(item => !item.avg ? null : <g key={item.label}>
          <polygon points={axes.map((axis, i) => pt(i, item.avg![axis.d.key]).join(",")).join(" ")} fill={item.color} fillOpacity={0.18} stroke={item.color} strokeWidth={2} />
          {axes.map((axis, i) => { const [x, y] = pt(i, item.avg![axis.d.key]); return <circle key={axis.d.key} cx={x} cy={y} r={3} fill={item.color} />; })}
        </g>)}
        {axes.map(axis => <text key={axis.d.key} x={cx + Math.cos(axis.angle) * (R + 18)} y={cy + Math.sin(axis.angle) * (R + 18) + 5} textAnchor="middle" fontSize={16} fill="var(--ink)" className="font-serif font-bold">{axis.d.label}</text>)}
      </svg>
      <div className="mt-2 flex flex-wrap justify-center gap-4 text-sm">
        {series.map(item => <div key={item.label} className="flex items-center gap-2">
          <span aria-hidden className="h-2.5 w-2.5 rounded-xs" style={{ background: item.color }} />
          <span>{item.label}</span><span className="font-mono text-muted">{item.avg ? `(均 ${overallOf(item.avg).toFixed(1)})` : "(暂无)"}</span>
        </div>)}
      </div>
      <table className="mt-4 w-full table-fixed text-sm">
        <caption className="pb-2 text-left text-sm font-medium">四维均分对比</caption>
        <thead><tr><th scope="col" className="py-2 text-left">维度</th>{series.map(item => <th scope="col" key={item.label} className="py-2 text-center">{item.label}</th>)}</tr></thead>
        <tbody>{DIMENSIONS.map(dimension => <tr key={dimension.key} className="border-t border-line">
          <th scope="row" className="py-2 text-left font-normal">{dimension.label}</th>
          {series.map(item => <td key={item.label} className="py-2 text-center font-mono">{item.avg ? item.avg[dimension.key].toFixed(1) : "暂无评分"}</td>)}
        </tr>)}</tbody>
      </table>
    </div>
  );
}
