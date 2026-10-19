import { describe, expect, it } from "vitest";
import {
  InvalidPaginationParameterError,
  createCursorPage,
  encodeUpdatedAtCursor,
  parseIdCursor,
  parsePageLimit,
  parseUpdatedAtCursor,
  DEFAULT_PAGE_LIMIT,
  MAX_PAGE_LIMIT,
} from "../cursor-pagination";

const params = (query: string) => new URLSearchParams(query);

describe("parsePageLimit", () => {
  it("缺省返回默认值", () => {
    expect(parsePageLimit(params(""))).toBe(DEFAULT_PAGE_LIMIT);
  });
  it("接受边界值", () => {
    expect(parsePageLimit(params("limit=1"))).toBe(1);
    expect(parsePageLimit(params(`limit=${MAX_PAGE_LIMIT}`))).toBe(MAX_PAGE_LIMIT);
  });
  it.each(["0", "-1", "1.5", "abc", "", "1000", "1e3"])("拒绝非法值 %s", (raw) => {
    expect(() => parsePageLimit(params(`limit=${raw}`))).toThrow(InvalidPaginationParameterError);
  });
});

describe("parseIdCursor", () => {
  it("缺省返回 null", () => {
    expect(parseIdCursor(params(""))).toBeNull();
  });
  it("接受正整数", () => {
    expect(parseIdCursor(params("cursor=42"))).toBe(42);
  });
  it.each(["0", "-1", "1.5", "abc", "1e3"])("拒绝非法值 %s", (raw) => {
    expect(() => parseIdCursor(params(`cursor=${raw}`))).toThrow(InvalidPaginationParameterError);
  });
});

describe("parseUpdatedAtCursor", () => {
  it("缺省返回 null", () => {
    expect(parseUpdatedAtCursor(params(""))).toBeNull();
  });
  it("往返编码/解码保持一致", () => {
    const cursor = { updatedAt: "2026-09-20T03:04:05.678Z", id: 7 };
    expect(parseUpdatedAtCursor(params(`cursor=${encodeUpdatedAtCursor(cursor)}`))).toEqual(cursor);
  });
  it("接受纯日期形式", () => {
    expect(parseUpdatedAtCursor(params(`cursor=${encodeUpdatedAtCursor({ updatedAt: "2026-09-20", id: 1 })}`))).toEqual({
      updatedAt: "2026-09-20",
      id: 1,
    });
  });
  it.each([
    "not-base64url!!",
    Buffer.from("{}", "utf8").toString("base64url"),
    Buffer.from(JSON.stringify({ updatedAt: "2026-02-30", id: 1 }), "utf8").toString("base64url"),
    Buffer.from(JSON.stringify({ updatedAt: "2026-09-20T03:04:05.678Z", id: 0 }), "utf8").toString("base64url"),
    Buffer.from(JSON.stringify({ updatedAt: "2026-09-20T25:00:00.000Z", id: 1 }), "utf8").toString("base64url"),
  ])("拒绝非法游标 %s", (raw) => {
    expect(() => parseUpdatedAtCursor(params(`cursor=${raw}`))).toThrow(InvalidPaginationParameterError);
  });
});

describe("createCursorPage", () => {
  it("行数未超 limit 时无下一页", () => {
    expect(createCursorPage([{ id: 3 }, { id: 2 }], 5, (r) => String(r.id))).toEqual({
      items: [{ id: 3 }, { id: 2 }],
      nextCursor: null,
    });
  });
  it("多取一行时裁掉并把该行游标作为 nextCursor", () => {
    const rows = [{ id: 5 }, { id: 4 }, { id: 3 }];
    expect(createCursorPage(rows, 2, (r) => String(r.id))).toEqual({
      items: [{ id: 5 }, { id: 4 }],
      nextCursor: "4",
    });
  });
});
