import { describe, expect, it } from "vitest";
import {
  A4_HEIGHT_PX,
  calculateAutoFitOverrides,
  estimatePageFitStatus,
} from "../resume-compression";
import { DEFAULT_STYLE } from "../template-styles";

describe("resume compression algorithm", () => {
  it("detects single-page status correctly when within A4 height", () => {
    const status = estimatePageFitStatus(1000, A4_HEIGHT_PX);
    expect(status.isSinglePage).toBe(true);
    expect(status.overflowPx).toBe(0);
    expect(status.overflowLines).toBe(0);
    expect(status.heightPercent).toBe(89);

    const fitOverrides = calculateAutoFitOverrides(DEFAULT_STYLE, 1000, A4_HEIGHT_PX);
    expect(fitOverrides).toEqual({});
  });

  it("calculates overflow lines and pixel delta accurately when overflowing", () => {
    // 假设超出 45px（约 2 行）
    const status = estimatePageFitStatus(A4_HEIGHT_PX + 45, A4_HEIGHT_PX, {
      baseSize: 12,
      lineHeight: 1.55,
      descItemGap: 2,
    });
    expect(status.isSinglePage).toBe(false);
    expect(status.overflowPx).toBe(45);
    expect(status.overflowLines).toBe(3); // 45 / (12 * 1.55 + 2) ≈ 45 / 20.6 ≈ 2.18 -> 3 行
    expect(status.heightPercent).toBe(104);
  });

  it("applies Tier 1 gap compression for modest overflow (2-3 lines)", () => {
    const overflowHeight = A4_HEIGHT_PX + 50; // 溢出约 4.4%
    const overrides = calculateAutoFitOverrides(DEFAULT_STYLE, overflowHeight, A4_HEIGHT_PX);

    // 应该收紧间距
    expect(overrides.sectionGapBefore).toBeLessThan(DEFAULT_STYLE.sectionGapBefore);
    expect(overrides.sectionGapAfter).toBeLessThan(DEFAULT_STYLE.sectionGapAfter);
    expect(overrides.entryGap).toBeLessThan(DEFAULT_STYLE.entryGap);
    expect(overrides.pageMargin).toBeLessThanOrEqual(DEFAULT_STYLE.pageMargin);

    // 确保没有跌破安全边界保底值
    expect(overrides.sectionGapBefore).toBeGreaterThanOrEqual(6);
    expect(overrides.sectionGapAfter).toBeGreaterThanOrEqual(3);
    expect(overrides.entryGap).toBeGreaterThanOrEqual(5);
    expect(overrides.pageMargin).toBeGreaterThanOrEqual(10);
  });

  it("applies Tier 2 and Tier 3 when severely overflowing (> 10%)", () => {
    const hugeOverflowHeight = A4_HEIGHT_PX + 180; // 溢出约 16%
    const overrides = calculateAutoFitOverrides(DEFAULT_STYLE, hugeOverflowHeight, A4_HEIGHT_PX);

    // 触发了行高与字号收紧
    expect(overrides.lineHeight).toBeDefined();
    expect(overrides.lineHeight!).toBeLessThan(DEFAULT_STYLE.lineHeight);
    expect(overrides.lineHeight!).toBeGreaterThanOrEqual(1.42);

    expect(overrides.baseSize).toBeDefined();
    expect(overrides.baseSize!).toBeLessThan(DEFAULT_STYLE.baseSize);
    expect(overrides.baseSize!).toBeGreaterThanOrEqual(11.0);
  });
});
