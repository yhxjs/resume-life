import { describe, expect, it } from "vitest";
import { readCreatedNotebookCategory, readNotebookCategories, readNotebookCategory, readNotebookCategoryAssignment, readNotebookListPage } from "../notebook-records";

const row = { id: 3, category_id: 8, category_name: "原分类 <T> &amp;", source: "drill", source_label: "来源已删", question: "  原题内部  空格 <T> &amp;\n", answer: "旧原答", comment: "原点评", reference: "只在参考中出现", scores: null, created_at: "旧时间", updated_at: "", review_card_id: null, review_mastery: null, next_review_date: null };
const pageOf = (value: unknown) => ({ items: [value], nextCursor: null });

describe("错题目录协议", () => {
  it("历史数值小数通过目录校验且逐字保留，不把新评分的整数限制套用到读取", () => {
    const saved = pageOf({ ...row, scores: { depth: 7.44, structure: 0, authenticity: 10, completeness: 8.36 } });
    const before = structuredClone(saved);
    expect(readNotebookListPage(saved)).toBe(saved);
    expect(saved).toEqual(before);
  });
  it("逐字保留长历史、空字段及时间字面量，允许三种来源和空末页", () => {
    const saved = { items: [row, { ...row, id: 2, source: "application_interview", question: "  原题 <T> &amp;\n".repeat(2000), answer: "", category_id: null, category_name: null }, { ...row, id: 1, source: "interview", scores: { depth: 0, structure: 10, authenticity: 7, completeness: 8 } }], nextCursor: "1" };
    const before = structuredClone(saved); expect(readNotebookListPage(saved)).toBe(saved); expect(saved).toEqual(before);
    expect(readNotebookListPage({ items: [], nextCursor: null }, { cursor: "1" })).toEqual({ items: [], nextCursor: null });
  });
  it.each([null, [], {}, { items: [] }, { items: null, nextCursor: null }, { items: [], nextCursor: "3" }, { items: [row], nextCursor: "2" },
    { items: [row], nextCursor: "03" }, { items: [row, row], nextCursor: null }, { items: [{ ...row, id: 2 }, row], nextCursor: null },
    { items: Array.from({ length: 51 }, (_, index) => ({ ...row, id: 51 - index })), nextCursor: null },
  ].map(value => [value]))("坏分页外壳、顺序或游标 %# 整页拒绝", value => { expect(() => readNotebookListPage(value)).toThrow(/错题读取响应/); });
  it.each([null, [], {}, { ...row, id: "3" }, { ...row, id: 0 }, { ...row, id: Number.MAX_SAFE_INTEGER + 1 },
    { ...row, source: "legacy" }, { ...row, source_label: null }, { ...row, question: {} }, { ...row, answer: null }, { ...row, comment: [] }, { ...row, reference: false },
    { ...row, created_at: null }, { ...row, updated_at: undefined }, { ...row, category_id: "8" }, { ...row, category_name: null }, { ...row, category_id: null },
    { ...row, scores: {} }, { ...row, scores: [] }, { ...row, scores: { depth: 1, structure: 2, authenticity: 3, completeness: "4" } },
    { ...row, scores: { depth: Infinity, structure: 2, authenticity: 3, completeness: 4 } }, { ...row, scores: { depth: -1, structure: 2, authenticity: 3, completeness: 4 } },
    { ...row, review_card_id: undefined }, { ...row, review_card_id: 9 }, { ...row, review_mastery: "new" }, { ...row, next_review_date: "2026-10-29" },
    { ...row, review_card_id: 9, review_mastery: "unknown", next_review_date: "2026-10-29" },
    { ...row, review_card_id: 9, review_mastery: "new", next_review_date: null },
  ].map(value => [value]))("坏条目 %# 不被跳过或补默认值", value => { expect(() => readNotebookListPage({ items: [row, value], nextCursor: null })).toThrow(/错题读取响应/); });
  it.each(["new", "relearning", "learning", "familiar", "mastered"])("复习关联完整时接受进度 %s", review_mastery => {
    const value = pageOf({ ...row, review_card_id: 9, review_mastery, next_review_date: "历史日期" }); expect(readNotebookListPage(value)).toBe(value);
  });
  it.each([{ category: 0 }, { category: 9 }, { source: "interview" as const }, { keyword: "只在参考中出现" }, { keyword: "来源已删" },
    ...["3", "2", "0", "-1", "1.5", "03", "bad", "9007199254740992"].map(cursor => ({ cursor })),
  ])("拒绝串筛选及跨回请求游标 %j", filter => { expect(() => readNotebookListPage(pageOf(row), filter)).toThrow(/错题读取响应/); });
  it("分类、来源和关键词同时匹配，不将未分类扩为全部", () => {
    expect(readNotebookListPage(pageOf(row), { category: 8, source: "drill", keyword: "  原题内部  空格  ", cursor: "4" }).items).toEqual([row]);
    const unclassified = { ...row, category_id: null, category_name: null }; expect(readNotebookListPage(pageOf(unclassified), { category: 0 }).items).toEqual([unclassified]);
  });
  it.each(["question", "answer", "comment"])("按 %s 搜索与 SQLite 字面量一致", field => {
    const value = pageOf({ ...row, question: "", answer: "", comment: "", [field]: "C++ <T> &amp; 100%_path\\file\n内部  空格" });
    expect(readNotebookListPage(value, { keyword: " c++ <T> &AMP; 100%_path\\file " })).toBe(value);
    expect(() => readNotebookListPage(value, { keyword: "100XXpathZfile" })).toThrow(/错题读取响应/);
    expect(() => readNotebookListPage(value, { keyword: "内部 空格" })).toThrow(/错题读取响应/);
  });
  it.each([["École", "é", false], ["École", "É", true], ["abc\0hidden", "hidden", false], ["xABC\0hidden", "abc\0ignored", true], ["abc extra", "abc\0ignored", false]] as const)("Unicode 与 NUL 保留查询边界 %j / %j", (answer, keyword, matches) => {
    const value = pageOf({ ...row, question: "", comment: "", answer });
    if (matches) expect(readNotebookListPage(value, { keyword })).toBe(value); else expect(() => readNotebookListPage(value, { keyword })).toThrow(/错题读取响应/);
  });
});

describe("分类操作回读协议", () => {
  const category = { id: 8, name: "  历史 <T> &amp;\n".repeat(100), entry_count: 0 };
  it("保留合法分类原文和当前分类 ID", () => {
    expect(readNotebookCategory(category, 8)).toBe(category);
    expect(readCreatedNotebookCategory({ id: 8, name: "新分类" }, "新分类")).toEqual({ id: 8, name: "新分类" });
    expect(readNotebookCategoryAssignment(row, 3)).toBe(8); expect(readNotebookCategoryAssignment({ ...row, category_id: null }, 3)).toBeNull();
  });
  it.each([null, [], {}, { ...category, id: 0 }, { ...category, name: null }, { ...category, entry_count: -1 }, { ...category, id: 9 }])("坏分类 %j 不能确认同一对象", value => { expect(() => readNotebookCategory(value, 8)).toThrow(); });
  it("同名分类列表不能被用来推断唯一创建对象", () => { expect(() => readNotebookCategories([category, { ...category, id: 9 }])).toThrow(); });
  it.each([null, {}, [], { id: 8, name: "串名称" }, { id: "8", name: "新分类" }, { id: Number.MAX_SAFE_INTEGER + 1, name: "新分类" }])("坏创建确认 %j 不能清空原稿", value => { expect(() => readCreatedNotebookCategory(value, "新分类")).toThrow(); });
  it.each([{ ...row, id: 8 }, { ...row, category_id: undefined }, { ...row, category_id: 0 }, { ...row, category_id: "8" }, { ...row, question: null }])("坏移动回读 %j 不能确认分类", value => { expect(() => readNotebookCategoryAssignment(value, 3)).toThrow(); });
});
