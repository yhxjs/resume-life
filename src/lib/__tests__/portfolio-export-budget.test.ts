import { describe, expect, it } from "vitest";
import {
  MAX_PORTFOLIO_SOURCE_BYTES, MAX_PORTFOLIO_EXPANDED_BYTES,
  assertPortfolioSourceBytes, assertPortfolioExpandedBytes,
} from "../portfolio-export-budget";

describe("作品集导出字节边界", () => {
  it.each([
    ["来源", MAX_PORTFOLIO_SOURCE_BYTES, assertPortfolioSourceBytes],
    ["生成文件", MAX_PORTFOLIO_EXPANDED_BYTES, assertPortfolioExpandedBytes],
  ])("%s 允许恰好上限，超过一字节返回 413", (_label, limit, assertBudget) => {
    expect(() => assertBudget(limit)).not.toThrow();
    expect(() => assertBudget(limit + 1)).toThrow(expect.objectContaining({ status: 413 }));
  });
});
