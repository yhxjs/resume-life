// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CategoryChangeDialog, CategoryManageDialog, NotebookStarButton } from "../index";
import { jsonFetch } from "@/lib/fetcher";
import { confirmDialog } from "@/components/common/confirm-dialog";

vi.mock("@/lib/fetcher", async original => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
vi.mock("@/components/common/confirm-dialog", () => ({ confirmDialog: vi.fn(async () => true) }));
const categories = [{ id: 1, name: "旧分类 <T> &amp;", entry_count: 2 }];
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("分类弹窗的协议和操作恢复", () => {
  it("分类读取失败可以只读重试，坏数组不能当成空分类", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce([null]).mockResolvedValueOnce(categories);
    render(<CategoryManageDialog onClose={vi.fn()} onChanged={vi.fn()} />);
    await screen.findByRole("alert"); expect(screen.queryByText(/还没有分类/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重试加载分类" }));
    await screen.findByText(categories[0]!.name); expect(jsonFetch).toHaveBeenCalledTimes(2);
  });

  it("改名坏回包先只读核对，串记录时保留原稿并锁定写入", async () => {
    const changed = vi.fn(); const desired = "  新分类 <T> &amp;  ";
    vi.mocked(jsonFetch).mockImplementation(async (url, init) => {
      if (!init?.method && url === "/api/notebook/categories") return categories as never;
      if (init?.method === "PATCH") return { ok: "true" } as never;
      return { id: 9, name: desired.trim(), entry_count: 0 } as never;
    });
    render(<CategoryManageDialog onClose={vi.fn()} onChanged={changed} />); await screen.findByText(categories[0]!.name);
    fireEvent.click(screen.getByRole("button", { name: "重命名" }));
    const input = screen.getByLabelText(`重命名分类：${categories[0]!.name}`) as HTMLInputElement; fireEvent.change(input, { target: { value: desired } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await screen.findByRole("button", { name: "重新读取分类状态" }); expect(changed).not.toHaveBeenCalled(); expect(input.value).toBe(desired);
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true);
    vi.mocked(jsonFetch).mockResolvedValueOnce({ id: 1, name: desired.trim(), entry_count: 2 });
    fireEvent.click(screen.getByRole("button", { name: "重新读取分类状态" })); await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
  });

  it("移动分类同事件重复点击只提交一次，等待期间不能更换分类", async () => {
    const pending = Promise.withResolvers<unknown>(); const saved = vi.fn();
    vi.mocked(jsonFetch).mockImplementation(async (_url, init) => init?.method === "PATCH" ? pending.promise as never : categories as never);
    render(<CategoryChangeDialog entryId={5} question="完整原题" initialCategoryId={null} onClose={vi.fn()} onSaved={saved} />);
    await screen.findByRole("button", { name: categories[0]!.name });
    const save = screen.getByRole("button", { name: "保存" }); act(() => { screen.getByRole("button", { name: categories[0]!.name }).click(); save.click(); save.click(); });
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
    expect(JSON.parse(String(vi.mocked(jsonFetch).mock.calls.find(([, init]) => init?.method === "PATCH")![1]!.body))).toEqual({ category_id: 1 });
    expect((screen.getByRole("button", { name: categories[0]!.name }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { pending.resolve({ ok: true }); }); expect(saved).toHaveBeenCalledTimes(1);
  });

  it("分类创建等待期间不能提前收藏到未分类，重复创建只发一次", async () => {
    const pending = Promise.withResolvers<unknown>();
    vi.mocked(jsonFetch).mockImplementation(async (_url, init) => init?.method === "POST" ? pending.promise as never : categories as never);
    render(<NotebookStarButton source="drill" sourceId={11} question="原题" notebookId={null} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "收藏到错题本" })); const dialog = await screen.findByRole("dialog"); await within(dialog).findByText(categories[0]!.name);
    fireEvent.click(within(dialog).getByRole("button", { name: "+ 新建分类" })); fireEvent.change(within(dialog).getByLabelText("新分类名称"), { target: { value: "新分类" } });
    const create = within(dialog).getByRole("button", { name: "创建" }); act(() => { create.click(); create.click(); });
    expect((within(dialog).getByRole("button", { name: /^收藏$/ }) as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1));
    await act(async () => { pending.resolve({ id: 2, name: "新分类" }); });
  });

  it("删除确认同步互斥，取消时零写入且不刷新", async () => {
    const confirmation = Promise.withResolvers<boolean>(); vi.mocked(confirmDialog).mockReturnValueOnce(confirmation.promise);
    vi.mocked(jsonFetch).mockResolvedValue(categories); const changed = vi.fn(); render(<CategoryManageDialog onClose={vi.fn()} onChanged={changed} />);
    await screen.findByText(categories[0]!.name); const remove = screen.getByRole("button", { name: "删除" }); act(() => { remove.click(); remove.click(); });
    expect(confirmDialog).toHaveBeenCalledTimes(1); expect((screen.getByRole("button", { name: "完成" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { confirmation.resolve(false); }); expect(changed).not.toHaveBeenCalled(); expect(vi.mocked(jsonFetch).mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });

  it.each(["先创建", "先收藏"])("%s 后同事件触发另一入口，只发送先开始的写入", async order => {
    const pending = Promise.withResolvers<unknown>();
    const review = { review_card_id: 8, review_mastery: "new", next_review_date: "2026-10-29" };
    vi.mocked(jsonFetch).mockImplementation(async (url, init) => url.startsWith("/api/notebook/lookup?") ? { id: 8, source: "drill", source_id: 11, category_id: null, question: "原题", answer: "", comment: "", reference: "", review } as never : init?.method === "POST" ? pending.promise as never : categories as never);
    const changed = vi.fn(); render(<NotebookStarButton source="drill" sourceId={11} question="原题" notebookId={null} onChanged={changed} />);
    fireEvent.click(screen.getByRole("button", { name: "收藏到错题本" })); const dialog = await screen.findByRole("dialog"); await within(dialog).findByText(categories[0]!.name);
    fireEvent.click(within(dialog).getByRole("button", { name: "+ 新建分类" })); fireEvent.change(within(dialog).getByLabelText("新分类名称"), { target: { value: "新分类" } });
    const create = within(dialog).getByRole("button", { name: "创建" }); const favorite = within(dialog).getByRole("button", { name: /^收藏$/ });
    act(() => { if (order === "先创建") { create.click(); favorite.click(); } else { favorite.click(); create.click(); } });
    await waitFor(() => expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1));
    const writes = vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "POST");
    expect(writes).toHaveLength(1); expect(writes[0]![0]).toBe(order === "先创建" ? "/api/notebook/categories" : "/api/notebook");
    await act(async () => { pending.resolve(order === "先创建" ? { id: 2, name: "新分类" } : { id: 8, review }); });
    expect(changed).toHaveBeenCalledTimes(order === "先创建" ? 0 : 1);
  });

  it("移动对象切换时中止旧命令，迟到回包不能关闭新弹窗或释放新锁", async () => {
    const previous = Promise.withResolvers<unknown>(); const latest = Promise.withResolvers<unknown>();
    vi.mocked(jsonFetch).mockImplementation(async (url, init) => init?.method === "PATCH" ? (url === "/api/notebook/5" ? previous.promise : latest.promise) as never : categories as never);
    const oldSaved = vi.fn(); const oldClose = vi.fn(); const saved = vi.fn(); const close = vi.fn();
    const view = render(<CategoryChangeDialog entryId={5} question="旧原题" initialCategoryId={null} onClose={oldClose} onSaved={oldSaved} />);
    await screen.findByRole("button", { name: categories[0]!.name }); fireEvent.click(screen.getByRole("button", { name: "保存" }));
    const signal = vi.mocked(jsonFetch).mock.calls.find(([, init]) => init?.method === "PATCH")![1]!.signal!;
    view.rerender(<CategoryChangeDialog entryId={6} question="新原题" initialCategoryId={1} onClose={close} onSaved={saved} />);
    await screen.findByRole("button", { name: categories[0]!.name }); expect(signal.aborted).toBe(true); fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await act(async () => { previous.resolve({ ok: true }); });
    expect(oldSaved).not.toHaveBeenCalled(); expect(oldClose).not.toHaveBeenCalled(); expect(saved).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled).toBe(true); expect(screen.getByText("新原题")).toBeTruthy();
    await act(async () => { latest.resolve({ ok: true }); }); expect(saved).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(vi.mocked(jsonFetch).mock.calls.find(([url, init]) => url === "/api/notebook/6" && init?.method === "PATCH")![1]!.body))).toEqual({ category_id: 1 });
  });
});
