import { describe, expect, it } from "vitest";
import { bankImportQuestions, readBankDirections, readBankEntry, readBankImportPage, readBankListPage } from "../bank";

const row = { id: 2, direction: "C++ / C# <T> &amp;", kind: "tech", question: "  原文内部  空格 <T> &amp;", created_at: "旧时间" };
describe("题库目录的筛选与分页边界", () => {
  it("无筛选时接受不同方向、未知历史题型及完整长原文，不改写记录", () => {
    const value = { items: [row, { ...row, id: 1, direction: "", kind: "legacy", question: "  Long <T> &amp;\n".repeat(1000) }], nextCursor: "1" };
    expect(readBankListPage(value)).toBe(value);
    expect(readBankListPage({ items: [], nextCursor: null }, { cursor: "2" }).items).toEqual([]);
  });
  it("整页逐字匹配规范化后的方向与题型，续页 ID 严格小于请求游标", () => {
    const value = { items: [row, { ...row, id: 1 }], nextCursor: "1" };
    expect(readBankListPage(value, { direction: `  ${row.direction}  `, kind: " tech ", cursor: "3" })).toBe(value);
  });
  it.each([null, [], {}, { items: [] }, { items: [null], nextCursor: null }, { items: [{ ...row, id: "2" }], nextCursor: null },
    { items: [{ ...row, kind: {} }], nextCursor: null }, { items: [row, row], nextCursor: null },
    { items: [{ ...row, id: 1 }, row], nextCursor: null }, { items: [], nextCursor: "2" },
    { items: [row], nextCursor: "1" }, { items: [row], nextCursor: "02" },
    { items: Array.from({ length: 51 }, (_, index) => ({ ...row, id: 51 - index })), nextCursor: null },
  ].map(value => [value]))("坏目录 %# 整页拒绝", value => { expect(() => readBankListPage(value)).toThrow(/题库读取响应/); });
  it.each([
    { direction: "另一方向" }, { kind: "behavior" }, { keyword: "未出现的关键字" }, { cursor: "2" }, { cursor: "1" },
    { cursor: "0" }, { cursor: "-1" }, { cursor: "1.5" }, { cursor: "02" }, { cursor: "bad" }, { cursor: "9007199254740992" },
  ])("串筛选或错误续页边界 %j 拒绝，不通过去重掩盖丢页", filter => {
    expect(() => readBankListPage({ items: [row], nextCursor: null }, filter)).toThrow(/不完整或筛选不符/);
  });
  it.each([
    ["C++ / C# <T> &amp;", " c++ / c# <T> &AMP; ", true],
    ["100%_path\\file", "%_path\\", true], ["100XXpathZfile", "%_path\\", false],
    ["École", "é", false], ["École", "É", true], ["中文  两个空格", "中文 两个空格", false],
    ["abc\0hidden", "hidden", false], ["xABC\0hidden", "abc\0ignored", true], ["abc extra", "abc\0ignored", false],
  ])("关键词边界 question=%j keyword=%j", (question, keyword, matches) => {
    const value = { items: [{ ...row, question }], nextCursor: null };
    if (matches) expect(readBankListPage(value, { keyword })).toBe(value);
    else expect(() => readBankListPage(value, { keyword })).toThrow(/题库读取响应/);
  });
});
describe("题目详情历史协议", () => {
  it("保留长题目、未知题型、空方向及历史时间的原文", () => {
    const saved = { ...row, kind: "legacy", direction: "", question: "  C++  <T> &amp;\n".repeat(1000) };
    expect(readBankEntry(saved, 2)).toBe(saved);
  });
  it.each([null, [], {}, { ...row, id: 1 }, { ...row, id: "2" }, { ...row, id: 0 }, { ...row, id: 1.5 },
    { ...row, id: Number.MAX_SAFE_INTEGER + 1 }, { ...row, direction: null }, { ...row, kind: null }, { ...row, question: null }, { ...row, created_at: null },
  ].map(value => [value]))("坏记录或串题 %# 不可作为删除核对依据", value => {
    expect(() => readBankEntry(value, 2)).toThrow(/不完整或记录不符/);
  });
});
describe("题库导入与只读快照协议", () => {
  it("逐行去首尾空白、忽略空行并按本批完整原文去重，不重写内部空格与字面量", () => {
    expect(bankImportQuestions("  C++ / C# <T> &amp;  \r\n\r\nC++ / C# <T> &amp;\n  原文内部  空格\n原文内部 空格  ")).toEqual(["C++ / C# <T> &amp;", "原文内部  空格", "原文内部 空格"]);
  });
  it("空快照和无损历史按原顺序回读，不声称本批已完成", () => {
    expect(readBankImportPage({ items: [], nextCursor: null }, row.direction, "tech")).toEqual({ items: [], nextCursor: null });
    const value = { items: [row, { ...row, id: 1, question: "Long_".repeat(1000) }], nextCursor: "1" };
    expect(readBankImportPage(value, row.direction, "tech")).toBe(value);
    expect(value.items[1]!.question).toBe("Long_".repeat(1000));
  });
  it("未指定方向时可读取所有方向，不把空方向当作接口支持的精确筛选", () => {
    expect(readBankImportPage({ items: [row, { ...row, id: 1, direction: "" }], nextCursor: null }, "", "tech").items).toHaveLength(2);
  });
  it.each([null, [], {}, { items: [] }, { items: {}, nextCursor: null }, { items: [], nextCursor: "1" },
    { items: [null], nextCursor: null }, { items: [{ ...row, id: 0 }], nextCursor: null }, { items: [{ ...row, id: 1.5 }], nextCursor: null },
    { items: [{ ...row, direction: "另一方向" }], nextCursor: null }, { items: [{ ...row, kind: "behavior" }], nextCursor: null },
    { items: [{ ...row, question: null }], nextCursor: null }, { items: [{ ...row, created_at: 1 }], nextCursor: null },
    { items: [row, row], nextCursor: null }, { items: [{ ...row, id: 1 }, row], nextCursor: null },
    { items: [row], nextCursor: "3" }, { items: [row], nextCursor: " 2" },
    { items: Array.from({ length: 51 }, (_, index) => ({ ...row, id: 51 - index })), nextCursor: null },
  ].map(value => [value]))("坏快照 %j 整页拒绝，不丢弃异常项后放开导入", value => {
    expect(() => readBankImportPage(value, row.direction, "tech")).toThrow(/不完整或筛选不符/);
  });
  it("方向统计保留准确计数与原文；不把有方向题数当作全题库总数", () => {
    expect(readBankDirections([{ direction: row.direction, count: 2 }])).toEqual([{ direction: row.direction, count: 2 }]);
    expect(readBankDirections([])).toEqual([]);
  });
  it.each([null, {}, [null], [{ direction: "a", count: "2" }], [{ direction: "", count: 1 }], [{ direction: "a", count: 0 }],
    [{ direction: "a", count: 1.5 }], [{ direction: "a", count: Number.MAX_SAFE_INTEGER + 1 }], [{ direction: "a", count: 1 }, { direction: "a", count: 2 }],
  ].map(value => [value]))("坏方向统计 %j 整份拒绝", value => { expect(() => readBankDirections(value)).toThrow(/方向列表响应不完整/); });
});
