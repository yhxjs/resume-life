export const PORTFOLIO_TEMPLATES = [
  { id: "flow", name: "流光", description: "流动线网 · 舒展时间线" },
  { id: "focus", name: "聚焦名片", description: "居中首屏 · 环形线场" },
  { id: "chronicle", name: "履历长卷", description: "章节编号 · 紧凑履历" },
  { id: "sidebar", name: "侧栏履历", description: "固定导航 · 纵向线场" },
] as const;

export type PortfolioTemplateId = typeof PORTFOLIO_TEMPLATES[number]["id"];

export function isPortfolioTemplate(value: unknown): value is PortfolioTemplateId {
  return PORTFOLIO_TEMPLATES.some((template) => template.id === value);
}
