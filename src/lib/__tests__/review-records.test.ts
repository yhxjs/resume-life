import { describe, expect, it } from "vitest";
import { readReviewDetail, readReviewSubmission } from "../review-records";

const input = { cardId: 301, answer: "  原答 <T> &amp;\n内部  空格  ", grade: "good" as const, expectedReviewCount: 1, timeZone: "Asia/Tokyo" };
const card = { id: 301, source: "notebook", source_id: 91, source_label: "来源", question: "原题", mastery: "learning", interval_days: 1, ease_factor: 250, repetitions: 1, review_count: 2, lapses: 0, next_review_date: "旧日期", last_reviewed_at: "旧日期" };
const attempt = { id: 6, answer: input.answer.trim(), grade: "good", reviewed_at: "旧日期", interval_days: 1, next_review_date: "旧日期" };
const detail = { ...card, answer: " 原答 ".repeat(10000), reference: "", comment: "<T>&amp;\n", attempts: [attempt], nextCursor: null };
describe("复习读取与提交协议", () => {
  it("历史长文本、空原文与日期字面量原样保留，尾游标对应真实末项", () => {
    expect(readReviewDetail(detail, 301)).toBe(detail);
    expect(readReviewDetail({ ...detail, nextCursor: "6" }, 301, "7").nextCursor).toBe("6");
  });
  it.each([null, [], {}, { ...detail, id: 302 }, { ...detail, source_id: 0 }, { ...detail, source: "bad" }, { ...detail, review_count: -1 }, { ...detail, ease_factor: 2.5 }, { ...detail, mastery: "bad" }, { ...detail, reference: null }, { ...detail, attempts: null }, { ...detail, attempts: [attempt, attempt] }, { ...detail, attempts: [{ ...attempt, grade: "bad" }] }, { ...detail, nextCursor: "7" }, { ...detail, attempts: [], nextCursor: "6" }])("坏详情 %j 整份拒绝", value => { expect(() => readReviewDetail(value, 301)).toThrow(); });
  it.each(["6", "5", "bad", "06"])("历史续页拒绝重复边界或非法请求游标 %s", cursor => { expect(() => readReviewDetail(detail, 301, cursor)).toThrow(); });
  it("确认编号与本次原答自评，允许其他复习后返回最新排期及追练转收藏", () => {
    const result = { card: { ...card, review_count: 4 }, attempt, request_id: "原编号" };
    expect(readReviewSubmission(result, input, "原编号")).toEqual({ card: result.card, attempt });
  });
  it.each([null, {}, { card: { ...card, id: 302 }, attempt }, { card: { ...card, review_count: 1 }, attempt }, { card, attempt: { ...attempt, answer: "串原答" } }, { card, attempt: { ...attempt, grade: "easy" } }, { card, attempt: { ...attempt, id: 0 } }, { card, attempt, request_id: "串编号" }])("坏保存结果 %j 不认领", value => { expect(() => readReviewSubmission(value, input, "原编号")).toThrow(); });
});
