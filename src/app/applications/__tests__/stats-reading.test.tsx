// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Page from "../page";
import { jsonFetch } from "@/lib/fetcher";
import { mockSearchParamNavigation } from "../../../../tests/support/next-search-params";
import { applicationStatsFixture } from "../../../../tests/support/application-stats";

vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
vi.mock("next/navigation", async () => ({ useSearchParams: (await import("../../../../tests/support/next-search-params")).useTestSearchParams }));
vi.mock("@/components/application/application-dialog", () => ({
  ApplicationDialog: ({ onSuccess }: { onSuccess: () => void }) => <button onClick={onSuccess}>合成保存完成</button>,
}));

function stats(count: number) {
  const apps = Array.from({ length: count }, (_, index) => ({ id: index + 1, stage: "interested" as const,
    batch_name: "", hiring_stage: null, terminal_stage: null, terminal_reason: "", stage_history: [] }));
  return applicationStatsFixture(apps);
}
const reads = () => vi.mocked(jsonFetch).mock.calls.filter(([url]) => url === "/api/applications/stats");
const card = () => screen.getByText("总跟进意向/投递", { exact: true }).parentElement!;
const tab = () => screen.getByRole("tab", { name: /看板模式/ });
const save = () => { fireEvent.click(screen.getByRole("button", { name: /登记新投递/ })); fireEvent.click(screen.getByRole("button", { name: "合成保存完成" })); };

beforeEach(() => {
  mockSearchParamNavigation(); window.history.replaceState(null, "", "/applications?view=funnel");
  vi.mocked(jsonFetch).mockReset().mockImplementation(async url => url === "/api/applications/stats" ? stats(0) as never : { items: [], nextCursor: null } as never);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("等待与失败没有假零，重复点击只重读一次，成功空统计才显示零", async () => {
  const initial = Promise.withResolvers<unknown>(), retry = Promise.withResolvers<unknown>();
  vi.mocked(jsonFetch).mockImplementation(url => url === "/api/applications/stats" ? reads().length === 1 ? initial.promise as never : retry.promise as never : Promise.resolve({ items: [], nextCursor: null }) as never);
  render(<Page />);
  expect(screen.getByRole("status", { name: "正在加载投递统计…" })).toBeTruthy();
  expect(tab().textContent).not.toContain("0");
  await act(async () => initial.reject(new Error("统计不可用")));
  expect(screen.getByRole("alert").textContent).toContain("统计不可用");
  expect(tab().textContent).not.toContain("0");
  const button = screen.getByRole("button", { name: "重试统计" });
  act(() => { button.click(); button.click(); });
  expect(reads()).toHaveLength(2);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("status", { name: "正在加载投递统计…" })).toBeTruthy();
  await act(async () => retry.resolve(stats(0)));
  expect(tab().textContent).toContain("0");
  expect(card().textContent).toContain("0条记录");
  expect(reads().every(([, options]) => options?.cache === "no-store" && options.signal instanceof AbortSignal)).toBe(true);
  expect(vi.mocked(jsonFetch).mock.calls.some(([, options]) => options?.method && options.method !== "GET")).toBe(false);
});

it("列表未完成或失败不阻挡成功统计，切回看板显示对应列表错误", async () => {
  const list = Promise.withResolvers<unknown>();
  vi.mocked(jsonFetch).mockImplementation(url => url === "/api/applications/stats" ? Promise.resolve(stats(2)) as never : list.promise as never);
  render(<Page />); await screen.findByRole("region", { name: "投递统计概览" });
  expect(card().textContent).toContain("2条记录");
  expect(screen.queryByRole("status", { name: "正在加载求职数据..." })).toBeNull();
  await waitFor(() => expect(vi.mocked(jsonFetch).mock.calls.some(([url]) => url === "/api/applications")).toBe(true));
  await act(async () => list.reject(new Error("列表不可用")));
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(tab());
  expect((await screen.findByRole("alert")).textContent).toContain("列表不可用");
  expect(reads()).toHaveLength(1);
});

it("更新失败明确标记旧统计，成功重读恢复新的计数", async () => {
  vi.mocked(jsonFetch).mockImplementation(async url => {
    if (url !== "/api/applications/stats") return { items: [], nextCursor: null } as never;
    if (reads().length === 2) throw new Error("更新不可用");
    return stats(reads().length === 1 ? 1 : 2) as never;
  });
  render(<Page />); await screen.findByRole("region", { name: "投递统计概览" });
  save();
  expect((await screen.findByRole("alert")).textContent).toContain("上次读取的统计");
  expect(card().textContent).toContain("1条记录");
  expect(tab().textContent).not.toContain("1");
  fireEvent.click(screen.getByRole("button", { name: "重试统计" }));
  await waitFor(() => expect(card().textContent).toContain("2条记录"));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(tab().textContent).toContain("2");
});

for (const outcome of ["success", "failure"] as const) for (const order of ["before", "after"] as const) {
  it(`旧请求 ${outcome} 在新请求 ${order} 完成时不改变新数据或加载状态`, async () => {
    const old = Promise.withResolvers<unknown>(), latest = Promise.withResolvers<unknown>();
    vi.mocked(jsonFetch).mockImplementation(url => url !== "/api/applications/stats" ? Promise.resolve({ items: [], nextCursor: null }) as never : reads().length === 1 ? old.promise as never : latest.promise as never);
    render(<Page />); save(); expect(reads()).toHaveLength(2);
    const finishOld = () => outcome === "success" ? old.resolve(stats(99)) : old.reject(new Error("旧请求失败"));
    if (order === "before") {
      await act(async () => finishOld());
      expect(screen.getByRole("status", { name: "正在加载投递统计…" })).toBeTruthy();
      expect(screen.queryByRole("region", { name: "投递统计概览" })).toBeNull();
      await act(async () => latest.resolve(stats(2)));
    } else {
      await act(async () => latest.resolve(stats(2)));
      await act(async () => finishOld());
    }
    expect(card().textContent).toContain("2条记录");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status", { name: "正在加载投递统计…" })).toBeNull();
  });
}

it("离页中止统计读取，迟到结果不污染重新进入的页面", async () => {
  const old = Promise.withResolvers<unknown>();
  vi.mocked(jsonFetch).mockImplementation(url => url !== "/api/applications/stats" ? Promise.resolve({ items: [], nextCursor: null }) as never : reads().length === 1 ? old.promise as never : Promise.resolve(stats(2)) as never);
  const view = render(<Page />); const signal = reads()[0]![1]!.signal!;
  view.unmount(); expect(signal.aborted).toBe(true);
  render(<Page />); await screen.findByRole("region", { name: "投递统计概览" });
  await act(async () => old.resolve(stats(99)));
  expect(card().textContent).toContain("2条记录");
});

it.each(["missing", "inconsistent"])("坏成功回包 %s 进入页内重读，成功后才显示统计", async failure => {
  const bad = stats(2);
  if (failure === "missing") Reflect.deleteProperty(bad.funnel, "hiringSteps");
  else bad.totalActive = 99;
  vi.mocked(jsonFetch).mockImplementation(async url => url !== "/api/applications/stats" ? { items: [], nextCursor: null } as never : (reads().length === 1 ? bad : stats(2)) as never);
  render(<Page />);
  expect((await screen.findByRole("alert")).textContent).toContain("投递统计不完整或不一致");
  expect(screen.queryByRole("region", { name: "投递统计概览" })).toBeNull();
  expect(tab().textContent).not.toMatch(/\d/);
  fireEvent.click(screen.getByRole("button", { name: "重试统计" }));
  await waitFor(() => expect(card().textContent).toContain("2条记录"));
  expect(screen.queryByRole("alert")).toBeNull(); expect(reads()).toHaveLength(2);
});

it("更新收到坏成功回包时保留完整旧统计并标明，重读恢复新统计", async () => {
  vi.mocked(jsonFetch).mockImplementation(async url => {
    if (url !== "/api/applications/stats") return { items: [], nextCursor: null } as never;
    const data = stats(reads().length === 1 ? 1 : 2);
    if (reads().length === 2) Reflect.deleteProperty(data, "batchStats");
    return data as never;
  });
  render(<Page />); await screen.findByRole("region", { name: "投递统计概览" });
  save();
  expect((await screen.findByRole("alert")).textContent).toMatch(/上次读取的统计.*投递统计不完整或不一致/);
  expect(card().textContent).toContain("1条记录");
  fireEvent.click(screen.getByRole("button", { name: "重试统计" }));
  await waitFor(() => expect(card().textContent).toContain("2条记录"));
  expect(screen.queryByRole("alert")).toBeNull(); expect(reads()).toHaveLength(3);
});
