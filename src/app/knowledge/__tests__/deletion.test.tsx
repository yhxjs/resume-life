// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Page from "../page";
import { ConfirmDialogHost, confirmDialog } from "@/components/common/confirm-dialog";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import { emptySummary } from "@/lib/summary";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/fetcher", async original => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
const name = "原项目 <T> &amp;\n" + "完整名称_".repeat(60);
const item = { id: 7, name, summary_updated_at: "2026-11-01", updated_at: "2026-11-03", material_count: 2 };
const another = { ...item, id: 8, name: "另一份项目" };
const material = { id: 11, title: "旧材料", source: "paste", filename: "", content_length: 200000, created_at: "2026-10-01" };
const detail = { id: 7, name, summary: emptySummary(), summary_updated_at: "", summary_revision_id: 0, summary_corrupt: false, updated_at: "2026-11-03", materials: [material], materials_total: 1, materials_next_cursor: null };
const originalText = { normalizer: (value: string) => value };
const writes = () => vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method);
const listReads = () => vi.mocked(jsonFetch).mock.calls.filter(([url, init]) => url === "/api/projects" && !init?.method);
const input = () => screen.getByRole("textbox", { name: "项目名称" });
const remove = () => screen.getAllByRole("button", { name: "删除档案" })[0]!;
const dialog = () => screen.getByRole("dialog", { name: "删除项目" });
function accept() { fireEvent.click(within(dialog()).getByRole("button", { name: "删除" })); }
async function setup() { const view = render(<><Page /><ConfirmDialogHost /></>); await screen.findByText(name, originalText); return view; }
beforeEach(() => {
  vi.mocked(jsonFetch).mockImplementation(async (url, init) => (init?.method === "DELETE" ? { ok: true } : url === "/api/projects/7" ? detail : [item, another]) as never);
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 100, 20)] as unknown as DOMRectList);
});
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.restoreAllMocks(); });

describe("项目目录的删除范围、只读恢复和页面归属", () => {
  it("首次目录读取离页即取消，迟到结果不覆盖新实例", async () => {
    const pending = Promise.withResolvers<unknown>(); vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
    const old = render(<Page />); const signal = listReads()[0]![1]?.signal; old.unmount(); expect(signal?.aborted).toBe(true);
    await setup(); await act(async () => { pending.resolve([]); }); expect(screen.getByText(name, originalText)).toBeTruthy();
  });

  it("创建明确失败后关闭提示可重试，名称原稿完整保留", async () => {
    await setup(); vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("项目保存失败", 400));
    fireEvent.change(input(), { target: { value: "  保留名称  " } }); fireEvent.click(screen.getByRole("button", { name: "立即创建" }));
    const alert = await screen.findByRole("dialog", { name: "创建失败" }); expect(alert.textContent).toContain("项目保存失败"); fireEvent.click(within(alert).getByRole("button", { name: "确定" }));
    await waitFor(() => expect(input().matches(":disabled")).toBe(false)); expect((input() as HTMLInputElement).value).toBe("  保留名称  ");
    vi.mocked(jsonFetch).mockResolvedValueOnce({ id: 12 }); fireEvent.click(screen.getByRole("button", { name: "立即创建" })); await waitFor(() => expect(push).toHaveBeenCalledExactlyOnceWith("/knowledge/12")); expect(writes()).toHaveLength(2);
  });

  it("完整确认身份和级联范围，重复触发与新建同步互斥，取消零写入并归还焦点", async () => {
    await setup(); fireEvent.change(input(), { target: { value: "待创建原稿" } }); const button = remove(); button.focus();
    act(() => { button.click(); button.click(); screen.getByRole("button", { name: "立即创建" }).click(); });
    for (const text of ["#7", name, "2 份材料", item.updated_at, "总结历史", "练习", "复习", "收藏", "简历"]) expect(dialog().textContent).toContain(text);
    expect(input().matches(":disabled")).toBe(true); expect(writes()).toHaveLength(0);
    fireEvent.click(within(dialog()).getByRole("button", { name: "取消" })); await waitFor(() => expect(document.activeElement).toBe(button));
    expect(screen.queryByRole("dialog")).toBeNull(); expect(writes()).toHaveLength(0); expect((input() as HTMLInputElement).value).toBe("待创建原稿");
  });

  it("离页关闭当前确认，回到新实例后取消不写入", async () => {
    render(<ConfirmDialogHost />); const old = render(<Page />); await screen.findByText(name, originalText); fireEvent.click(remove()); old.unmount();
    expect(screen.queryByRole("dialog")).toBeNull(); render(<Page />); await screen.findByText(name, originalText);
    fireEvent.click(remove()); fireEvent.keyDown(document, { key: "Escape" }); await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull()); expect(writes()).toHaveLength(0);
  });

  it("离页移除排队确认，保留无关当前项与有效后续项", async () => {
    render(<ConfirmDialogHost />); const old = render(<Page />); await screen.findByText(name, originalText);
    act(() => { void confirmDialog({ title: "其他确认", message: "先处理此项" }); }); fireEvent.click(remove());
    act(() => { void confirmDialog({ title: "有效确认", message: "仍要处理" }); }); old.unmount();
    expect(screen.getByRole("dialog").textContent).toContain("其他确认"); fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(screen.getByRole("dialog").textContent).toContain("有效确认"); fireEvent.click(screen.getByRole("button", { name: "取消" })); expect(writes()).toHaveLength(0);
  });

  it("同事件多次点击只确认并删除一次，旧列表不能复活且计数正确", async () => {
    await setup(); act(() => { remove().click(); remove().click(); }); accept();
    await waitFor(() => expect(screen.queryByText(name, originalText)).toBeNull()); await waitFor(() => expect(listReads()).toHaveLength(2));
    expect(writes()).toHaveLength(1); expect(screen.queryByRole("dialog")).toBeNull(); expect(screen.getByText("另一份项目")).toBeTruthy(); expect(screen.getByText("已归档技术项目 (1)")).toBeTruthy();
  });

  it.each([null, {}, { ok: "true" }])("坏删除确认%j只读核对503／串ID／仍在，只有再次明确确认才重删", async value => {
    let checks = 0; let deletes = 0;
    vi.mocked(jsonFetch).mockImplementation(async (url, init) => {
      if (init?.method === "DELETE") return (++deletes === 1 ? value : { ok: true }) as never;
      if (url === "/api/projects/7") { checks++; if (checks === 1) throw new HttpError("读取暂不可用", 503); return (checks === 2 ? { ...detail, id: 8 } : detail) as never; }
      return [item, another] as never;
    });
    await setup(); fireEvent.change(input(), { target: { value: "保留原稿" } }); fireEvent.click(remove()); accept();
    await screen.findByRole("button", { name: "重新读取删除状态" }); expect(screen.getByRole("alert").textContent).toContain("读取暂不可用");
    fireEvent.click(screen.getByRole("button", { name: "重新读取删除状态" })); await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("不属于当前项目")); expect(remove().matches(":disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "重新读取删除状态" })); await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("目前仍存在"));
    expect(deletes).toBe(1); expect((input() as HTMLInputElement).value).toBe("保留原稿"); fireEvent.click(remove()); accept(); await waitFor(() => expect(screen.queryByText(name, originalText)).toBeNull()); expect(deletes).toBe(2);
    expect(vi.mocked(jsonFetch).mock.calls.filter(([url, init]) => url === "/api/projects/7" && !init?.method).every(([, init]) => init?.cache === "no-store" && init.signal instanceof AbortSignal)).toBe(true);
  });

  it.each([new Error("网络中断"), new HttpError("超时", 408), new HttpError("服务端异常", 500)])("未知删除%s只读404后移除，不自动重发", async error => {
    vi.mocked(jsonFetch).mockImplementation(async (url, init) => { if (init?.method === "DELETE") throw error; if (url === "/api/projects/7") throw new HttpError("不存在", 404); return [item, another] as never; });
    await setup(); fireEvent.click(remove()); accept(); await waitFor(() => expect(screen.queryByText(name, originalText)).toBeNull()); expect(writes()).toHaveLength(1);
  });

  it.each([400, 409, 422])("明确拒绝%s保留档案和原稿，不额外GET或错误确认", async status => {
    vi.mocked(jsonFetch).mockImplementation(async (_url, init) => { if (init?.method === "DELETE") throw new HttpError("业务拒绝", status); return [item, another] as never; });
    await setup(); fireEvent.click(remove()); accept(); await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("业务拒绝"));
    expect(screen.queryByRole("dialog")).toBeNull(); expect(screen.getByText(name, originalText)).toBeTruthy(); expect(jsonFetch).toHaveBeenCalledTimes(2);
  });

  it.each([null, { id: 7 }, { ...detail, summary: {} }, { ...detail, materials: [null] }, { ...detail, materials_next_cursor: "999" }])("坏详情%j不解除未知锁，404后才移除", async value => {
    vi.mocked(jsonFetch).mockImplementation(async (url, init) => (init?.method === "DELETE" ? {} : url === "/api/projects/7" ? value : [item, another]) as never);
    await setup(); fireEvent.click(remove()); accept(); await screen.findByRole("button", { name: "重新读取删除状态" }); expect(remove().matches(":disabled")).toBe(true);
    vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("不存在", 404)); fireEvent.click(screen.getByRole("button", { name: "重新读取删除状态" }));
    await waitFor(() => expect(screen.queryByText(name, originalText)).toBeNull()); expect(writes()).toHaveLength(1);
  });

  it("损坏总结422不能证明删除，修复后历史长原文与合法空总结可核对仍在", async () => {
    let checks = 0; const saved = { ...detail, summary: { ...emptySummary(), overview: "旧原稿 <T> &amp;\n".repeat(3000) } }; const original = JSON.stringify(saved);
    vi.mocked(jsonFetch).mockImplementation(async (url, init) => { if (init?.method === "DELETE") return {} as never; if (url === "/api/projects/7") { if (++checks === 1) throw new HttpError("项目总结损坏", 422); return saved as never; } return [item, another] as never; });
    await setup(); fireEvent.click(remove()); accept(); await screen.findByRole("button", { name: "重新读取删除状态" }); expect(screen.getByRole("alert").textContent).toContain("项目总结损坏");
    fireEvent.click(screen.getByRole("button", { name: "重新读取删除状态" })); await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("目前仍存在"));
    expect(JSON.stringify(saved)).toBe(original); expect(remove().matches(":disabled")).toBe(false); expect(writes()).toHaveLength(1);
  });

  it("删除后列表刷新失败仍移除本地记录并保留新建输入，重读不重删", async () => {
    let reads = 0; vi.mocked(jsonFetch).mockImplementation(async (_url, init) => { if (init?.method === "DELETE") return { ok: true } as never; if (++reads === 2) throw new Error("刷新失败"); return [item, another] as never; });
    await setup(); fireEvent.change(input(), { target: { value: "新建原稿" } }); fireEvent.click(remove()); accept(); await screen.findByRole("alert");
    expect(screen.queryByText(name, originalText)).toBeNull(); expect((input() as HTMLInputElement).value).toBe("新建原稿"); fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull()); expect(screen.queryByText(name, originalText)).toBeNull(); expect(writes()).toHaveLength(1);
  });

  it("新建采用同事件最新名称并去首尾空白，输入法Enter不创建，成功导航前仍互斥", async () => {
    await setup(); fireEvent.change(input(), { target: { value: "  支付平台  " } }); fireEvent.keyDown(input(), { key: "Enter", isComposing: true }); expect(writes()).toHaveLength(0);
    vi.mocked(jsonFetch).mockResolvedValueOnce({ id: 12 });
    act(() => { screen.getByRole("button", { name: "立即创建" }).click(); remove().click(); });
    await waitFor(() => expect(push).toHaveBeenCalledExactlyOnceWith("/knowledge/12")); expect(writes()).toHaveLength(1); expect(writes()[0]![1]).toMatchObject({ body: JSON.stringify({ name: "支付平台" }), signal: expect.any(AbortSignal) }); expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("新建同步锁阻止重复和删除，离页后迟到完成不导航新页", async () => {
    const pending = Promise.withResolvers<unknown>(); const old = await setup(); vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
    fireEvent.change(input(), { target: { value: "新项目" } }); const create = screen.getByRole("button", { name: "立即创建" }); act(() => { create.click(); remove().click(); create.click(); });
    expect(writes()).toHaveLength(1); expect(screen.queryByRole("dialog")).toBeNull(); const signal = writes()[0]![1]?.signal; old.unmount(); expect(signal?.aborted).toBe(true);
    await setup(); await act(async () => { pending.resolve({ id: 12 }); }); expect(push).not.toHaveBeenCalled(); expect(writes()).toHaveLength(1);
  });

  it("创建失败保留原稿，当前失败提示随离页关闭，新页不被旧错误解锁", async () => {
    render(<ConfirmDialogHost />); const old = render(<Page />); await screen.findByText(name, originalText); vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("项目保存失败", 400));
    fireEvent.change(input(), { target: { value: "保留名称" } }); fireEvent.click(screen.getByRole("button", { name: "立即创建" }));
    const alert = await screen.findByRole("dialog", { name: "创建失败" }); expect(alert.textContent).toContain("项目保存失败"); expect((input() as HTMLInputElement).value).toBe("保留名称"); old.unmount(); expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each([null, { id: "12" }, { id: -1 }])("创建坏ID%j不导航，关闭失败提示后保留输入并可显式重试", async value => {
    await setup(); vi.mocked(jsonFetch).mockResolvedValueOnce(value); fireEvent.change(input(), { target: { value: "原名称" } }); fireEvent.click(screen.getByRole("button", { name: "立即创建" }));
    const alert = await screen.findByRole("dialog", { name: "创建失败" }); fireEvent.click(within(alert).getByRole("button", { name: "确定" }));
    await waitFor(() => expect(input().matches(":disabled")).toBe(false)); expect(push).not.toHaveBeenCalled(); expect((input() as HTMLInputElement).value).toBe("原名称");
  });

  it.each(["delete", "check"])("离页中止%s，迟到回复不刷新新目录", async stage => {
    const pending = Promise.withResolvers<unknown>(); vi.mocked(jsonFetch).mockImplementation(async (url, init) => (init?.method === "DELETE" ? stage === "delete" ? pending.promise : {} : url === "/api/projects/7" ? pending.promise : [item, another]) as never);
    const old = await setup(); fireEvent.click(remove()); accept(); if (stage === "check") await waitFor(() => expect(vi.mocked(jsonFetch).mock.calls.some(([url, init]) => url === "/api/projects/7" && !init?.method)).toBe(true));
    const signal = vi.mocked(jsonFetch).mock.calls.at(-1)![1]?.signal; old.unmount(); expect(signal?.aborted).toBe(true); await setup(); const reads = listReads().length;
    await act(async () => { pending.resolve(stage === "delete" ? { ok: true } : detail); }); expect(listReads()).toHaveLength(reads); expect(screen.getByText(name, originalText)).toBeTruthy();
  });

  it.each([null, [null], [{ ...item, id: "7" }], [item, item], [{ ...item, material_count: -1 }]])("坏目录%j整份拒绝，重试保留原稿且恢复", async value => {
    vi.mocked(jsonFetch).mockResolvedValueOnce(value); render(<><Page /><ConfirmDialogHost /></>); fireEvent.change(input(), { target: { value: "待创建名称" } }); await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "删除档案" })).toBeNull(); fireEvent.click(screen.getByRole("button", { name: "重试加载" })); await screen.findByText(name, originalText);
    expect(screen.queryByRole("alert")).toBeNull(); expect((input() as HTMLInputElement).value).toBe("待创建名称");
  });
});
