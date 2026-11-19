import { describe, expect, it } from "vitest";
import { readProjectSummaryHistoryPage } from "../project-summary-history-records";
import { emptySummary } from "../summary";

const summary = { ...emptySummary(), overview: " 历史原文 <T> &amp;\n内部  空格 ".repeat(2000), achievements: ["", " 原成果\n内部  空格 "] };
const item = { id: 30, source: "manual", createdAt: "旧日期字面量", summary, aiBaseline: { overview: " 原 AI 文案 ", "achievement:0": "" } };
const page = { projectId: 1, items: [item], nextCursor: "30" };
const query = { projectId: 1, limit: 1 };

describe("项目总结历史协议", () => {
  it("合法长存档、空成果和时间字面量完整保留，不套用新生成约束", () => {
    expect(readProjectSummaryHistoryPage(page, query)).toBe(page);
    expect(readProjectSummaryHistoryPage({ ...page, nextCursor: null, items: [{ ...item, summary: emptySummary() }] }, query).items[0]!.summary).toEqual(emptySummary());
    expect(readProjectSummaryHistoryPage({ ...page, nextCursor: null }, { ...query, cursor: "31" }).items[0]!.createdAt).toBe(item.createdAt);
  });
  it.each([
    null, [], {}, { ...page, projectId: 2 }, { ...page, projectId: "1" }, { ...page, projectId: undefined },
    { ...page, items: null }, { ...page, items: [item, item] }, { ...page, items: [], nextCursor: "30" },
    { ...page, nextCursor: "29" }, { ...page, nextCursor: "" }, { ...page, total: -1 },
    { ...page, items: [{ ...item, id: 0 }] }, { ...page, items: [{ ...item, source: "bad" }] },
    { ...page, items: [{ ...item, createdAt: null }] }, { ...page, items: [{ ...item, summary: null }] },
    { ...page, items: [{ ...item, summary: {} }] }, { ...page, items: [{ ...item, summary: { ...summary, overview: undefined } }] },
    { ...page, items: [{ ...item, summary: { ...summary, achievements: [null] } }] },
    { ...page, items: [{ ...item, aiBaseline: null }] }, { ...page, items: [{ ...item, aiBaseline: { overview: 1 } }] },
  ])("拒绝坏页（用例 %#）", value => { expect(() => readProjectSummaryHistoryPage(value, query)).toThrow("总结历史响应不完整"); });
  it.each(["30", "29", "bad", "0", "1e3"])("拒绝重复/倒退边界及非法请求游标 %s", cursor => {
    expect(() => readProjectSummaryHistoryPage(page, { ...query, cursor })).toThrow();
  });
  it("校验整页严格倒序、重复编号及满页末项游标", () => {
    expect(() => readProjectSummaryHistoryPage({ ...page, items: [item, item] }, { ...query, limit: 2 })).toThrow();
    expect(() => readProjectSummaryHistoryPage({ ...page, items: [{ ...item, id: 29 }, item] }, { ...query, limit: 2 })).toThrow();
    expect(() => readProjectSummaryHistoryPage(page, { ...query, limit: 2 })).toThrow();
    expect(readProjectSummaryHistoryPage({ ...page, items: [item, { ...item, id: 29 }], nextCursor: "29" }, { ...query, limit: 2 }).items).toHaveLength(2);
  });
});
