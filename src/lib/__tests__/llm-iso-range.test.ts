import { describe, expect, it } from "vitest";
import { parseIsoRange } from "../llm-call-log";

describe("parseIsoRange 的日历边界", () => {
  it.each(["2026-02-31T00:00:00.000Z", "2026-02-29T00:00:00.000Z"])("拒绝不存在的日期 %s", (value) => {
    expect(() => parseIsoRange(new URLSearchParams({ from: value }))).toThrow();
  });

  it("接受闰年合法日期并保留左闭右开区间", () => {
    expect(parseIsoRange(new URLSearchParams({ from: "2028-02-29T00:00:00.000Z", to: "2028-03-01T00:00:00.000Z" })))
      .toEqual({ from: "2028-02-29T00:00:00.000Z", to: "2028-03-01T00:00:00.000Z" });
  });
});
