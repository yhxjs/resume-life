import { describe, expect, it } from "vitest";
import { formatIntroHistoryDate, readIntroListPage } from "../intro-history";

const row = { id: 3, jd: "  原 JD <T> &amp;\n内部  空格  ".repeat(4000), created_at: "历史日期字面量", resume_title: " 原简历 <T> &amp; ", resume_version_id: 11, resume_version: 2, resume_version_name: "原发布版" };
const page = { items: [row], nextCursor: "3", total: 2 };

describe("自我介绍历史列表协议", () => {
  it("长历史原文与绑定发布版本原样保留，允许未绑定的旧记录", () => {
    expect(readIntroListPage(page, { limit: 1 })).toBe(page);
    const legacy = { items: [{ ...row, jd: "", created_at: "", resume_title: "", resume_version_id: null, resume_version: null, resume_version_name: null }], nextCursor: null };
    expect(readIntroListPage(legacy).items[0]).toBe(legacy.items[0]);
    expect(readIntroListPage({ items: [], nextCursor: null, total: 0 }).items).toEqual([]);
  });

  it.each([
    null, [], {}, { items: null, nextCursor: null }, { ...page, items: [null] }, { ...page, items: [row, row] },
    { ...page, nextCursor: undefined }, { ...page, nextCursor: "" }, { ...page, nextCursor: "2" }, { ...page, nextCursor: 3 },
    { ...page, total: -1 }, { ...page, total: 1.5 }, { ...page, total: "2" }, { items: [], nextCursor: "3" },
    ...[{ id: 0 }, { id: "3" }, { id: Number.MAX_SAFE_INTEGER + 1 }, { jd: null }, { resume_title: [] }, { created_at: null },
      { resume_version_id: undefined }, { resume_version_id: 0 }, { resume_version: null }, { resume_version: 0 },
      { resume_version_name: null }, { resume_version_id: null }, { resume_version_id: null, resume_version: null, resume_version_name: "旧名称" },
    ].map(change => ({ ...page, items: [{ ...row, ...change }] })),
  ])("整页拒绝损坏内容或版本关联，不部分接受 %#", value => {
    expect(() => readIntroListPage(value, { limit: 1 })).toThrow("自我介绍历史响应");
  });

  it.each(["3", "2", "bad", "0", "1e3", "1.5"])("拒绝跨回请求边界与无效游标 %s", cursor => {
    expect(() => readIntroListPage(page, { cursor, limit: 1 })).toThrow();
  });

  it("整页严格倒序，只有满页真实末项可以作为续页游标", () => {
    const second = { ...row, id: 2 };
    expect(readIntroListPage({ items: [row, second], nextCursor: "2" }, { limit: 2, cursor: "4" }).items).toEqual([row, second]);
    expect(() => readIntroListPage({ ...page, items: [row, row] }, { limit: 2 })).toThrow();
    expect(() => readIntroListPage({ items: [second, row], nextCursor: null }, { limit: 2 })).toThrow();
    expect(() => readIntroListPage(page, { limit: 2 })).toThrow();
    expect(() => readIntroListPage({ items: [row, second], nextCursor: "3" }, { limit: 2 })).toThrow();
    expect(readIntroListPage({ items: [second], nextCursor: null }, { limit: 2, cursor: "3" }).items).toEqual([second]);
  });

  it("日期展示保留不可解析的原文，不补造时间", () => {
    expect(formatIntroHistoryDate(row.created_at)).toBe(row.created_at);
    expect(formatIntroHistoryDate("")).toBe("未记录时间");
    expect(formatIntroHistoryDate("2026-10-29T00:00:00Z")).toBe(new Date("2026-10-29T00:00:00Z").toLocaleDateString());
  });

  it("只有年月日的历史是日历日期，不能按 UTC 时间戳跨日显示", () => {
    expect(formatIntroHistoryDate("2026-10-29")).toBe("2026-10-29");
    expect(formatIntroHistoryDate("2026-02-30")).toBe("2026-02-30");
  });
});
