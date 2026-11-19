// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import Page from "../page";
import { jsonFetch } from "@/lib/fetcher";

const state = vi.hoisted(() => ({ records: [] as { id: number; jd: string; result: string; created_at: string }[], push: vi.fn(), reload: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
vi.mock("@/hooks/use-cursor-list", () => ({ useCursorList: () => ({
  items: state.records, total: state.records.length, nextCursor: null, loadingMore: false,
  listError: "", failedCursor: null, loadMore: vi.fn(), reload: state.reload,
}) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
beforeEach(() => { state.records = []; vi.mocked(jsonFetch).mockReset(); });

describe("JD 历史列表的损坏数据恢复", () => {
  it.each([
    { role: { broken: true }, mustSkills: [] },
    { role: "残缺画像标题", mustSkills: [null], followups: [], companyStyle: { style: "信息不足", signals: [] } },
  ])("损坏画像仍显示原 JD 标题与详情入口，不渲染失效考点（%#）", (result) => {
    state.records = [{ id: 17, jd: "原 JD <T> &amp;\n只维护已有平台", result: JSON.stringify(result), created_at: "2026-10-28" }];
    render(<Page />);
    expect(screen.getByRole("link", { name: "原 JD <T> &amp;" }).getAttribute("href")).toBe("/tools/jd/17");
    expect(screen.getByRole("link", { name: "查看画像" }).getAttribute("href")).toBe("/tools/jd/17");
    expect(screen.queryByText("残缺画像标题")).toBeNull();
    expect(jsonFetch).not.toHaveBeenCalled();
  });
});

it("只提交一次原 JD，等待与导航期间禁用替换，口径与准备建议一致", async () => {
  const pending = Promise.withResolvers<unknown>();
  vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
  render(<Page />);
  const input = screen.getByRole("textbox", { name: "岗位要求（JD）" });
  fireEvent.change(input, { target: { value: "  React 或 Vue\n不要求 Java <T> &amp;  " } });
  const generate = screen.getByRole("button", { name: "生成准备画像 →" });
  fireEvent.click(generate);
  fireEvent.click(generate);
  expect(jsonFetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(vi.mocked(jsonFetch).mock.calls[0]![1]!.body as string)).toEqual({ jd: "React 或 Vue\n不要求 Java <T> &amp;" });
  expect((input as HTMLTextAreaElement).disabled).toBe(true);
  for (const name of ["大厂资深前端/架构", "高并发分布式后端", "AI+全栈应用开发"]) {
    expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
  }
  expect(screen.getByRole("status").textContent).toContain("仅依据本次 JD");
  expect(screen.getByRole("status").textContent).not.toMatch(/必考|15-20 秒|企业技术文化/);
  await act(async () => pending.resolve({ id: 17 }));
  expect(state.push).toHaveBeenCalledExactlyOnceWith("/tools/jd/17");
  expect((screen.getByRole("button", { name: "AI 正在整理准备建议…" }) as HTMLButtonElement).disabled).toBe(true);
});

it.each([null, {}, { id: "17" }, { id: 0 }, { id: -1 }, { id: 1.5 }, { id: Number.MAX_SAFE_INTEGER + 1 }])("拒绝无效成功 ID，保留 JD 并重读历史（%j）", async (response) => {
  vi.mocked(jsonFetch).mockResolvedValueOnce(response);
  render(<Page />);
  fireEvent.change(screen.getByRole("textbox", { name: "岗位要求（JD）" }), { target: { value: "原 JD <template> &amp;" } });
  fireEvent.click(screen.getByRole("button", { name: "生成准备画像 →" }));
  await screen.findByRole("alert");
  expect(state.push).not.toHaveBeenCalled();
  expect(state.reload).toHaveBeenCalledTimes(1);
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("原 JD <template> &amp;");
  expect(screen.getByRole("alert").textContent).toContain("请先核对历史再重新生成");
});

it.each(["success", "failure"])("离开后旧请求 %s 不导航、刷新列表或干扰新页面", async (outcome) => {
  const old = Promise.withResolvers<unknown>();
  const next = Promise.withResolvers<unknown>();
  vi.mocked(jsonFetch).mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
  render(<Page />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "旧 JD" } });
  fireEvent.click(screen.getByRole("button", { name: "生成准备画像 →" }));
  const signal = vi.mocked(jsonFetch).mock.calls[0]![1]!.signal;
  cleanup();
  expect(signal?.aborted).toBe(true);
  render(<Page />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "新 JD" } });
  fireEvent.click(screen.getByRole("button", { name: "生成准备画像 →" }));
  await act(async () => { if (outcome === "success") old.resolve({ id: 1 }); else old.reject(new Error("旧请求失败")); });
  expect(state.push).not.toHaveBeenCalled();
  expect(state.reload).not.toHaveBeenCalled();
  expect(screen.queryByRole("alert")).toBeNull();
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("新 JD");
  await act(async () => next.resolve({ id: 2 }));
  expect(state.push).toHaveBeenCalledExactlyOnceWith("/tools/jd/2");
});

it("生成失败后解锁并保留 JD，显式重试只清理输入首尾", async () => {
  vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("上游暂不可用")).mockResolvedValueOnce({ id: 8 });
  render(<Page />);
  const original = "  JD <T> &amp;\n仅维护现有服务。  ";
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: original } });
  fireEvent.click(screen.getByRole("button", { name: "生成准备画像 →" }));
  await screen.findByText("上游暂不可用");
  expect(input.value).toBe(original); expect(input.disabled).toBe(false);
  expect((screen.getByRole("button", { name: "生成准备画像 →" }) as HTMLButtonElement).disabled).toBe(false);
  expect(state.push).not.toHaveBeenCalled(); expect(state.reload).toHaveBeenCalledOnce();
  expect(JSON.parse(vi.mocked(jsonFetch).mock.calls[0]![1]!.body as string)).toEqual({ jd: original.trim() });
  fireEvent.click(screen.getByRole("button", { name: "生成准备画像 →" }));
  await act(async () => {});
  expect(state.push).toHaveBeenCalledExactlyOnceWith("/tools/jd/8");
  expect(jsonFetch).toHaveBeenCalledTimes(2);
  expect(JSON.parse(vi.mocked(jsonFetch).mock.calls[1]![1]!.body as string)).toEqual({ jd: original.trim() });
});
