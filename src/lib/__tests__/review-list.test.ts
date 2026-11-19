import { describe, expect, it } from "vitest";
import { appendReviewList, readReviewList } from "../review-records";
import { encodeUpdatedAtCursor } from "../cursor-pagination";

const date = "2026-10-29";
const query = { scope: "due" as const, source: "all" as const, limit: 1, date };
const card = { id: 1, source: "notebook" as const, source_id: 1, question: "  原题 <T> &amp;\n内部  空格  ".repeat(2000), source_label: "", interval_days: 0, ease_factor: 250, repetitions: 0, review_count: 0, lapses: 0, next_review_date: date, sort_date: "2026-10-30", last_reviewed_at: "", mastery: "new" as const };
const summary = { date, total: 3, due: 3, notebook: 3, remedial: 0, overdue: 0, completed_today: 0 };
const cursor = encodeUpdatedAtCursor({ updatedAt: card.sort_date, id: 1 });
const page = { items: [card], nextCursor: cursor, summary };

describe("复习列表协议与跨页移动", () => {
  it("新卡按存储排期分页，展示当地今日，长题目及空来源原样保留", () => {
    expect(readReviewList(page, query)).toBe(page);
    const older = { ...card, sort_date: "2026-10-28" };
    expect(readReviewList({ ...page, items: [older], nextCursor: null }, query).items[0]).toBe(older);
  });
  it.each([
    null, {}, { ...page, items: null }, { ...page, items: [card, card] }, { ...page, summary: null },
    { ...page, summary: { ...summary, date: "2026-10-28" } }, { ...page, summary: { ...summary, date: "2026-02-30" } },
    { ...page, summary: { ...summary, due: 4 } }, { ...page, summary: { ...summary, overdue: 4 } },
    { ...page, summary: { ...summary, notebook: 2 } }, { ...page, summary: { ...summary, completed_today: 4 } },
    { ...page, summary: { ...summary, total: "3" } }, { ...page, summary: { ...summary, total: -1 } },
    { ...page, items: [{ ...card, sort_date: "2026-02-30" }] }, { ...page, items: [{ ...card, next_review_date: "2026-10-30" }] },
    { ...page, items: [{ ...card, id: 0 }] }, { ...page, items: [{ ...card, question: null }] },
    { ...page, nextCursor: "invalid" }, { ...page, nextCursor: encodeUpdatedAtCursor({ updatedAt: card.sort_date, id: 2 }) },
    { ...page, nextCursor: encodeUpdatedAtCursor({ updatedAt: date, id: 1 }) }, { ...page, items: [], nextCursor: cursor },
    { ...page, items: [], nextCursor: null },
  ])("坏数据整页拒绝（用例 %#）", value => { expect(() => readReviewList(value, query)).toThrow(); });
  it("尾游标必须对应满页末项；来源和到期范围均校验", () => {
    expect(() => readReviewList(page, { ...query, limit: 2 })).toThrow();
    expect(() => readReviewList(page, { ...query, source: "remedial" })).toThrow();
    const learned = { ...card, review_count: 1, next_review_date: card.sort_date };
    expect(() => readReviewList({ ...page, items: [learned] }, query)).toThrow();
    expect(readReviewList({ ...page, items: [learned] }, { ...query, scope: "all" }).items).toEqual([learned]);
  });
  it("严格拒绝重复边界、逆序、同页重复编号及时间戳边界", () => {
    expect(() => readReviewList(page, { ...query, cursor })).toThrow();
    expect(() => readReviewList({ ...page, items: [{ ...card, id: 2 }, card], nextCursor: null }, { ...query, limit: 2 })).toThrow();
    expect(() => readReviewList({ ...page, items: [card, { ...card, sort_date: "2026-11-01" }], nextCursor: null }, { ...query, limit: 2 })).toThrow();
    expect(() => readReviewList(page, { ...query, cursor: encodeUpdatedAtCursor({ updatedAt: "2026-10-28T00:00:00.000Z", id: 1 }) })).toThrow();
  });
  it("允许真实学习使卡后移与全局统计变化，更新后重排而非原位置覆盖", () => {
    const first = readReviewList({ ...page, items: [{ ...card, sort_date: date }] , nextCursor: null }, query);
    const moved = { ...card, review_count: 1, mastery: "learning" as const, next_review_date: "2026-10-31", sort_date: "2026-10-31" };
    const next = readReviewList({ items: [{ ...card, id: 2 }, moved], nextCursor: null, summary: { ...summary, due: 2, notebook: 2, completed_today: 1 } }, { ...query, scope: "all", limit: 2 });
    expect(appendReviewList(first, next).items.map(item => item.id)).toEqual([2, 1]);
    expect(appendReviewList(first, next).summary.due).toBe(2);
    expect(() => appendReviewList(first, { ...next, items: [{ ...moved, review_count: 0 }] })).toThrow();
    expect(() => appendReviewList(first, { ...next, items: [{ ...moved, sort_date: date }] })).toThrow();
    expect(() => appendReviewList(first, { ...next, summary: { ...summary, date: "2026-10-30" } })).toThrow();
  });
});
