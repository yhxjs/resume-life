/** 全站共享组件词汇（见 DESIGN.md）。只允许语义令牌色，禁止字面色值。 */

const fieldCls =
  "w-full rounded-lg border border-line bg-card px-3 py-2.5 sm:py-2 text-base sm:text-sm text-ink outline-none transition-[border-color,box-shadow] placeholder:text-faint focus:border-primary focus:ring-4 focus:ring-primary/10 disabled:cursor-not-allowed disabled:opacity-60";

export const inputCls = `${fieldCls} min-h-[40px] sm:min-h-[38px]`;

/** 多行输入：短写 / 常规 / 主写作三档最小高度 */
export const textareaShortCls = `${fieldCls} min-h-32 leading-relaxed`;
export const textareaCls = `${fieldCls} min-h-40 leading-relaxed`;
export const textareaTallCls = `${fieldCls} min-h-48 leading-relaxed`;

export const labelCls = "text-xs font-medium text-muted";

export const btnPrimary =
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-primary px-4 py-2.5 sm:py-2 text-sm font-medium min-h-[40px] sm:min-h-[36px] text-on-primary transition-colors hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary cursor-pointer disabled:cursor-not-allowed disabled:opacity-50";

export const btnGhost =
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-line-strong bg-bg px-3.5 py-2.5 sm:py-2 text-sm font-medium min-h-[40px] sm:min-h-[36px] text-ink transition-colors hover:bg-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary cursor-pointer disabled:cursor-not-allowed disabled:opacity-50";

export const btnDanger =
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg border border-danger/30 bg-bg px-3.5 py-2.5 sm:py-2 text-sm font-medium min-h-[40px] sm:min-h-[36px] text-danger transition-colors hover:bg-danger-wash focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger cursor-pointer disabled:cursor-not-allowed disabled:opacity-50";

export const btnDangerSolid =
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg bg-danger px-4 py-2.5 sm:py-2 text-sm font-medium min-h-[40px] sm:min-h-[36px] text-on-danger transition-colors hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger cursor-pointer disabled:cursor-not-allowed disabled:opacity-50";

export const cardCls = "rounded-xl border border-line bg-card shadow-card-subtle";

/** 浮层对话框容器：纯白/暗面立面，消除在遮罩上的暗淡感，小屏适度收窄内边距 */
export const dialogCardCls =
  "dialog-in w-full rounded-2xl border border-line bg-card p-4 sm:p-6 shadow-card-float";

/** 遮罩层：统一使用语义遮罩，支持安全区和边距适配 */
export const modalOverlayCls =
  "overlay-in fixed inset-0 z-50 flex items-center justify-center bg-overlay p-2.5 sm:p-4 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur-[2px]";

/** 内嵌井容器：适用于代码块、引用原文、折叠详情 */
export const wellCls = "rounded-lg border border-line/70 bg-surface-2 p-3.5";

export const badgeCls =
  "inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2.5 py-0.5 text-xs text-muted font-medium";

/** 语义彩色小徽章 */
export const badgePrimary =
  "inline-flex items-center gap-1 rounded-full border border-primary/25 bg-primary-soft px-2.5 py-0.5 text-xs text-primary font-medium";

export const badgeAccent =
  "inline-flex items-center gap-1 rounded-full border border-accent/25 bg-accent-wash px-2.5 py-0.5 text-xs text-accent font-medium";

export const badgeDanger =
  "inline-flex items-center gap-1 rounded-full border border-danger/25 bg-danger-wash px-2.5 py-0.5 text-xs text-danger font-medium";

/** 状态文本色（保存反馈、连接结果等） */
export const textOk = "text-primary";
export const textWarn = "text-accent";
export const textErr = "text-danger";
export const textInfo = "text-muted";

/** 评分配色：≥7 主色 / ≥4 琥珀 / 其余红 */
export function scoreTextCls(v: number): string {
  return v >= 7 ? textOk : v >= 4 ? textWarn : textErr;
}

/** 行内列表行：divide-y 容器 + 行悬停 */
export const rowHover =
  "-mx-3 flex items-center justify-between gap-4 rounded-lg px-3 py-3 transition-colors hover:bg-surface";
