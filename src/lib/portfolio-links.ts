export const PORTFOLIO_LINK_LABELS = {
  demoUrl: "演示外链",
  repoUrl: "代码仓库",
  docUrl: "架构设计文档",
} as const;

/** 空白表示未填写；只允许可公开导航的绝对 HTTP/HTTPS 地址。 */
export function normalizePortfolioLink(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/[\u0000-\u001f\u007f]/.test(trimmed) || !/^https?:\/\//i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? trimmed : null;
  } catch {
    return null;
  }
}
