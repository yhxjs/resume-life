/** 跨页面复用的界面小件（见 DESIGN.md） */
import { btnGhost } from "@/lib/ui";

export function LoadError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-danger/30 bg-danger-wash p-4 text-sm text-danger">
      <p className="min-w-0 flex-1 [overflow-wrap:anywhere]">{message}</p>
      {onRetry && <button type="button" className={btnGhost} onClick={onRetry}>重试加载</button>}
    </div>
  );
}

export function PageHeader({
  title,
  desc,
  actions,
}: {
  title: string;
  desc?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
      <div>
        <h1 className="font-serif text-[26px] font-bold leading-tight sm:text-[30px]">{title}</h1>
        {desc && <p className="mt-1.5 max-w-prose text-sm text-muted leading-relaxed">{desc}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/** 章节标题：宋体 + 橄榄方块标记（全站统一签名） */
export function SectionTitle({
  children,
  right,
  count,
}: {
  children: React.ReactNode;
  right?: React.ReactNode;
  count?: number;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="flex items-center gap-2 font-serif text-[15px] font-bold text-ink">
        <span aria-hidden className="h-[9px] w-[9px] rounded-[1px] bg-primary" />
        <span>{children}</span>
        {typeof count === "number" && (
          <span className="font-mono text-xs font-normal text-muted">({count})</span>
        )}
      </h2>
      {right && <div className="flex items-center gap-2 text-xs">{right}</div>}
    </div>
  );
}

export function Loading({ label = "加载中…" }: { label?: string }) {
  return (
    <div className="mt-6 w-full space-y-3" role="status" aria-label={label}>
      <div className="skeleton h-7 w-48 max-w-full rounded-lg" />
      <div className="skeleton h-4 w-80 max-w-full rounded-md" />
      <div className="skeleton h-4 w-64 max-w-full rounded-md" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

/** 结构化空状态：带有印章与指引行动 */
export function Empty({
  children,
  action,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="mt-6 rounded-2xl border border-dashed border-line-strong bg-surface/40 px-6 py-12 text-center text-sm text-muted">
      <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-surface-2 text-primary font-serif font-bold text-lg shadow-xs">
        弈
      </div>
      <div className="max-w-md mx-auto leading-relaxed">{children}</div>
      {action && <div className="mt-4 flex justify-center gap-2">{action}</div>}
    </div>
  );
}

/** 数字档案感统计卡（复盘、指标、概览通用） */
export function StatTile({
  label,
  value,
  hint,
  highlight = false,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  highlight?: boolean;
}) {
  return (
    <div className="rounded-xl border border-line bg-card p-4 shadow-card-subtle space-y-1">
      <span className="text-xs text-muted block">{label}</span>
      <div
        className={`font-mono text-2xl font-bold tabular-nums ${
          highlight ? "text-primary" : "text-ink"
        }`}
      >
        {value}
      </div>
      {hint && <span className="text-[11px] text-faint block">{hint}</span>}
    </div>
  );
}

