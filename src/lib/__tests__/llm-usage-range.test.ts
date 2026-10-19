import { describe, expect, it } from "vitest";
import { resolveUsageRange } from "../llm-usage-range";

/** 本地时区的中午，避免跨时区跑测试时踩到日界 */
const NOW = new Date(2026, 8, 19, 12, 0, 0);

describe("resolveUsageRange", () => {
  it("本月 = 本地当月 1 日 00:00 到下月 1 日 00:00", () => {
    expect(resolveUsageRange("month", NOW)).toEqual({
      from: new Date(2026, 8, 1).toISOString(),
      to: new Date(2026, 9, 1).toISOString(),
    });
  });

  it("近 7 天含今天共 7 个自然日", () => {
    expect(resolveUsageRange("7d", NOW)).toEqual({
      from: new Date(2026, 8, 13).toISOString(),
      to: new Date(2026, 8, 20).toISOString(),
    });
  });

  it("近 30 天含今天共 30 个自然日", () => {
    expect(resolveUsageRange("30d", NOW)).toEqual({
      from: new Date(2026, 7, 21).toISOString(),
      to: new Date(2026, 8, 20).toISOString(),
    });
  });

  it("全部 = 不限", () => {
    expect(resolveUsageRange("all", NOW)).toEqual({ from: null, to: null });
  });

  it("自定义：止日含当天，即次日本地 00:00", () => {
    expect(resolveUsageRange("custom", NOW, { from: "2026-09-01", to: "2026-09-10" })).toEqual({
      from: new Date(2026, 8, 1).toISOString(),
      to: new Date(2026, 8, 11).toISOString(),
    });
  });

  it("跨月与跨年边界正确", () => {
    expect(resolveUsageRange("month", new Date(2026, 0, 15))).toEqual({
      from: new Date(2026, 0, 1).toISOString(),
      to: new Date(2026, 1, 1).toISOString(),
    });
    expect(resolveUsageRange("7d", new Date(2026, 0, 3))).toEqual({
      from: new Date(2025, 11, 28).toISOString(),
      to: new Date(2026, 0, 4).toISOString(),
    });
  });

  it("自定义起止为同一天时是合法的单日区间", () => {
    expect(resolveUsageRange("custom", NOW, { from: "2026-09-10", to: "2026-09-10" })).toEqual({
      from: new Date(2026, 8, 10).toISOString(),
      to: new Date(2026, 8, 11).toISOString(),
    });
  });

  it("自定义起止颠倒或格式非法时抛出", () => {
    // 止日早于起日：进位后 from >= to
    expect(() => resolveUsageRange("custom", NOW, { from: "2026-09-10", to: "2026-09-09" })).toThrow();
    expect(() => resolveUsageRange("custom", NOW, { from: "2026-09-10", to: "2026-09-01" })).toThrow();
    expect(() => resolveUsageRange("custom", NOW, { from: "09/01/2026", to: "2026-09-10" })).toThrow();
    // 月份越界与不存在的日期都必须拒绝，不能被 Date 静默进位
    expect(() => resolveUsageRange("custom", NOW, { from: "2026-13-01", to: "2026-09-10" })).toThrow();
    expect(() => resolveUsageRange("custom", NOW, { from: "2026-02-31", to: "2026-09-10" })).toThrow();
  });
});
