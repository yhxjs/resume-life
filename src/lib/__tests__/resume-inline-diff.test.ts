import { describe, expect, it } from "vitest";
import { changedTextRanges } from "../resume-inline-diff";

function fragments(text: string, ranges: { start: number; end: number }[]) {
  return ranges.map(({ start, end }) => text.slice(start, end));
}

describe("完整简历中的文字差异", () => {
  it("只标记长条目里变动的数字与词，保留中间未改的内容", () => {
    const before = "客服系统 核心开发•完成接口设计，响应时间 20%；持续交付。•保障代码质量与交付规范，完成文档整改。";
    const after = "客服系统 核心开发•完成接口设计，响应时间 40%；持续交付。•保障代码质量与交付规范，完成文档整理。";
    const result = changedTextRanges(before, after);
    expect(fragments(before, result.before)).toEqual(["20", "改"]);
    expect(fragments(after, result.after)).toEqual(["40", "理"]);
  });

  it("新增一条内容时不把后续相同内容误标为修改", () => {
    const before = "项目经历•搭建服务•发布版本";
    const after = "项目经历•搭建服务•增加监控•发布版本";
    const result = changedTextRanges(before, after);
    expect(result.before).toEqual([]);
    expect(fragments(after, result.after).join("")).toContain("增加监控");
    expect(fragments(after, result.after).join("")).not.toContain("发布版本");
  });

  it("删除段落中的孤立同字不能抵消新句末尾的字", () => {
    const before = "响应时间优化 99.9%。•设计话务实时监控链路，构建事件持久化与 Redis 实时投影；结合 CAS，保障并发统计一致性。•设计可配置的工单自动分配模块";
    const after = "响应时间优化 99.9%。定位方法份未发•设计可配置的工单自动分配模块";
    const result = changedTextRanges(before, after);
    expect(fragments(after, result.after).join("")).toBe("定位方法份未发");
    expect(fragments(before, result.before).join("")).toContain("并发统计");
  });

  it("两侧都处于相同位置的单字仍保留为未变化", () => {
    const result = changedTextRanges("甲发乙", "丙发丁");
    expect(fragments("甲发乙", result.before)).toEqual(["甲", "乙"]);
    expect(fragments("丙发丁", result.after)).toEqual(["丙", "丁"]);
  });

  it("相同文字没有标记，emoji 的范围保持完整", () => {
    expect(changedTextRanges("内容相同", "内容相同")).toEqual({ before: [], after: [] });
    const before = "完成 🚀 发布";
    const after = "完成 ✅ 发布";
    const result = changedTextRanges(before, after);
    expect(fragments(before, result.before)).toEqual(["🚀"]);
    expect(fragments(after, result.after)).toEqual(["✅"]);
  });
});
