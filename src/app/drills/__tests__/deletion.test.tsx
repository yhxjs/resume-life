// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DrillsPage from "../page";
import { confirmDialog } from "@/components/common/confirm-dialog";
import { HttpError, jsonFetch } from "@/lib/fetcher";

const controls = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => controls }));
vi.mock("@/lib/fetcher", async original => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
vi.mock("@/components/common/confirm-dialog", () => ({ confirmDialog: vi.fn() }));
const target = { id: 7, source: "bank", direction: "删除的方向", jd: "", focus: "", created_at: "2026-10-29", project_name: null, total: 2, answered: 0 };
const other = { ...target, id: 6, direction: "保留的方向" };
let list: { items: typeof target[]; nextCursor: string | null };
let failList: boolean;
beforeEach(() => {
  list = { items: [target, other], nextCursor: null }; failList = false;
  vi.mocked(confirmDialog).mockResolvedValue(true);
  vi.mocked(jsonFetch).mockImplementation(async (url, init) => {
    if (url === "/api/projects" || url === "/api/bank/directions") return [] as never;
    if (url === "/api/drills/7") {
      if (init?.method === "DELETE") return { ok: true } as never;
      throw new HttpError("不存在", 404);
    }
    if (url.startsWith("/api/drills")) { if (failList) throw new Error("目录刷新失败"); return list as never; }
    throw new Error(`Unexpected ${url}`);
  });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe("练习目录删除", () => {
  it("旧列表不能复活已确认删除的练习；刷新失败保留准确提示与恢复入口", async () => {
    render(<DrillsPage />); const row = await screen.findByRole("article", { name: "练习 #7" }); failList = true;
    fireEvent.click(within(row).getByRole("button", { name: "删除" }));
    expect(await screen.findByText(/已确认练习 #7 不存在，已请求刷新练习列表/)).toBeTruthy();
    expect(await screen.findByText("目录刷新失败")).toBeTruthy(); expect(screen.queryByRole("article", { name: "练习 #7" })).toBeNull();
    expect(screen.queryByText(/正在刷新练习列表/)).toBeNull();
    failList = false; fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
    await screen.findByRole("article", { name: "练习 #6" }); expect(screen.queryByRole("article", { name: "练习 #7" })).toBeNull();
    expect(screen.getByText(/当前筛选已显示/).textContent).toContain("1 场");
  });

  it("旧首页只剩已删记录时保留续页入口，续页仍过滤墓碑", async () => {
    list = { items: [target], nextCursor: "7" };
    const implementation = vi.mocked(jsonFetch).getMockImplementation()!;
    vi.mocked(jsonFetch).mockImplementation((url, init) => url === "/api/drills?cursor=7" ? Promise.resolve({ items: [other], nextCursor: null }) as never : implementation(url, init));
    render(<DrillsPage />); const row = await screen.findByRole("article", { name: "练习 #7" });
    fireEvent.click(within(row).getByRole("button", { name: "删除" }));
    await screen.findByText("本页记录已移除，可以继续加载更早的练习。");
    fireEvent.click(screen.getByRole("button", { name: "加载更多" })); await screen.findByRole("article", { name: "练习 #6" });
    expect(screen.queryByRole("article", { name: "练习 #7" })).toBeNull(); expect(screen.queryByRole("button", { name: "加载更多" })).toBeNull();
  });

  it("未知删除只允许重读，配置草稿保留，确认与重读均同步去重", async () => {
    const decision = Promise.withResolvers<boolean>(); vi.mocked(confirmDialog).mockReturnValueOnce(decision.promise);
    const implementation = vi.mocked(jsonFetch).getMockImplementation()!; let reads = 0;
    vi.mocked(jsonFetch).mockImplementation((url, init) => {
      if (url === "/api/drills/7") {
        if (init?.method === "DELETE") return Promise.resolve({}) as never;
        if (++reads === 1) return Promise.resolve({ id: 8 }) as never;
        return Promise.reject(new HttpError("不存在", 404));
      }
      return implementation(url, init);
    });
    render(<DrillsPage />); const row = await screen.findByRole("article", { name: "练习 #7" });
    fireEvent.click(screen.getByRole("tab", { name: "岗位通用题库" }));
    const jd = screen.getByRole("textbox", { name: /岗位任职要求/ }); fireEvent.change(jd, { target: { value: "原稿 <T> &amp;\n只负责参数校验" } });
    const button = within(row).getByRole("button", { name: "删除" });
    act(() => { button.click(); button.click(); }); expect(confirmDialog).toHaveBeenCalledOnce();
    expect((jd.closest("fieldset") as HTMLFieldSetElement).disabled).toBe(true);
    // 原生 fieldset 的禁用语义由浏览器落实；直接调用事件也由同步命令锁兜底。
    fireEvent.click(screen.getByRole("button", { name: "开始通用练习" }));
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    await act(async () => { decision.resolve(true); });
    await screen.findByRole("button", { name: "重新读取删除状态" });
    expect((jd as HTMLTextAreaElement).value).toBe("原稿 <T> &amp;\n只负责参数校验");
    const retry = screen.getByRole("button", { name: "重新读取删除状态" }); act(() => { retry.click(); retry.click(); });
    await screen.findByText(/已确认练习 #7 不存在/); expect(reads).toBe(2); expect(controls.push).not.toHaveBeenCalled();
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
  });

  it("创建等待与同事件重复提交阻止删除排队，失败后可再确认", async () => {
    const pending = Promise.withResolvers<unknown>(); const implementation = vi.mocked(jsonFetch).getMockImplementation()!;
    vi.mocked(jsonFetch).mockImplementation((url, init) => init?.method === "POST" ? pending.promise as never : implementation(url, init));
    render(<DrillsPage />); const row = await screen.findByRole("article", { name: "练习 #7" });
    fireEvent.click(screen.getByRole("tab", { name: "岗位通用题库" }));
    fireEvent.change(screen.getByRole("textbox", { name: /岗位任职要求/ }), { target: { value: "接口工程师" } });
    const start = screen.getByRole("button", { name: "开始通用练习" }); const remove = within(row).getByRole("button", { name: "删除" });
    act(() => { start.click(); start.click(); remove.click(); });
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1); expect(confirmDialog).not.toHaveBeenCalled();
    await act(async () => { pending.reject(new Error("出题失败")); });
    await waitFor(() => expect((within(row).getByRole("button", { name: "删除" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(row).getByRole("button", { name: "删除" })); await screen.findByText(/已确认练习 #7 不存在/); expect(confirmDialog).toHaveBeenCalledOnce();
  });
});
