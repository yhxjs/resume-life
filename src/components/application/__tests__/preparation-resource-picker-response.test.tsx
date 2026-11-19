// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PreparationResourcePicker } from "../preparation-resource-picker";
import { jsonFetch } from "@/lib/fetcher";
import { PREPARATION_KINDS, type PreparationKind, type PreparationResource } from "@/lib/application-preparation-types";

vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
const item = (id: number, kind: PreparationKind = "intro"): PreparationResource => ({
  id, title: `资料${id}`, summary: "Array<T>、<template>、&amp;，尚未上线", created_at: "历史时间原话", resume_id: null, linked: false,
  href: kind === "intro" ? `/intros/${id}` : kind === "portrait" ? `/tools/jd/${id}` : kind === "interview" ? `/interviews/${id}` : kind === "series" ? `/interviews/series/${id}` : null,
});
const page = () => ({ items: [item(8), item(7)], nextCursor: "7", total: 3 });
const props = { applicationId: 8, kind: "intro" as const, onClose: vi.fn(), onSelect: vi.fn<(id: number) => Promise<boolean>>() };
beforeEach(() => { vi.mocked(jsonFetch).mockReset(); props.onClose.mockReset(); props.onSelect.mockReset(); });
afterEach(cleanup);

const badPages = [
  { name: "非法 ID", make: () => ({ ...page(), items: [{ ...item(8), id: 0 }] }) },
  { name: "缺少摘要", make: () => ({ ...page(), items: [{ ...item(8), summary: undefined }] }) },
  { name: "缺少时间", make: () => ({ ...page(), items: [{ ...item(8), created_at: undefined }] }) },
  { name: "串资料链接", make: () => ({ ...page(), items: [{ ...item(8), href: "/tools/jd/8" }] }) },
  { name: "重复条目", make: () => ({ ...page(), items: [item(8), item(8)], nextCursor: "8" }) },
  { name: "倒置顺序", make: () => ({ ...page(), items: [item(7), item(8)], nextCursor: "8" }) },
  { name: "错误游标", make: () => ({ ...page(), nextCursor: "6" }) },
  { name: "已关联条目", make: () => ({ ...page(), items: [{ ...item(8), linked: true }], nextCursor: "8" }) },
  { name: "空页带游标", make: () => ({ ...page(), items: [], nextCursor: "7" }) },
];
it.each(badPages)("首页$name 整页拒绝，只重读候选而不写入", async ({ make }) => {
  vi.mocked(jsonFetch).mockResolvedValueOnce(make()).mockResolvedValueOnce({ items: [item(8)], nextCursor: null });
  render(<PreparationResourcePicker {...props} />);
  await screen.findByRole("button", { name: "重试加载列表" });
  expect(screen.queryByRole("button", { name: "关联" })).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("alert")));
  fireEvent.click(screen.getByRole("button", { name: "重试加载列表" }));
  await screen.findByText("资料8");
  expect(jsonFetch).toHaveBeenCalledTimes(2);
  expect(props.onSelect).not.toHaveBeenCalled();
});

it.each(badPages)("续页$name 保留旧候选和原游标，再读原页才追加", async ({ make }) => {
  vi.mocked(jsonFetch).mockResolvedValueOnce({ items: [item(10)], nextCursor: "10", total: 3 })
    .mockResolvedValueOnce(make()).mockResolvedValueOnce({ items: [item(9)], nextCursor: null });
  render(<PreparationResourcePicker {...props} />);
  await screen.findByText("资料10");
  fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
  await screen.findByRole("button", { name: "重试加载更多" });
  expect(screen.getByText("资料10")).toBeTruthy();
  expect(screen.queryByText("资料8")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "重试加载更多" }));
  await screen.findByText("资料9");
  expect(screen.getAllByRole("button", { name: "关联" })).toHaveLength(2);
  expect(vi.mocked(jsonFetch).mock.calls.slice(1).map(([url]) => url)).toEqual(Array(2).fill("/api/applications/8/preparation/resources?kind=intro&candidates=true&limit=20&cursor=10"));
  expect(props.onSelect).not.toHaveBeenCalled();
});

it("续页跨过请求边界时不能追加或吞掉游标", async () => {
  vi.mocked(jsonFetch).mockResolvedValueOnce({ items: [item(8)], nextCursor: "8" })
    .mockResolvedValueOnce({ items: [item(9)], nextCursor: null }).mockResolvedValueOnce({ items: [item(7)], nextCursor: null });
  render(<PreparationResourcePicker {...props} />); await screen.findByText("资料8");
  fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
  fireEvent.click(await screen.findByRole("button", { name: "重试加载更多" }));
  await screen.findByText("资料7"); expect(screen.queryByText("资料9")).toBeNull();
  expect(vi.mocked(jsonFetch).mock.calls.at(-1)![0]).toContain("cursor=8");
});

it.each(PREPARATION_KINDS)("%s 合法候选保留技术字面量与历史时间，选择使用原 ID", async kind => {
  vi.mocked(jsonFetch).mockResolvedValueOnce({ items: [item(8, kind)], nextCursor: null }); props.onSelect.mockResolvedValueOnce(true);
  render(<PreparationResourcePicker {...props} kind={kind} />);
  fireEvent.click(await screen.findByRole("button", { name: "关联" }));
  await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1));
  expect(props.onSelect).toHaveBeenCalledWith(8);
  expect(screen.getByText(item(8).summary).textContent).toBe(item(8).summary);
  expect(document.querySelector("template")).toBeNull();
});

it("关联结果未知后明确引导关闭核对，禁用重试与其他候选，关闭仍可用", async () => {
  vi.mocked(jsonFetch).mockResolvedValueOnce(page()); props.onSelect.mockResolvedValueOnce(false);
  const view = render(<PreparationResourcePicker {...props} />);
  fireEvent.click((await screen.findAllByRole("button", { name: "关联" }))[0]!);
  await screen.findByRole("button", { name: "重试关联" });
  view.rerender(<PreparationResourcePicker {...props} writesBlocked />);
  expect(screen.getByRole("alert").textContent).toContain("关联结果尚未确认");
  expect(screen.getByRole("alert").textContent).toContain("关闭此窗口并刷新资料核对");
  expect(screen.queryByRole("button", { name: "重试关联" })).toBeNull();
  for (const button of screen.getAllByRole("button", { name: "关联" })) { expect((button as HTMLButtonElement).disabled).toBe(true); fireEvent.click(button); }
  fireEvent.click(screen.getByRole("button", { name: "关闭" }));
  expect(props.onClose).toHaveBeenCalledTimes(1); expect(props.onSelect).toHaveBeenCalledTimes(1);
});
