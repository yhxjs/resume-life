import { describe, expect, it } from "vitest";
import {
  A4_BASE_WIDTH,
  MIN_SCALE,
  MAX_SCALE,
  ZOOM_PRESETS,
  calcFitWidthScale,
  getNextZoomIn,
  getNextZoomOut,
  calcWheelZoom,
  formatZoomPercent,
} from "../zoom";

describe("zoom utilities and presets", () => {
  it("defines correct base constants", () => {
    expect(A4_BASE_WIDTH).toBe(794);
    expect(MIN_SCALE).toBe(0.3);
    expect(MAX_SCALE).toBe(2.0);
    expect(ZOOM_PRESETS).toEqual([0.5, 0.75, 1.0, 1.25, 1.5]);
  });

  describe("calcFitWidthScale", () => {
    it("handles invalid or zero width gracefully", () => {
      expect(calcFitWidthScale(0)).toBe(1);
      expect(calcFitWidthScale(-100)).toBe(1);
    });

    it("calculates proportional scale correctly with default padding", () => {
      // (826 - 32) / 794 = 794 / 794 = 1.0
      expect(calcFitWidthScale(826, 32)).toBe(1.0);
      // (429 - 32) / 794 = 397 / 794 = 0.5
      expect(calcFitWidthScale(429, 32)).toBe(0.5);
    });

    it("clamps result within [MIN_SCALE, MAX_SCALE]", () => {
      // 极窄容器
      expect(calcFitWidthScale(50, 32)).toBe(MIN_SCALE);
      // 极宽容器
      expect(calcFitWidthScale(5000, 32)).toBe(MAX_SCALE);
    });

    it("floors scale to prevent horizontal micro-overflow and jitter loop", () => {
      // 容器宽度 600px, padding 32px -> available 568px
      // 568 / 794 = 0.71536... 若向上取整为 0.72 会产生 794 * 0.72 = 571.68px > 568px 导致微溢出
      // 向下取整为 0.71，保证实际渲染宽度不超过可用宽度
      const scale = calcFitWidthScale(600, 32);
      expect(scale).toBe(0.71);
      expect(Math.round(A4_BASE_WIDTH * scale)).toBeLessThanOrEqual(600 - 32);
    });
  });

  describe("getNextZoomIn", () => {
    it("jumps to next preset if on or below preset threshold", () => {
      expect(getNextZoomIn(0.5)).toBe(0.75);
      expect(getNextZoomIn(0.75)).toBe(1.0);
      expect(getNextZoomIn(1.0)).toBe(1.25);
      expect(getNextZoomIn(1.25)).toBe(1.5);
    });

    it("jumps to closest higher preset from arbitrary ratio", () => {
      expect(getNextZoomIn(0.68)).toBe(0.75);
      expect(getNextZoomIn(0.82)).toBe(1.0);
      expect(getNextZoomIn(1.1)).toBe(1.25);
    });

    it("steps by +0.25 when above highest preset", () => {
      expect(getNextZoomIn(1.5)).toBe(1.75);
      expect(getNextZoomIn(1.75)).toBe(2.0);
      expect(getNextZoomIn(2.0)).toBe(MAX_SCALE);
    });
  });

  describe("getNextZoomOut", () => {
    it("jumps to previous preset if on a preset threshold", () => {
      expect(getNextZoomOut(1.5)).toBe(1.25);
      expect(getNextZoomOut(1.25)).toBe(1.0);
      expect(getNextZoomOut(1.0)).toBe(0.75);
      expect(getNextZoomOut(0.75)).toBe(0.5);
    });

    it("jumps to closest lower preset from arbitrary ratio", () => {
      expect(getNextZoomOut(0.68)).toBe(0.5);
      expect(getNextZoomOut(0.95)).toBe(0.75);
      expect(getNextZoomOut(1.4)).toBe(1.25);
    });

    it("steps by -0.25 when at or below lowest preset until min bound", () => {
      expect(getNextZoomOut(0.5)).toBe(0.3);
      expect(getNextZoomOut(0.3)).toBe(MIN_SCALE);
    });
  });

  describe("calcWheelZoom", () => {
    it("zooms in linearly when deltaY is negative (wheel up)", () => {
      const zoomed = calcWheelZoom(1.0, -100);
      expect(zoomed).toBe(1.05); // 线性增加 0.05 (5%)
      // 验证无论起始比例大小，线性增量恒定
      const zoomedFromLow = calcWheelZoom(0.5, -100);
      expect(zoomedFromLow).toBe(0.55);
      const zoomedFromHigh = calcWheelZoom(1.5, -100);
      expect(zoomedFromHigh).toBe(1.55);
    });

    it("zooms out linearly when deltaY is positive (wheel down)", () => {
      const zoomed = calcWheelZoom(1.0, 100);
      expect(zoomed).toBe(0.95); // 线性减少 0.05 (5%)
      const zoomedFromLow = calcWheelZoom(0.5, 100);
      expect(zoomedFromLow).toBe(0.45);
    });

    it("clamps strictly at MIN_SCALE and MAX_SCALE bounds", () => {
      // 强行滚出大值
      expect(calcWheelZoom(1.9, -5000)).toBe(MAX_SCALE);
      // 强行滚出小值
      expect(calcWheelZoom(0.4, 5000)).toBe(MIN_SCALE);
    });
  });

  describe("formatZoomPercent", () => {
    it("formats scales as rounded percentages", () => {
      expect(formatZoomPercent(1.0)).toBe("100%");
      expect(formatZoomPercent(0.75)).toBe("75%");
      expect(formatZoomPercent(0.666)).toBe("67%");
      expect(formatZoomPercent(1.25)).toBe("125%");
    });
  });
});
