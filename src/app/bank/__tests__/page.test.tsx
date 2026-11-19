// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Page from "../page";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import { confirmDialog } from "@/components/common/confirm-dialog";

const { reload, cursorList } = vi.hoisted(() => ({ reload: vi.fn(), cursorList: vi.fn() }));
vi.mock("@/hooks/use-cursor-list", () => ({ useCursorList: cursorList }));
vi.mock("@/lib/fetcher", async original => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
vi.mock("@/components/common/confirm-dialog", () => ({ confirmDialog: vi.fn(), alertDialog: vi.fn() }));
vi.mock("@/components/common/combobox", () => ({ Combobox: ({ value, onChange, ariaLabel }: { value: string; onChange: (value: string) => void; ariaLabel: string }) => <input aria-label={ariaLabel} value={value} onChange={event => onChange(event.target.value)} /> }));

const raw = "  C++ / C# <T> &amp; 的边界？  \r\n\n如何核对实际结果？\nC++ / C# <T> &amp; 的边界？  ";
const pending = <T,>() => { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const posts = () => vi.mocked(jsonFetch).mock.calls.filter(([, options]) => options?.method === "POST");
const draft = () => screen.getByRole("textbox", { name: "导入考题" }) as HTMLTextAreaElement;
const submit = () => screen.getByRole("button", { name: /^导入 / }) as HTMLButtonElement;

function fill() {
  fireEvent.change(screen.getByRole("textbox", { name: "导入方向" }), { target: { value: "  后端:基础  " } });
  fireEvent.change(draft(), { target: { value: raw } });
}

beforeEach(() => {
  cursorList.mockReturnValue({ items: [], nextCursor: null, loadingMore: false, listError: "", failedCursor: undefined, loadMore: vi.fn(), reload });
  vi.mocked(jsonFetch).mockImplementation(async (url, options) => {
    if (options?.method === "POST") return { count: 2 } as never;
    if (url === "/api/bank/directions") return [] as never;
    return { items: [], nextCursor: null } as never;
  });
  vi.mocked(confirmDialog).mockResolvedValue(true);
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

const saved = { id: 7, direction: "C++ / C# <T> &amp;", kind: "legacy-kind", question: "原题内部  空格 <T> &amp;？", created_at: "2026-10-29" };
function withEntries() {
  cursorList.mockReturnValue({ items: [saved, { ...saved, id: 6, question: "另一题必须保留" }], nextCursor: null, loadingMore: false, listError: "", failedCursor: undefined, loadMore: vi.fn(), reload });
}
const deletes = () => vi.mocked(jsonFetch).mock.calls.filter(([, options]) => options?.method === "DELETE");

describe("题库删除的对象确认与恢复", () => {
  it("删除该方向最后一题、统计不再返回方向后仍能清除筛选，保留导入原稿", async () => {
    cursorList.mockReturnValue({ items: [saved], nextCursor: null, loadingMore: false, listError: "", failedCursor: undefined, loadMore: vi.fn(), reload });
    let directionReads = 0;
    vi.mocked(jsonFetch).mockImplementation(async (url, options) => {
      if (options?.method === "DELETE") return { ok: true } as never;
      if (url === "/api/bank/directions") return (++directionReads === 1 ? [{ direction: saved.direction, count: 1 }] : []) as never;
      return [] as never;
    });
    render(<Page />); fill(); fireEvent.click(await screen.findByRole("button", { name: `${saved.direction} (1)` }));
    expect(JSON.parse(cursorList.mock.calls.at(-1)![0].queryKey)[1]).toBe(saved.direction);
    fireEvent.click(screen.getByRole("button", { name: "删除" })); await waitFor(() => expect(directionReads).toBe(2));
    await waitFor(() => expect(screen.queryByRole("button", { name: `${saved.direction} (1)` })).toBeNull());
    expect(screen.getByText(/当前方向/).textContent).toContain(saved.direction);
    fireEvent.click(screen.getByRole("button", { name: "全部方向" }));
    expect(JSON.parse(cursorList.mock.calls.at(-1)![0].queryKey)[1]).toBe("");
    expect(draft().value).toBe(raw.replace(/\r\n/g, "\n")); expect(posts()).toHaveLength(0);
  });

  it("同一事件重复删除只确认一次，完整展示对象，取消零写入并保留草稿", async () => {
    withEntries(); const confirmation = pending<boolean>(); vi.mocked(confirmDialog).mockReturnValueOnce(confirmation.promise);
    render(<Page />); fill(); const buttons = screen.getAllByRole("button", { name: "删除" }); const importButton = submit();
    act(() => { buttons[0]!.click(); importButton.click(); buttons[0]!.click(); buttons[1]!.click(); });
    expect(confirmDialog).toHaveBeenCalledTimes(1);
    expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({ title: "删除题目", message: expect.stringContaining(`#7`) }));
    for (const value of [saved.question, saved.direction, saved.kind]) expect(vi.mocked(confirmDialog).mock.calls[0]![0].message).toContain(value);
    expect(submit().disabled).toBe(true); expect(draft().matches(":disabled")).toBe(true);
    await act(async () => { confirmation.resolve(false); });
    expect(deletes()).toHaveLength(0); expect(posts()).toHaveLength(0); expect(reload).not.toHaveBeenCalled();
    expect(submit().disabled).toBe(false); expect(draft().value).toBe(raw.replace(/\r\n/g, "\n"));
  });

  it("坏成功响应只读核对，503 与串题保持锁，404 完成后旧列表不复活", async () => {
    withEntries(); let checks = 0;
    vi.mocked(jsonFetch).mockImplementation(async (url, options) => {
      if (url === "/api/bank/directions") return [] as never;
      if (options?.method === "DELETE") return { ok: "true" } as never;
      checks++; if (checks === 1) throw new HttpError("核对暂不可用", 503);
      if (checks === 2) return { ...saved, id: 6 } as never;
      throw new HttpError("题目不存在", 404);
    });
    render(<Page />); fill(); fireEvent.click(screen.getAllByRole("button", { name: "删除" })[0]!);
    await screen.findByRole("button", { name: "重新读取删除状态" });
    expect(screen.getByRole("alert").textContent).toContain("尚未确认"); expect(submit().disabled).toBe(true);
    fireEvent.click(screen.getAllByRole("button", { name: "删除" })[1]!); fireEvent.click(submit());
    expect(deletes()).toHaveLength(1); expect(posts()).toHaveLength(0);
    fireEvent.change(draft(), { target: { value: "不能替换" } }); expect(draft().value).toBe(raw.replace(/\r\n/g, "\n"));
    fireEvent.click(screen.getByRole("button", { name: "重新读取删除状态" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("不符")); expect(submit().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "重新读取删除状态" }));
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(screen.queryByText(saved.question)).toBeNull(); expect(screen.getByText("另一题必须保留")).toBeTruthy();
    expect(screen.getByText(/当前筛选显示/).textContent).toContain("1"); expect(submit().disabled).toBe(false);
    expect(draft().value).toBe(raw.replace(/\r\n/g, "\n")); expect(deletes()).toHaveLength(1);
    for (const [url, options] of vi.mocked(jsonFetch).mock.calls.filter(([url, options]) => url === "/api/bank/7" && options?.method !== "DELETE")) {
      expect(url).toBe("/api/bank/7"); expect(options).toMatchObject({ cache: "no-store", signal: expect.any(AbortSignal) });
    }
  });

  it("导入从同步提交起阻止删除，未知导入状态同样互斥", async () => {
    withEntries(); const response = pending<unknown>();
    vi.mocked(jsonFetch).mockImplementation(async (url, options) => options?.method === "POST" ? response.promise as never : url === "/api/bank/directions" ? [] as never : { items: [], nextCursor: null } as never);
    render(<Page />); fill(); const remove = screen.getAllByRole("button", { name: "删除" })[0]!;
    act(() => { submit().click(); remove.click(); });
    expect(posts()).toHaveLength(1); expect(confirmDialog).not.toHaveBeenCalled(); expect(remove.matches(":disabled")).toBe(true);
    await act(async () => { response.resolve({ count: 99 }); });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("导入结果尚未确认"));
    fireEvent.click(remove); expect(deletes()).toHaveLength(0); expect(confirmDialog).not.toHaveBeenCalled();
  });

  it("已加载的最后一题被删除时仍可加载后续页，不误报全题库为空", async () => {
    const loadMore = vi.fn();
    cursorList.mockReturnValue({ items: [saved], nextCursor: "7", loadingMore: false, listError: "", failedCursor: undefined, loadMore, reload });
    vi.mocked(jsonFetch).mockImplementation(async (_url, options) => options?.method === "DELETE" ? { ok: true } as never : [] as never);
    render(<Page />); fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(screen.queryByText(saved.question)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "加载更多" })); expect(loadMore).toHaveBeenCalledOnce();
    expect(screen.queryByText(/题库还是空的/)).toBeNull(); expect(screen.getByText(/继续加载更早题目/)).toBeTruthy();
  });
});

describe("题库导入的原稿与写入边界", () => {
  it("同一事件两次提交只发一次 POST，等待期间锁定所有改写入口", async () => {
    const response = pending<{ count: number }>();
    vi.mocked(jsonFetch).mockImplementation(async (_url, options) => options?.method === "POST" ? response.promise as never : [] as never);
    render(<Page />); fill(); const button = submit();
    act(() => { button.click(); button.click(); });
    expect(posts()).toHaveLength(1);
    for (const element of [draft(), screen.getByRole("textbox", { name: "导入方向" }), screen.getByRole("button", { name: "八股" }), screen.getByRole("button", { name: "行为" }), screen.getByRole("button", { name: "技术八股" }), screen.getByRole("button", { name: "综合行为" })]) expect(element.matches(":disabled")).toBe(true);
    expect(posts()[0]?.[1]).toMatchObject({ body: JSON.stringify({ direction: "后端:基础", kind: "tech", text: raw.replace(/\r\n/g, "\n") }), signal: expect.any(AbortSignal) });
    await act(async () => { response.resolve({ count: 2 }); await response.promise; });
    expect(draft().value).toBe(""); expect(screen.getByRole("status").textContent).toContain("成功导入 2 道题");
  });

  it("等待期间合成输入与示例事件不能改写已提交原稿、方向或题型", async () => {
    const response = pending<{ count: number }>();
    vi.mocked(jsonFetch).mockImplementation(async (_url, options) => options?.method === "POST" ? response.promise as never : [] as never);
    render(<Page />); fill(); fireEvent.click(submit());
    fireEvent.change(draft(), { target: { value: "不应替换原稿" } });
    fireEvent.change(screen.getByRole("textbox", { name: "导入方向" }), { target: { value: "另一方向" } });
    fireEvent.click(screen.getByRole("button", { name: "综合行为" }));
    expect(draft().value).toBe(raw.replace(/\r\n/g, "\n"));
    expect((screen.getByRole("textbox", { name: "导入方向" }) as HTMLInputElement).value).toBe("  后端:基础  ");
    await act(async () => { response.resolve({ count: 2 }); await response.promise; });
    expect(screen.getByRole("status").textContent).toContain("后端:基础"); expect(posts()).toHaveLength(1);
  });

  it.each([null, {}, [], { count: 0 }, { count: 1 }, { count: 3 }, { count: "2" }, { count: -2 }, { count: 1.5 }].map(response => [response]))("完成响应 %j 不清稿，不显示成功或自动重发", async response => {
    vi.mocked(jsonFetch).mockImplementation(async (url, options) => options?.method === "POST" ? response as never : url === "/api/bank/directions" ? [] as never : { items: [], nextCursor: null } as never);
    render(<Page />); fill(); fireEvent.click(submit());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("导入结果尚未确认"));
    expect(draft().value).toBe(raw.replace(/\r\n/g, "\n")); expect(submit().disabled).toBe(true); expect(posts()).toHaveLength(1);
    expect(screen.queryByText(/成功导入/)).toBeNull();
  });

  it("离页中止等待，迟到成功不能清稿、刷新新页或显示通知", async () => {
    const response = pending<{ count: number }>();
    vi.mocked(jsonFetch).mockImplementation(async (_url, options) => options?.method === "POST" ? response.promise as never : [] as never);
    const { unmount } = render(<Page />); fill(); fireEvent.click(submit());
    const signal = posts()[0]?.[1]?.signal; unmount(); expect(signal?.aborted).toBe(true);
    await act(async () => { response.resolve({ count: 2 }); await response.promise; });
    expect(reload).not.toHaveBeenCalled();
  });

  it("明确的校验失败保留完整原稿并允许修正后再次提交", async () => {
    vi.mocked(jsonFetch).mockImplementation(async (_url, options) => { if (options?.method === "POST") throw new HttpError("导入材料无效", 400); return [] as never; });
    render(<Page />); fill(); fireEvent.click(submit());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("导入材料无效"));
    expect(draft().value).toBe(raw.replace(/\r\n/g, "\n")); expect(submit().disabled).toBe(false);
  });

  it("含冒号的方向、题型和关键词不会拼成相同查询键", async () => {
    vi.mocked(jsonFetch).mockResolvedValue([{ direction: "a:tech", count: 1 }, { direction: "a", count: 1 }]);
    render(<Page />); fireEvent.click(await screen.findByRole("button", { name: "a:tech (1)" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索题库" }), { target: { value: "q" } });
    const first = cursorList.mock.calls.at(-1)?.[0].queryKey;
    fireEvent.click(screen.getByRole("button", { name: "a (1)" }));
    fireEvent.change(screen.getByRole("combobox", { name: "按题型过滤" }), { target: { value: "tech" } });
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索题库" }), { target: { value: ":q" } });
    const second = cursorList.mock.calls.at(-1)?.[0].queryKey;
    expect(first).not.toBe(second); expect(JSON.parse(first)).toEqual(["bank", "a:tech", "", "q"]); expect(JSON.parse(second)).toEqual(["bank", "a", "tech", ":q"]);
  });

  it("方向读取坏响应不崩溃或抹去原稿，只能显式重试", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({ error: "坏方向列表" }); render(<Page />); fill();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("方向列表响应不完整"));
    expect(draft().value).toBe(raw.replace(/\r\n/g, "\n"));
    vi.mocked(jsonFetch).mockResolvedValueOnce([{ direction: "恢复方向", count: 2 }]);
    fireEvent.click(screen.getByRole("button", { name: "点击重试" }));
    await screen.findByRole("button", { name: "恢复方向 (2)" }); expect(posts()).toHaveLength(0);
  });
});
