// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PreparationResourcePicker } from "../preparation-resource-picker";
import { jsonFetch } from "@/lib/fetcher";
import type { PreparationResource } from "@/lib/application-preparation-types";

vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
const item = (id: number, kind = "intro"): PreparationResource => ({ id, title: `候选资料${id}`, summary: "Array<T>、<template>、&amp; 原文", created_at: "", resume_id: null, href: kind === "intro" ? `/intros/${id}` : null, linked: false });
const props = { applicationId: 8, kind: "intro" as const, onClose: vi.fn(), onSelect: vi.fn<(id: number) => Promise<boolean>>() };
beforeEach(() => { vi.mocked(jsonFetch).mockReset().mockImplementation(async url => ({ items: [item(8, url.includes("kind=notebook") ? "notebook" : "intro"), item(7, url.includes("kind=notebook") ? "notebook" : "intro")], nextCursor: null }) as never); props.onClose.mockReset(); props.onSelect.mockReset(); });
afterEach(cleanup);

it("同一帧连续选择两份资料只执行第一次关联，关闭也不能越过在途操作", async () => {
  const pending = Promise.withResolvers<boolean>();
  props.onSelect.mockReturnValue(pending.promise);
  render(<PreparationResourcePicker {...props} />);
  const buttons = await screen.findAllByRole("button", { name: "关联" });
  const close = screen.getByRole("button", { name: "关闭" });
  act(() => { fireEvent.click(buttons[0]!); fireEvent.click(buttons[1]!); fireEvent.click(close); });
  expect(props.onSelect).toHaveBeenCalledTimes(1);
  expect(props.onSelect).toHaveBeenCalledWith(8);
  expect(props.onClose).not.toHaveBeenCalled();
  await act(async () => pending.resolve(true));
  expect(props.onClose).toHaveBeenCalledTimes(1);
});

it("关联失败后的重试仍关联原资料，不把列表 GET 当成重试关联", async () => {
  props.onSelect.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  render(<PreparationResourcePicker {...props} />);
  fireEvent.click((await screen.findAllByRole("button", { name: "关联" }))[0]!);
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: /重试/ }));
  await waitFor(() => expect(props.onSelect).toHaveBeenCalledTimes(2));
  expect(props.onSelect.mock.calls.map(([id]) => id)).toEqual([8, 8]);
  expect(jsonFetch).toHaveBeenCalledTimes(1);
  expect(props.onClose).toHaveBeenCalledTimes(1);
});

it.each(["投递", "资料类型"].flatMap((change) => [true, false].map((outcome) => ({ change, outcome }))))(
  "切换$change 后忽略旧关联返回 $outcome，不关闭新弹窗或保留旧忙碌状态", async ({ change, outcome }) => {
    const pending = Promise.withResolvers<boolean>();
    props.onSelect.mockReturnValueOnce(pending.promise);
    const view = render(<PreparationResourcePicker {...props} />);
    fireEvent.click((await screen.findAllByRole("button", { name: "关联" }))[0]!);
    view.rerender(<PreparationResourcePicker {...props} applicationId={change === "投递" ? 9 : 8} kind={change === "资料类型" ? "notebook" : "intro"} />);
    const buttons = await screen.findAllByRole("button", { name: "关联" });
    expect((buttons[0] as HTMLButtonElement).disabled).toBe(false);
    await act(async () => pending.resolve(outcome));
    expect(props.onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  }
);

it("卸载后晚到的关联成功不再触发关闭", async () => {
  const pending = Promise.withResolvers<boolean>();
  props.onSelect.mockReturnValueOnce(pending.promise);
  const view = render(<PreparationResourcePicker {...props} />);
  fireEvent.click((await screen.findAllByRole("button", { name: "关联" }))[0]!);
  view.unmount();
  await act(async () => pending.resolve(true));
  expect(props.onClose).not.toHaveBeenCalled();
});

it("下一页读取失败时从失败游标重试，保留已载入候选", async () => {
  let pages = 0;
  vi.mocked(jsonFetch).mockImplementation(async (url) => {
    if (url.includes("cursor=")) {
      if (++pages === 1) throw new Error("下一页暂不可用");
      return { items: [item(1)], nextCursor: null } as never;
    }
    return { items: [item(8)], nextCursor: "8" } as never;
  });
  render(<PreparationResourcePicker {...props} />);
  await screen.findByText("候选资料8");
  fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: /重试/ }));
  await screen.findByText("候选资料1");
  expect(screen.getByText("候选资料8")).toBeTruthy();
  expect(pages).toBe(2);
  expect(vi.mocked(jsonFetch).mock.calls.at(-1)![0]).toContain("cursor=8");
});

it("关联回调抛错时显示可读错误并释放互斥，重试仍使用原 ID", async () => {
  props.onSelect.mockRejectedValueOnce(new Error("服务器拒绝关联")).mockResolvedValueOnce(true);
  render(<PreparationResourcePicker {...props} />);
  fireEvent.click((await screen.findAllByRole("button", { name: "关联" }))[0]!);
  expect((await screen.findByRole("alert")).textContent).toContain("服务器拒绝关联");
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("alert")));
  expect((screen.getByRole("button", { name: "关闭" }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "重试关联" }));
  await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1));
  expect(props.onSelect.mock.calls.map(([id]) => id)).toEqual([8, 8]);
  expect(jsonFetch).toHaveBeenCalledTimes(1);
});

it("首次候选读取失败只重读列表，关联按钮保留原文中的技术字面量", async () => {
  vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("候选读取失败")).mockResolvedValueOnce({ items: [item(8)], nextCursor: null });
  render(<PreparationResourcePicker {...props} />);
  expect((await screen.findByRole("alert")).textContent).toContain("候选读取失败");
  fireEvent.click(screen.getByRole("button", { name: "重试加载列表" }));
  await screen.findByText("候选资料8");
  expect(screen.getByText(item(8).summary).textContent).toBe(item(8).summary);
  expect(document.querySelector("template")).toBeNull();
  expect(props.onSelect).not.toHaveBeenCalled();
  expect(vi.mocked(jsonFetch).mock.calls.map(([url]) => url)).toEqual(Array(2).fill("/api/applications/8/preparation/resources?kind=intro&candidates=true&limit=20"));
});

it("失败后选择另一份资料会清除旧错误，不继续重试旧 ID", async () => {
  props.onSelect.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  render(<PreparationResourcePicker {...props} />);
  fireEvent.click((await screen.findAllByRole("button", { name: "关联" }))[0]!);
  await screen.findByRole("alert");
  fireEvent.click(screen.getAllByRole("button", { name: "关联" })[1]!);
  await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1));
  expect(props.onSelect.mock.calls.map(([id]) => id)).toEqual([8, 7]);
  expect(screen.queryByRole("alert")).toBeNull();
});

it.each(["成功", "未完成", "抛错"])("切换类型后旧操作晚到%s，不解除新关联的忙碌状态或覆盖新错误", async (outcome) => {
  const old = Promise.withResolvers<boolean>();
  const current = Promise.withResolvers<boolean>();
  props.onSelect.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  const view = render(<PreparationResourcePicker {...props} />);
  fireEvent.click((await screen.findAllByRole("button", { name: "关联" }))[0]!);
  view.rerender(<PreparationResourcePicker {...props} kind="notebook" />);
  fireEvent.click((await screen.findAllByRole("button", { name: "关联" }))[1]!);
  await act(async () => {
    if (outcome === "抛错") old.reject(new Error("旧关联异常"));
    else old.resolve(outcome === "成功");
  });
  expect((screen.getByRole("button", { name: "关联中…" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("status").textContent).toContain("正在关联资料");
  expect(screen.queryByRole("alert")).toBeNull();
  expect(props.onClose).not.toHaveBeenCalled();
  await act(async () => current.resolve(false));
  expect((await screen.findByRole("alert")).textContent).toContain("关联失败");
  props.onSelect.mockResolvedValueOnce(true);
  fireEvent.click(screen.getByRole("button", { name: "重试关联" }));
  await waitFor(() => expect(props.onClose).toHaveBeenCalledTimes(1));
  expect(props.onSelect.mock.calls.map(([id]) => id)).toEqual([8, 7, 7]);
});

it.each(["成功", "失败"])("切换投递时取消候选读取，旧响应晚到%s不污染新候选", async (outcome) => {
  const pending = Promise.withResolvers<unknown>();
  vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ items: [item(9)], nextCursor: null });
  const view = render(<PreparationResourcePicker {...props} />);
  await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(1));
  const signal = vi.mocked(jsonFetch).mock.calls[0]![1]?.signal;
  view.rerender(<PreparationResourcePicker {...props} applicationId={9} />);
  await screen.findByText("候选资料9");
  expect(signal?.aborted).toBe(true);
  await act(async () => {
    if (outcome === "成功") pending.resolve({ items: [item(8)], nextCursor: null });
    else pending.reject(new Error("旧候选读取失败"));
  });
  expect(screen.queryByText("候选资料8")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("候选资料9")).toBeTruthy();
});

it("关联与分页重试在同一帧触发时只关联，不额外读取或提前关闭", async () => {
  let pages = 0;
  vi.mocked(jsonFetch).mockImplementation(async (url) => {
    if (url.includes("cursor=")) { pages++; throw new Error("下一页失败"); }
    return { items: [item(8)], nextCursor: "8" } as never;
  });
  const pending = Promise.withResolvers<boolean>();
  props.onSelect.mockReturnValueOnce(pending.promise);
  render(<PreparationResourcePicker {...props} />);
  const associate = (await screen.findAllByRole("button", { name: "关联" }))[0]!;
  fireEvent.click(screen.getByRole("button", { name: "加载更多" }));
  const retry = await screen.findByRole("button", { name: "重试加载更多" });
  const more = screen.getByRole("button", { name: "加载更多" });
  const close = screen.getByRole("button", { name: "关闭" });
  act(() => { fireEvent.click(associate); fireEvent.click(retry); fireEvent.click(more); fireEvent.click(close); });
  fireEvent.keyDown(document, { key: "Escape" });
  expect(pages).toBe(1);
  expect(jsonFetch).toHaveBeenCalledTimes(2);
  expect(props.onSelect).toHaveBeenCalledTimes(1);
  expect(props.onClose).not.toHaveBeenCalled();
  await act(async () => pending.resolve(true));
  expect(props.onClose).toHaveBeenCalledTimes(1);
});
