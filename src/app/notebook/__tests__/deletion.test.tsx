// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Page from "../page";
import { confirmDialog } from "@/components/common/confirm-dialog";
import { HttpError, jsonFetch } from "@/lib/fetcher";

vi.mock("@/lib/fetcher", async original => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
vi.mock("@/components/common/confirm-dialog", () => ({ confirmDialog: vi.fn() }));
const target = { id: 7, category_id: null, category_name: null, source: "drill", source_label: "来源已删", question: "原题 <T> &amp;\n内部  空格", answer: "唯一原答", comment: "原点评", reference: "原参考", scores: null, created_at: "2026-10-29", updated_at: "2026-10-29", review_card_id: null, review_mastery: null, next_review_date: null };
const other = { ...target, id: 6, question: "另一题" };
let list: { items: typeof target[]; nextCursor: string | null }; let failList: boolean; let failCategories: boolean;
beforeEach(() => {
  list = { items: [target, other], nextCursor: null }; failList = false; failCategories = false;
  vi.mocked(confirmDialog).mockResolvedValue(true);
  vi.mocked(jsonFetch).mockImplementation(async (url, init) => {
    if (url === "/api/notebook/categories") { if (failCategories) throw new Error("分类刷新失败"); return [] as never; }
    if (url === "/api/notebook/7") { if (init?.method === "DELETE") return { ok: true } as never; throw new HttpError("不存在", 404); }
    if (url.startsWith("/api/notebook")) { if (failList) throw new Error("目录刷新失败"); return list as never; }
    throw new Error(`Unexpected ${url}`);
  });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("错题目录移出", () => {
  it("目录与统计刷新分别报错，旧列表不能复活已移出项，并通知今日复习更新", async () => {
    const updated = vi.fn(); window.addEventListener("reviews-updated", updated);
    try {
      render(<Page />); const row = await screen.findByRole("article", { name: "错题 #7" }); failList = true; failCategories = true;
      fireEvent.click(within(row).getByRole("button", { name: "移出" }));
      await screen.findByText(/已确认错题 #7 不存在/); await screen.findByText("目录刷新失败"); await screen.findByText("分类加载失败：分类刷新失败");
      expect(updated).toHaveBeenCalledOnce(); expect(screen.queryByRole("article", { name: "错题 #7" })).toBeNull();
      failList = false; failCategories = false;
      const alerts = screen.getAllByRole("alert"); for (const alert of alerts) fireEvent.click(within(alert).getByRole("button", { name: "重试加载" }));
      await screen.findByRole("article", { name: "错题 #6" }); expect(screen.queryByRole("article", { name: "错题 #7" })).toBeNull();
      expect(screen.getByRole("heading", { name: "错题列表（已显示 1 题）" })).toBeTruthy();
    } finally { window.removeEventListener("reviews-updated", updated); }
  });

  it("旧首页全是移出项时保留续页，不能显示尚未收藏的空状态", async () => {
    list = { items: [target], nextCursor: "7" }; const implementation = vi.mocked(jsonFetch).getMockImplementation()!;
    vi.mocked(jsonFetch).mockImplementation((url, init) => url === "/api/notebook?cursor=7" ? Promise.resolve({ items: [other], nextCursor: null }) as never : implementation(url, init));
    render(<Page />); const row = await screen.findByRole("article", { name: "错题 #7" }); fireEvent.click(within(row).getByRole("button", { name: "移出" }));
    await screen.findByText("本页错题已移除，可以继续加载更早的收藏。"); expect(screen.queryByText(/还没有收藏任何错题/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "加载更多" })); await screen.findByRole("article", { name: "错题 #6" }); expect(screen.queryByRole("article", { name: "错题 #7" })).toBeNull();
  });

  it("确认和未知结果阻止分类操作，显式核对恢复后可管理，原稿不变", async () => {
    const decision = Promise.withResolvers<boolean>(); vi.mocked(confirmDialog).mockReturnValueOnce(decision.promise); const implementation = vi.mocked(jsonFetch).getMockImplementation()!; let reads = 0;
    vi.mocked(jsonFetch).mockImplementation((url, init) => {
      if (url === "/api/notebook/7") return init?.method === "DELETE" ? Promise.resolve({}) as never : (++reads === 1 ? Promise.resolve({ ...target, id: 8 }) as never : Promise.resolve(target) as never);
      return implementation(url, init);
    });
    render(<Page />); const row = await screen.findByRole("article", { name: "错题 #7" });
    act(() => { within(row).getByRole("button", { name: "移出" }).click(); screen.getByRole("button", { name: "管理错题分类" }).click(); within(row).getByRole("button", { name: "分类" }).click(); });
    expect(screen.queryByRole("dialog")).toBeNull(); expect(confirmDialog).toHaveBeenCalledOnce();
    await act(async () => { decision.resolve(true); }); const retry = await screen.findByRole("button", { name: "重新读取删除状态" });
    expect((screen.getByRole("button", { name: "管理错题分类" }) as HTMLButtonElement).disabled).toBe(true);
    act(() => { retry.click(); retry.click(); }); await screen.findByText(/错题 #7 目前仍存在/); expect(reads).toBe(2);
    fireEvent.click(within(row).getByRole("button", { name: "展开温习" })); expect(within(screen.getByRole("region", { name: "错题 #7 温习内容" })).getByText("唯一原答")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "管理错题分类" })); await screen.findByRole("dialog", { name: "管理分类" });
  });

  it.each(["manage", "move"])("分类弹窗 %s 从打开开始同步阻止移出排队", async kind => {
    render(<Page />); const row = await screen.findByRole("article", { name: "错题 #7" });
    act(() => { (kind === "manage" ? screen.getByRole("button", { name: "管理错题分类" }) : within(row).getByRole("button", { name: "分类" })).click(); within(row).getByRole("button", { name: "移出" }).click(); });
    await screen.findByRole("dialog"); expect(confirmDialog).not.toHaveBeenCalled(); expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(0);
  });
});
