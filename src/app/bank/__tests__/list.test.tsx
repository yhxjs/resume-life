// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Page from "../page";

const row = { id: 3, direction: "C++ <T> &amp;", kind: "tech", question: "原题 C++ <T> &amp;？", created_at: "2026-10-29" };
function install(pages: unknown[]) {
  const fetch = vi.fn(async (url: string) => Response.json(url === "/api/bank/directions" ? [] : pages.shift()));
  vi.stubGlobal("fetch", fetch); return fetch;
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const settle = () => act(() => vi.advanceTimersByTimeAsync(260));

describe("题库目录领域边界", () => {
  it.each([null, { ...row, id: "3" }, { ...row, question: {} }, { ...row, direction: [] }, { ...row, kind: null }])("首屏坏条目 %# 不崩溃或部分渲染，保留重试入口", async invalid => {
    install([{ items: [row, invalid], nextCursor: null }]); render(<Page />); await settle();
    expect(screen.queryByRole("listitem")).toBeNull(); expect(screen.getByRole("alert").textContent).toContain("题库读取响应");
    expect(screen.getByRole("button", { name: "重试加载" })).toBeTruthy();
  });

  it("坏条目不冒充有效题目，首页明确报错、保留草稿并可重读", async () => {
    install([{ items: [{ ...row, created_at: null }], nextCursor: null }, { items: [row], nextCursor: null }]);
    render(<Page />); const input = screen.getByRole("textbox", { name: "导入考题" });
    fireEvent.change(input, { target: { value: "未提交 <T> &amp;\n内部  空格" } }); await settle();
    expect(screen.queryByText(row.question)).toBeNull(); expect(screen.getByRole("alert").textContent).toContain("题库读取响应");
    expect((input as HTMLTextAreaElement).value).toBe("未提交 <T> &amp;\n内部  空格");
    fireEvent.click(screen.getByRole("button", { name: "重试加载" })); await settle();
    expect(screen.getByText(row.question)).toBeTruthy(); expect(screen.queryByRole("alert")).toBeNull();
  });

  it("续页跨回原游标的重复 ID 整页拒绝，原结果保留且原游标可以重试", async () => {
    const second = { ...row, id: 2, question: "第二题" }; const last = { ...row, id: 1, question: "更早一题" };
    const fetch = install([{ items: [row, second], nextCursor: "2" }, { items: [second, last], nextCursor: null }, { items: [last], nextCursor: null }]);
    render(<Page />); await settle(); fireEvent.click(screen.getByRole("button", { name: "加载更多" })); await settle();
    expect(screen.getAllByRole("listitem")).toHaveLength(2); expect(screen.queryByText(last.question)).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("题库读取响应");
    fireEvent.click(screen.getByRole("button", { name: "重试加载更多" })); await settle();
    expect(screen.getAllByRole("listitem")).toHaveLength(3); expect(screen.getByText(last.question)).toBeTruthy();
    const pages = fetch.mock.calls.filter(([url]) => url.includes("cursor=")); expect(pages).toHaveLength(2); expect(pages[0]![0]).toBe(pages[1]![0]);
  });

  it("按题型和关键词筛选后拒绝串结果，等待和失败都不显示旧题", async () => {
    install([{ items: [row], nextCursor: null }, { items: [row], nextCursor: null }, { items: [{ ...row, kind: "behavior", question: "C++ / C# <T> &amp;" }], nextCursor: null }]);
    render(<Page />); await settle(); expect(screen.getByText(row.question)).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "按题型过滤" }), { target: { value: "behavior" } });
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索题库" }), { target: { value: "c++ / c# <T> &amp;" } });
    expect(screen.queryByText(row.question)).toBeNull(); await settle();
    expect(screen.queryByText(row.question)).toBeNull(); expect(screen.getByRole("alert").textContent).toContain("题库读取响应");
    fireEvent.click(screen.getByRole("button", { name: "重试加载" })); await settle();
    expect(screen.getByText("C++ / C# <T> &amp;")).toBeTruthy(); expect(screen.queryByRole("alert")).toBeNull();
  });
});
