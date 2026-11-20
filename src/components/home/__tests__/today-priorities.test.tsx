// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TodayPriorities } from "../today-priorities";
import { jsonFetch } from "@/lib/fetcher";
import type { HomePriorities } from "@/lib/home-priorities-contract";

vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
const data: HomePriorities = { date: "2026-11-20", items: [
  { id: "application-8", kind: "interview", title: "甲公司 · 前端工程师", reason: "今天面试，还缺自我介绍。", badge: "今天面试", urgent: true, href: "/applications/8/prepare", action: "进入面试准备" },
  { id: "reviews", kind: "review", title: "复习 3 道到期题目", reason: "其中 1 题已逾期。", badge: "1 题已逾期", urgent: true, href: "/reviews", action: "开始今日复习" },
] };
beforeEach(() => { vi.resetAllMocks(); vi.mocked(jsonFetch).mockResolvedValue(data); });
afterEach(cleanup);

it("加载不宣称完成，按服务端顺序显示有限行动与准确入口", async () => {
  render(<TodayPriorities />);
  expect(screen.getByText("正在整理今天的重点…")).toBeTruthy();
  expect(screen.queryByText("今天暂时没有需要优先处理的事项")).toBeNull();
  const list = await screen.findByRole("list", { name: "今日重点排序" });
  expect(within(list).getAllByRole("listitem")).toHaveLength(2);
  expect(within(list).getAllByRole("heading").map(item => item.textContent)).toEqual(data.items.map(item => item.title));
  expect(within(list).getByRole("link", { name: /进入面试准备/ }).getAttribute("href")).toBe("/applications/8/prepare");
  expect(within(list).getByRole("link", { name: /开始今日复习/ }).getAttribute("href")).toBe("/reviews");
  expect(vi.mocked(jsonFetch).mock.calls[0]![0]).toContain("time_zone=");
});

it("真正无任务时提供投递和复习入口", async () => {
  vi.mocked(jsonFetch).mockResolvedValue({ ...data, items: [] });
  render(<TodayPriorities />);
  expect(await screen.findByText("今天暂时没有需要优先处理的事项")).toBeTruthy();
  expect(screen.queryByRole("list", { name: "今日重点排序" })).toBeNull();
  expect(screen.getByRole("link", { name: /管理投递/ }).getAttribute("href")).toBe("/applications");
});

it.each([null, { date: "2026-11-20" }, { ...data, items: [...data.items, ...data.items] },
  { ...data, items: [{ ...data.items[0], href: "https://example.com" }] }])("坏成功回包显示重试，重读后恢复", async value => {
  vi.mocked(jsonFetch).mockResolvedValueOnce(value);
  render(<TodayPriorities />);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("暂时无法读取"));
  expect(screen.queryByText("今天暂时没有需要优先处理的事项")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "重试读取今日重点" }));
  expect(await screen.findByRole("list")).toBeTruthy();
});

it("完成复习或重新聚焦后刷新，读取失败不保留失效推荐或泄露错误", async () => {
  render(<TodayPriorities />);
  await screen.findByRole("list");
  vi.mocked(jsonFetch).mockResolvedValueOnce({ ...data, items: [data.items[0]] });
  fireEvent(window, new Event("reviews-updated"));
  await waitFor(() => expect(screen.queryByText("复习 3 道到期题目")).toBeNull());
  vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("private database path"));
  fireEvent(window, new Event("focus"));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByRole("list")).toBeNull();
  expect(screen.queryByText("private database path")).toBeNull();
});

it("刷新取消旧请求，晚到的旧结果不能覆盖已完成的任务", async () => {
  const pending = Promise.withResolvers<unknown>();
  vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
  const view = render(<TodayPriorities />);
  await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(1));
  const signal = vi.mocked(jsonFetch).mock.calls[0]![1]!.signal!;
  vi.mocked(jsonFetch).mockResolvedValueOnce({ ...data, items: [] });
  fireEvent(window, new Event("focus"));
  await screen.findByText("今天暂时没有需要优先处理的事项");
  expect(signal.aborted).toBe(true);
  await act(async () => pending.resolve(data));
  expect(screen.queryByRole("list")).toBeNull();
  const lastSignal = vi.mocked(jsonFetch).mock.calls[1]![1]!.signal!;
  view.unmount();
  expect(lastSignal.aborted).toBe(true);
});
