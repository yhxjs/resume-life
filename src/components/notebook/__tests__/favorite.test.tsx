// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotebookStarButton } from "../index";
import { jsonFetch } from "@/lib/fetcher";

vi.mock("@/lib/fetcher", async original => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const review = { review_card_id: 8, review_mastery: "new", next_review_date: "2026-10-29" };
const props = { source: "drill" as const, sourceId: 11, question: "完整原题 <T> &amp;\n内部  空格", notebookId: null };
async function open() {
  fireEvent.click(screen.getByRole("button", { name: "收藏到错题本" }));
  const dialog = await screen.findByRole("dialog"); await within(dialog).findByRole("button", { name: "+ 新建分类" }); return dialog;
}

describe("收藏写入的确认与会话隔离", () => {
  it("坏成功回包不回调、不清选择，读取失败时保持锁并提供只读重试", async () => {
    vi.mocked(jsonFetch).mockImplementation(async (url, init) => {
      if (url === "/api/notebook/categories") return [] as never;
      if (init?.method === "POST") return { id: "9", review } as never;
      throw new Error("合成核对失败");
    });
    const changed = vi.fn(); render(<NotebookStarButton {...props} onChanged={changed} />); const dialog = await open();
    fireEvent.click(within(dialog).getByRole("button", { name: /^收藏$/ }));
    await within(dialog).findByRole("button", { name: "重新读取收藏状态" });
    expect(changed).not.toHaveBeenCalled(); expect((within(dialog).getByRole("button", { name: /^收藏$/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("网络异常不能直接再次收藏，未知结果保留原题和分类入口锁", async () => {
    vi.mocked(jsonFetch).mockImplementation(async (url) => { if (url === "/api/notebook/categories") return [] as never; throw new Error("合成网络异常"); });
    render(<NotebookStarButton {...props} onChanged={vi.fn()} />); const dialog = await open(); fireEvent.click(within(dialog).getByRole("button", { name: /^收藏$/ }));
    await within(dialog).findByRole("alert"); expect((within(dialog).getByRole("button", { name: /^收藏$/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(dialog).getByRole("button", { name: "+ 新建分类" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("切换来源对象后中止旧请求，迟到成功不回调新旧页面", async () => {
    const pending = Promise.withResolvers<unknown>(); vi.mocked(jsonFetch).mockImplementation(async (url, init) => url === "/api/notebook/categories" ? [] as never : init?.method === "POST" ? pending.promise as never : undefined as never);
    const oldChanged = vi.fn(); const changed = vi.fn(); const view = render(<NotebookStarButton {...props} onChanged={oldChanged} />); const dialog = await open();
    fireEvent.click(within(dialog).getByRole("button", { name: /^收藏$/ })); const signal = vi.mocked(jsonFetch).mock.calls.find(([, init]) => init?.method === "POST")![1]!.signal;
    view.rerender(<NotebookStarButton {...props} sourceId={12} onChanged={changed} />);
    await act(async () => { pending.resolve({ id: 9, review }); });
    expect(oldChanged).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled(); expect(signal?.aborted).toBe(true);
  });
});
