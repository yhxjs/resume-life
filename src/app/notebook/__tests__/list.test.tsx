// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Page from "../page";

vi.mock("@/components/common/confirm-dialog", () => ({ confirmDialog: vi.fn(async () => true) }));
const row = { id: 3, category_id: 8, category_name: "分类:原文 <T> &amp;", source: "drill", source_label: "原始练习", question: "原题 C++ <T> &amp;", answer: "原答内部  空格", comment: "原点评", reference: "原参考", scores: null, created_at: "2026-10-29", updated_at: "2026-10-29", review_card_id: null, review_mastery: null, next_review_date: null };
function install(pages: unknown[]) {
  const fetch = vi.fn(async (url: string) => Response.json(url === "/api/notebook/categories" ? [{ id: 8, name: row.category_name, entry_count: 1 }] : pages.shift()));
  vi.stubGlobal("fetch", fetch); return fetch;
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const settle = () => act(() => vi.advanceTimersByTimeAsync(260));

describe("错题目录整页边界", () => {
  it("坏字段整页拒绝并提供重试，不能展示部分错题", async () => {
    install([{ items: [row, { ...row, id: 2, answer: null }], nextCursor: null }, { items: [row], nextCursor: null }]);
    render(<Page />); await settle();
    expect(screen.queryByRole("article")).toBeNull(); expect(screen.getByRole("alert").textContent).toContain("错题读取响应");
    fireEvent.click(screen.getByRole("button", { name: "重试加载" })); await settle();
    expect(screen.getByRole("article", { name: "错题 #3" })).toBeTruthy(); expect(screen.queryByRole("alert")).toBeNull();
  });

  it("初始空目录仍能设置来源及关键词，读取失败时保留这些入口", async () => {
    install([{ items: [], nextCursor: null }, { items: [{ ...row, source: "interview", question: "另一个关键词" }], nextCursor: null }]);
    render(<Page />); await settle();
    fireEvent.change(screen.getByRole("combobox", { name: "按来源过滤" }), { target: { value: "interview" } });
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索错题" }), { target: { value: "只在原答中搜索" } }); await settle();
    expect(screen.queryByRole("article")).toBeNull(); expect(screen.getByRole("alert").textContent).toContain("错题读取响应");
    expect((screen.getByRole("searchbox", { name: "搜索错题" }) as HTMLInputElement).value).toBe("只在原答中搜索");
    expect((screen.getByRole("combobox", { name: "按来源过滤" }) as HTMLSelectElement).value).toBe("interview");
  });

  it("续页重复边界整页拒绝，原游标重试只追加一次后续项", async () => {
    const second = { ...row, id: 2, question: "第二题" }; const last = { ...row, id: 1, question: "更早的题" };
    const fetch = install([{ items: [row, second], nextCursor: "2" }, { items: [second, last], nextCursor: null }, { items: [last], nextCursor: null }]);
    render(<Page />); await settle(); fireEvent.click(screen.getByRole("button", { name: "加载更多" })); await settle();
    expect(screen.getAllByRole("article")).toHaveLength(2); expect(screen.queryByRole("article", { name: "错题 #1" })).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("错题读取响应");
    fireEvent.click(screen.getByRole("button", { name: "重试加载更多" })); await settle();
    expect(screen.getAllByRole("article")).toHaveLength(3);
    const urls = fetch.mock.calls.map(([url]) => url).filter(url => url.includes("cursor=")); expect(urls).toEqual(["/api/notebook?cursor=2", "/api/notebook?cursor=2"]);
  });

  it("按分类和来源拒绝串结果，搜索范围包含原答但不含参考", async () => {
    install([{ items: [row], nextCursor: null }, { items: [row], nextCursor: null }, { items: [{ ...row, source: "interview" }], nextCursor: null }, { items: [{ ...row, source: "interview", category_id: 9, category_name: "串分类" }], nextCursor: null }, { items: [{ ...row, source: "interview" }], nextCursor: null }]);
    render(<Page />); await settle();
    fireEvent.click(screen.getByRole("button", { name: `${row.category_name}(1)` }));
    fireEvent.change(screen.getByRole("combobox", { name: "按来源过滤" }), { target: { value: "interview" } });
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索错题" }), { target: { value: "原答内部  空格" } }); await settle();
    expect(screen.queryByRole("article")).toBeNull(); expect(screen.getByRole("alert").textContent).toContain("错题读取响应");
    fireEvent.click(screen.getByRole("button", { name: "重试加载" })); await settle(); expect(screen.getByRole("article")).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索错题" }), { target: { value: "原参考" } }); await settle();
    expect(screen.queryByRole("article")).toBeNull(); expect(screen.getByRole("alert").textContent).toContain("错题读取响应");
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索错题" }), { target: { value: "原答内部  空格" } }); await settle();
    expect(screen.getByRole("article", { name: "错题 #3" })).toBeTruthy();
  });

  it("展示中性的练习参考标签，不承诺权威标准答案", async () => {
    install([{ items: [row], nextCursor: null }]);
    render(<Page />); await settle();
    fireEvent.click(screen.getByRole("button", { name: "展开温习" }));
    expect(screen.getByText("练习参考答案")).toBeTruthy();
    expect(screen.getByText("原参考")).toBeTruthy();
    expect(screen.queryByText(/标准参考答案|导师参考答案/)).toBeNull();
  });

  it("当前分类从最新统计消失后仍明确显示筛选，可切回全部", async () => {
    let removed = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/notebook/categories") return Response.json(removed ? [] : [{ id: 8, name: row.category_name, entry_count: 1 }]);
      if (init?.method === "DELETE") { removed = true; return Response.json({ ok: true }); }
      return Response.json({ items: removed ? [] : [row], nextCursor: null });
    }));
    render(<Page />); await settle(); fireEvent.click(screen.getByRole("button", { name: `${row.category_name}(1)` })); await settle();
    fireEvent.click(screen.getByRole("button", { name: "移出" })); await settle();
    expect(screen.getByText(`当前分类：${row.category_name}`, { exact: false })).toBeTruthy();
    expect(screen.getByRole("button", { name: "全部错题" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "全部错题" })); await settle(); expect(screen.queryByText(/当前分类：/)).toBeNull();
  });
});
