/** 个人静态作品集的固定预算，分别约束来源、HTML 展开和压缩输入。 */
export const MAX_PORTFOLIO_PROJECTS = 50;
export const MAX_PORTFOLIO_SOURCE_BYTES = 4 * 1024 * 1024;
export const MAX_PORTFOLIO_EXPANDED_BYTES = 16 * 1024 * 1024;

export class PortfolioError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "PortfolioError";
  }
}

export function assertPortfolioSourceBytes(bytes: number): void {
  if (bytes > MAX_PORTFOLIO_SOURCE_BYTES) {
    throw new PortfolioError("作品集来源文本过大（上限 4 MiB），请减少项目或精简正文", 413);
  }
}

export function assertPortfolioExpandedBytes(bytes: number): void {
  if (bytes > MAX_PORTFOLIO_EXPANDED_BYTES) {
    throw new PortfolioError("作品集生成文件过大（上限 16 MiB），请减少项目或精简正文", 413);
  }
}
