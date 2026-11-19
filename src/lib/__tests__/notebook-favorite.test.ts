import { describe, expect, it } from "vitest";
import { readCreatedNotebookFavorite, readNotebookFavorite } from "../notebook-records";

const review = { review_card_id: 8, review_mastery: "new", next_review_date: "旧日期" };
const saved = { id: 3, source: "drill", source_id: 11, category_id: null, question: " 原题 <T> &amp;\n内部  空格 ".repeat(2000), answer: "", comment: "旧点评", reference: "旧参考", review };
describe("收藏确认与来源回读协议", () => {
  it("新建确认要求正安全整数 ID 与完整复习关联", () => { expect(readCreatedNotebookFavorite({ id: 3, review })).toEqual({ id: 3, review }); });
  it.each([null, [], {}, { id: "3", review }, { id: 0, review }, { id: 1.5, review }, { id: Number.MAX_SAFE_INTEGER + 1, review }, { id: 3 }, { id: 3, review: null }, { id: 3, review: {} }, { id: 3, review: { ...review, review_card_id: "8" } }, { id: 3, review: { ...review, review_mastery: "bad" } }, { id: 3, review: { ...review, next_review_date: null } }])("坏创建确认 %j 不被接受", value => { expect(() => readCreatedNotebookFavorite(value)).toThrow(/收藏响应/); });
  it("保留历史长原文与空字段，允许缺卡的历史收藏，不修改读取结果", () => {
    const before = structuredClone(saved); expect(readNotebookFavorite(saved, "drill", 11)).toBe(saved); expect(saved).toEqual(before);
    expect(readNotebookFavorite({ ...saved, review: null }, "drill", 11).review).toBeNull();
  });
  it.each([null, [], {}, { ...saved, id: 0 }, { ...saved, id: "3" }, { ...saved, source: "interview" }, { ...saved, source_id: 12 }, { ...saved, source_id: "11" }, { ...saved, category_id: 0 }, { ...saved, category_id: "4" }, { ...saved, question: null }, { ...saved, answer: [] }, { ...saved, comment: undefined }, { ...saved, reference: false }, { ...saved, review: undefined }, { ...saved, review: { ...review, review_card_id: 0 } }])("坏结构或串来源 %j 不认领收藏", value => { expect(() => readNotebookFavorite(value, "drill", 11)).toThrow(); });
});
