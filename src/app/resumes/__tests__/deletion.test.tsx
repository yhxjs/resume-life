// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Page from "../page";
import { ConfirmDialogHost, confirmDialog } from "@/components/common/confirm-dialog";
import { HttpError, jsonFetch } from "@/lib/fetcher";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/fetcher", async original => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
const item = { id: 7, title: "主投 <T> &amp;\n" + "完整标题_".repeat(45), created_at: "2026-11-01", updated_at: "2026-11-03", versions: [{ id: 71, version: 1, name: "发布版" }] };
const another = { ...item, id: 8, title: "另一份简历", versions: [] };
const detail = { resume: { id: 7, title: item.title, template: "classic", created_at: item.created_at, updated_at: item.updated_at, base_version_id: null, style_overrides: {} }, modules: [], warnings: [], corruptedKeys: [] };
const writes = () => vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method);
const remove = () => screen.getAllByRole("button", { name: "删除" })[0]!;
const titleInput = () => screen.getByRole("textbox");
const confirmation = () => screen.getByRole("dialog", { name: "删除简历" });
const refreshReads = () => vi.mocked(jsonFetch).mock.calls.filter(([url, init]) => url === "/api/resumes" && !init?.method);
beforeEach(() => {
  vi.mocked(jsonFetch).mockImplementation(async (url, init) => (init?.method === "DELETE" ? { ok: true } : url === "/api/resumes/7" ? detail : [item, another]) as never);
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 100, 20)] as unknown as DOMRectList);
});
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.restoreAllMocks(); });
async function setup() { const view = render(<><Page /><ConfirmDialogHost /></>); await screen.findByText(item.title, { normalizer: value => value }); return view; }
function confirmRemove() { fireEvent.click(within(confirmation()).getByRole("button", { name: "删除" })); }

describe("简历目录删除的确认、恢复与页面归属", () => {
  it("混合目录可显示正常简历，并能从历史编号复制当前草稿", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce([item, { ...another, id: 0, versions: [{ id: -5, version: 1, name: "旧版" }] }]);
    await setup();
    expect(screen.getByRole("link", { name: "查看历史版本（1）" }).getAttribute("href")).toBe("/resumes/0/versions");
    expect(screen.getAllByRole("button", { name: "删除" })).toHaveLength(1);
    vi.mocked(jsonFetch).mockResolvedValueOnce({ id: 9 });
    fireEvent.click(screen.getByRole("button", { name: "复制当前草稿" }));
    await waitFor(() => expect(refreshReads()).toHaveLength(2));
    expect(writes()[0]).toEqual(["/api/resumes/0/copy", expect.objectContaining({ method: "POST" })]);
  });

  it("新建去除标题首尾空白，同事件改名后立即提交读取最新输入，成功导航前保持互斥", async () => {
    await setup(); vi.mocked(jsonFetch).mockResolvedValueOnce({ id: 9, title: "Java 后端" });
    const button = screen.getByRole("button", { name: "立即创建" });
    act(() => { fireEvent.change(titleInput(), { target: { value: "  Java 后端  " } }); button.click(); button.click(); });
    await waitFor(() => expect(push).toHaveBeenCalledExactlyOnceWith("/resumes/9"));
    expect(writes()).toHaveLength(1); expect(writes()[0]).toEqual(["/api/resumes", expect.objectContaining({ body: JSON.stringify({ title: "Java 后端" }), signal: expect.any(AbortSignal) })]);
    expect(button.matches(":disabled")).toBe(true); fireEvent.click(remove()); expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("输入法Enter不创建，正常复制确认新ID后只读刷新并保留标题", async () => {
    await setup(); fireEvent.change(titleInput(), { target: { value: "待创建" } }); fireEvent.keyDown(titleInput(), { key: "Enter", isComposing: true }); expect(writes()).toHaveLength(0);
    vi.mocked(jsonFetch).mockResolvedValueOnce({ id: 9 }); fireEvent.click(screen.getAllByRole("button", { name: "复制" })[0]!);
    await waitFor(() => expect(refreshReads()).toHaveLength(2)); expect(writes()).toHaveLength(1); expect((titleInput() as HTMLInputElement).value).toBe("待创建");
  });

  it.each(["create", "copy"])("%s坏完成不导航或伪装刷新，失败提示随离页撤销", async kind => {
    render(<ConfirmDialogHost />); const old = render(<Page />); await screen.findByText(item.title, { normalizer: value => value }); vi.mocked(jsonFetch).mockResolvedValueOnce({ id: "9" });
    fireEvent.change(titleInput(), { target: { value: "保留标题" } });
    fireEvent.click(kind === "create" ? screen.getByRole("button", { name: "立即创建" }) : screen.getAllByRole("button", { name: "复制" })[0]!);
    await screen.findByRole("dialog", { name: kind === "create" ? "创建失败" : "复制失败" });
    expect(push).not.toHaveBeenCalled(); expect(refreshReads()).toHaveLength(1); expect((titleInput() as HTMLInputElement).value).toBe("保留标题");
    old.unmount(); expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each([null, [null], [{ ...item, id: "7" }], [item, item], [{ ...item, versions: [null] }]])("目录坏结构%j整份拒绝，保留原稿并可重试", async value => {
    vi.mocked(jsonFetch).mockResolvedValueOnce(value); render(<><Page /><ConfirmDialogHost /></>);
    fireEvent.change(titleInput(), { target: { value: "未提交标题" } }); await screen.findByRole("alert"); expect(screen.queryByText(item.title, { normalizer: value => value })).toBeNull();
    expect(screen.queryByRole("button", { name: "删除" })).toBeNull(); fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
    await screen.findByText(item.title, { normalizer: value => value }); expect(screen.queryByRole("alert")).toBeNull(); expect((titleInput() as HTMLInputElement).value).toBe("未提交标题");
  });

  it("确认包含完整身份及级联范围，取消零写入并归还焦点，所有写入入口同步互斥", async () => {
    await setup(); fireEvent.change(titleInput(), { target: { value: "未提交标题" } });
    const button = remove(); button.focus();
    act(() => { button.click(); button.click(); screen.getByRole("button", { name: "立即创建" }).click(); screen.getAllByRole("button", { name: "复制" })[0]!.click(); });
    const dialog = confirmation(); for (const text of ["#7", item.title, "1 个已发布版本", "诊断", "自我介绍", "面试", "投递", "收藏", "追练"]) expect(dialog.textContent).toContain(text);
    expect((titleInput() as HTMLInputElement).disabled).toBe(true); expect(writes()).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(document.activeElement).toBe(button));
    expect(screen.queryByRole("dialog")).toBeNull(); expect(writes()).toHaveLength(0); expect((titleInput() as HTMLInputElement).value).toBe("未提交标题");
  });

  it("离页清理当前确认并结算等待，重新进入取消不写入", async () => {
    render(<ConfirmDialogHost />); const old = render(<Page />); await screen.findByText(item.title, { normalizer: value => value }); fireEvent.click(remove()); expect(confirmation()).toBeTruthy(); old.unmount();
    expect(screen.queryByRole("dialog")).toBeNull();
    render(<Page />); await screen.findByText(item.title, { normalizer: value => value }); fireEvent.click(remove()); fireEvent.click(within(confirmation()).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull()); expect(writes()).toHaveLength(0);
  });

  it("离页移除排队确认，保留其他有效确认", async () => {
    render(<ConfirmDialogHost />); const old = render(<Page />); await screen.findByText(item.title, { normalizer: value => value });
    act(() => { void confirmDialog({ title: "其他确认", message: "先处理此项" }); });
    fireEvent.click(remove()); act(() => { void confirmDialog({ title: "有效确认", message: "后续仍有效" }); }); old.unmount();
    expect(screen.getByRole("dialog").textContent).toContain("其他确认"); fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(screen.getByRole("dialog").textContent).toContain("有效确认"); fireEvent.click(screen.getByRole("button", { name: "取消" })); expect(writes()).toHaveLength(0);
  });

  it("同事件多次确认只删除一次，刷新旧列表也不能复活记录", async () => {
    await setup(); const button = remove(); act(() => { button.click(); button.click(); }); confirmRemove();
    await waitFor(() => expect(screen.queryByText(item.title, { normalizer: value => value })).toBeNull());
    expect(screen.queryByRole("dialog")).toBeNull(); expect(screen.getByText(another.title)).toBeTruthy(); expect(writes()).toHaveLength(1);
    expect(writes()[0]).toEqual(["/api/resumes/7", expect.objectContaining({ method: "DELETE", signal: expect.any(AbortSignal) })]);
    expect(screen.getByText(/共维护 1/)).toBeTruthy(); await waitFor(() => expect(refreshReads()).toHaveLength(2));
  });

  it.each([null, {}, { ok: "true" }])("坏删除确认 %j 先只读核对，503／串ID继续锁定，有效仍在后须再次确认", async response => {
    let checks = 0; let deletes = 0;
    vi.mocked(jsonFetch).mockImplementation(async (url, init) => {
      if (init?.method === "DELETE") { deletes++; return (deletes === 1 ? response : { ok: true }) as never; }
      if (url === "/api/resumes/7") { checks++; if (checks === 1) throw new HttpError("核对暂不可用", 503); return (checks === 2 ? { ...detail, resume: { ...detail.resume, id: 8 } } : detail) as never; }
      return [item, another] as never;
    });
    await setup(); fireEvent.change(titleInput(), { target: { value: "保留标题" } }); fireEvent.click(remove()); confirmRemove();
    await screen.findByRole("button", { name: "重新读取删除状态" }); expect(screen.getByRole("alert").textContent).toContain("核对暂不可用");
    const reread = screen.getByRole("button", { name: "重新读取删除状态" }); fireEvent.click(reread);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("记录不符")); expect(remove().matches(":disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "重新读取删除状态" })); await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("目前仍存在"));
    expect(deletes).toBe(1); expect((titleInput() as HTMLInputElement).value).toBe("保留标题"); expect(remove().matches(":disabled")).toBe(false);
    fireEvent.click(remove()); confirmRemove(); await waitFor(() => expect(screen.queryByText(item.title, { normalizer: value => value })).toBeNull());
    expect(deletes).toBe(2); expect(vi.mocked(jsonFetch).mock.calls.filter(([url]) => url === "/api/resumes/7").filter(([, init]) => !init?.method).every(([, init]) => init?.cache === "no-store")).toBe(true);
  });

  it.each([new Error("网络中断"), new HttpError("超时", 408), new HttpError("服务端异常", 500)])("未知删除 %s 回读404后才移除，不自动重发", async error => {
    vi.mocked(jsonFetch).mockImplementation(async (url, init) => { if (init?.method === "DELETE") throw error; if (url === "/api/resumes/7") throw new HttpError("不存在", 404); return [item, another] as never; });
    await setup(); fireEvent.click(remove()); confirmRemove(); await waitFor(() => expect(screen.queryByText(item.title, { normalizer: value => value })).toBeNull()); expect(writes()).toHaveLength(1);
  });

  it.each([null, { id: 7 }, { ...detail, modules: [null] }, { ...detail, warnings: null }, { ...detail, resume: { ...detail.resume, base_version_id: "71" } }])("坏详情%j不能按同ID或缺结构解除未知锁，重读404才移除", async value => {
    vi.mocked(jsonFetch).mockImplementation(async (url, init) => (init?.method === "DELETE" ? {} : url === "/api/resumes/7" ? value : [item, another]) as never);
    await setup(); fireEvent.click(remove()); confirmRemove(); await screen.findByRole("button", { name: "重新读取删除状态" });
    expect(screen.getByText(item.title, { normalizer: value => value })).toBeTruthy(); expect(remove().matches(":disabled")).toBe(true); expect(writes()).toHaveLength(1);
    vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("不存在", 404)); fireEvent.click(screen.getByRole("button", { name: "重新读取删除状态" }));
    await waitFor(() => expect(screen.queryByText(item.title, { normalizer: value => value })).toBeNull()); expect(writes()).toHaveLength(1);
  });

  it("历史损坏模块的默认回退和警告可核对仍存在，长原稿与空字段不被改写", async () => {
    const saved = { ...detail, resume: { ...detail.resume, base_version_id: null, styleCorrupted: true }, modules: [{ key: "summary", type: "summary", label: "旧模块", sort: -2, content: { text: "" } }], warnings: ["原模块数据损坏，已显示为空"], corruptedKeys: ["summary"] };
    const original = JSON.stringify(saved);
    vi.mocked(jsonFetch).mockImplementation(async (url, init) => (init?.method === "DELETE" ? {} : url === "/api/resumes/7" ? saved : [item, another]) as never);
    await setup(); fireEvent.click(remove()); confirmRemove(); await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("目前仍存在"));
    expect(remove().matches(":disabled")).toBe(false); expect(JSON.stringify(saved)).toBe(original); expect(writes()).toHaveLength(1);
  });

  it.each([400, 409, 422])("明确拒绝 %s 保留记录，不额外GET或弹出独立错误框", async status => {
    vi.mocked(jsonFetch).mockImplementation(async (_url, init) => { if (init?.method === "DELETE") throw new HttpError("业务拒绝", status); return [item, another] as never; });
    await setup(); fireEvent.click(remove()); confirmRemove(); await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("业务拒绝"));
    expect(screen.getByText(item.title, { normalizer: value => value })).toBeTruthy(); expect(screen.queryByRole("dialog")).toBeNull(); expect(vi.mocked(jsonFetch).mock.calls).toHaveLength(2);
  });

  it("删除刷新失败保留本地移除和新建标题，只读重试不重删", async () => {
    let reads = 0; vi.mocked(jsonFetch).mockImplementation(async (_url, init) => { if (init?.method === "DELETE") return { ok: true } as never; if (++reads === 2) throw new Error("列表刷新失败"); return [item, another] as never; });
    await setup(); fireEvent.change(titleInput(), { target: { value: "待创建标题" } }); fireEvent.click(remove()); confirmRemove();
    await screen.findByRole("alert"); expect(screen.queryByText(item.title, { normalizer: value => value })).toBeNull(); expect((titleInput() as HTMLInputElement).value).toBe("待创建标题");
    fireEvent.click(screen.getByRole("button", { name: "重试加载" })); await waitFor(() => expect(screen.queryByRole("alert")).toBeNull()); expect(writes()).toHaveLength(1); expect(screen.queryByText(item.title, { normalizer: value => value })).toBeNull();
  });

  it.each(["create", "copy"])("%s从同事件起阻止删除，离页后的完成不能导航或刷新新实例", async kind => {
    const pending = Promise.withResolvers<unknown>();
    vi.mocked(jsonFetch).mockImplementation(async (_url, init) => init?.method === "POST" ? pending.promise as never : [item, another] as never);
    const old = await setup(); fireEvent.change(titleInput(), { target: { value: "新简历" } });
    const button = kind === "create" ? screen.getByRole("button", { name: "立即创建" }) : screen.getAllByRole("button", { name: "复制" })[0]!;
    act(() => { button.click(); remove().click(); button.click(); }); expect(screen.queryByRole("dialog")).toBeNull(); expect(writes()).toHaveLength(1);
    const signal = writes()[0]![1]?.signal; old.unmount(); expect(signal?.aborted).toBe(true);
    await setup(); const reads = refreshReads().length; await act(async () => { pending.resolve({ id: 9, title: "副本" }); });
    expect(push).not.toHaveBeenCalled(); expect(refreshReads()).toHaveLength(reads); expect(writes()).toHaveLength(1);
  });

  it.each(["delete", "check"])("离页中止%s等待，迟到回复不刷新新页", async stage => {
    const pending = Promise.withResolvers<unknown>();
    vi.mocked(jsonFetch).mockImplementation(async (url, init) => { if (init?.method === "DELETE") return (stage === "delete" ? pending.promise : {}) as never; if (url === "/api/resumes/7") return pending.promise as never; return [item, another] as never; });
    const old = await setup(); fireEvent.click(remove()); confirmRemove();
    if (stage === "check") await waitFor(() => expect(vi.mocked(jsonFetch).mock.calls.some(([url, init]) => url === "/api/resumes/7" && !init?.method)).toBe(true));
    const signal = vi.mocked(jsonFetch).mock.calls.at(-1)![1]?.signal; old.unmount(); expect(signal?.aborted).toBe(true);
    await setup(); const reads = refreshReads().length; await act(async () => { pending.resolve(stage === "delete" ? { ok: true } : detail); });
    expect(refreshReads()).toHaveLength(reads); expect(screen.getByText(item.title, { normalizer: value => value })).toBeTruthy(); expect(screen.queryByRole("alert")).toBeNull();
  });
});
