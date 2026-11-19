// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Page from "../page";
import { ConfirmDialogHost, confirmDialog } from "@/components/common/confirm-dialog";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import type { Application } from "@/lib/applications-types";
import { mockSearchParamNavigation } from "../../../../tests/support/next-search-params";
import { applicationStatsFixture } from "../../../../tests/support/application-stats";

vi.mock("next/navigation", async () => ({ useSearchParams: (await import("../../../../tests/support/next-search-params")).useTestSearchParams }));
vi.mock("@/lib/fetcher", async original => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
const item: Application = { id: 7, company: "投递 <T> &amp; " + "完整身份_".repeat(35), role: "接口开发", stage: "interested", flow_status: "active", batch_name: "秋招", hiring_stage: null, stage_changed_at: "", terminal_stage: null, terminal_reason: "", terminal_at: "", salary_range: "", resume_id: null, jd: "", interview_id: null, interview_series_id: null, next_interview_at: "", notes: "保留备注", created_at: "2026-11-01", updated_at: "2026-11-03", interviews: [], stage_history: [], preparation_tasks: [] };
const another = { ...item, id: 8, company: "另一投递" };
const writes = () => vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method);
const listReads = () => vi.mocked(jsonFetch).mock.calls.filter(([url, init]) => url === "/api/applications" && !init?.method);
const targetReads = () => vi.mocked(jsonFetch).mock.calls.filter(([url, init]) => url === "/api/applications/7" && !init?.method);
const remove = () => screen.getAllByTitle("删除卡片")[0]!;
const confirmation = () => screen.getByRole("dialog", { name: "确认删除投递记录？" });
const confirmRemove = () => fireEvent.click(within(confirmation()).getByRole("button", { name: "确认删除" }));
beforeEach(() => {
  mockSearchParamNavigation();
  window.history.replaceState(null, "", "/applications");
  vi.mocked(jsonFetch).mockReset().mockImplementation(async (url, init) => {
    if (init?.method === "DELETE") return { ok: true } as never;
    if (url === "/api/applications/stats") return applicationStatsFixture([item, another]) as never;
    if (url === "/api/applications/7") return structuredClone(item) as never;
    if (url === "/api/resumes") return [] as never;
    if (url.startsWith("/api/interviews")) return { items: [], nextCursor: null } as never;
    return { items: [structuredClone(item), structuredClone(another)], nextCursor: null } as never;
  });
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 100, 20)] as unknown as DOMRectList);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
async function setup() { render(<ConfirmDialogHost />); const view = render(<Page />); await screen.findByText(item.company); return view; }

it("基线：确认说明完整身份与级联范围，同事件只一次确认且取消归还焦点", async () => {
  await setup(); const button = remove(); button.focus(); act(() => { button.click(); button.click(); });
  for (const value of ["#7", item.company, item.role, item.created_at, item.updated_at, "阶段履历", "投递快照", "准备待办", "复盘", "简历", "收藏"]) expect(confirmation().textContent).toContain(value);
  fireEvent.click(within(confirmation()).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull()); expect(document.activeElement).toBe(button); expect(writes()).toHaveLength(0);
});
it("基线：离页关闭当前删除确认，接受旧入口不发送删除", async () => {
  const view = await setup(); fireEvent.click(remove()); const oldConfirm = within(confirmation()).getByRole("button", { name: "确认删除" });
  view.unmount(); expect(screen.queryByRole("dialog")).toBeNull(); fireEvent.click(oldConfirm); await act(async () => {}); expect(writes()).toHaveLength(0);
});
it("基线：离页移除排队删除确认并保留其他有效确认", async () => {
  const view = await setup(); let active!: Promise<boolean>; act(() => { active = confirmDialog({ title: "其他确认", message: "继续保留" }); });
  fireEvent.click(remove()); view.unmount(); fireEvent.click(within(screen.getByRole("dialog", { name: "其他确认" })).getByRole("button", { name: "取消" }));
  await act(async () => { expect(await active).toBe(false); }); expect(screen.queryByRole("dialog")).toBeNull(); expect(writes()).toHaveLength(0);
});
it("基线：确认删除后旧列表不能复活记录，另一投递继续保留", async () => {
  await setup(); fireEvent.click(remove()); confirmRemove(); await waitFor(() => expect(listReads()).toHaveLength(2));
  expect(screen.queryByText(item.company)).toBeNull(); expect(screen.getByText(another.company)).toBeTruthy(); expect(writes()).toHaveLength(1);
});

it.each(["取消", "Escape"])("%s 归还触发按钮焦点，取消后可再次删除", async outcome => {
  await setup(); const button = remove(); button.focus(); fireEvent.click(button);
  if (outcome === "取消") fireEvent.click(within(confirmation()).getByRole("button", { name: "取消" })); else fireEvent.keyDown(document, { key: "Escape" });
  await waitFor(() => expect(document.activeElement).toBe(button)); expect(screen.queryByRole("dialog")).toBeNull(); fireEvent.click(button); expect(confirmation()).toBeTruthy(); expect(writes()).toHaveLength(0);
});
it("删除确认期间同步拦住新建、编辑、阶段推进与面试登记", async () => {
  await setup(); const edit = screen.getAllByTitle("编辑卡片")[0]!; const round = screen.getAllByTitle("添加新面试轮次")[0]!;
  const advance = screen.getAllByRole("button", { name: /推进/ })[0]!;
  act(() => { remove().click(); screen.getByRole("button", { name: /登记新投递/ }).click(); edit.click(); round.click(); advance.click(); });
  expect(screen.getAllByRole("dialog")).toHaveLength(1); expect(confirmation()).toBeTruthy(); expect(targetReads()).toHaveLength(0); expect(writes()).toHaveLength(0);
});
it("等待编辑详情期间删除不能开始，离页中止只读等待", async () => {
  const view = await setup(); const pending = Promise.withResolvers<unknown>(); vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise as never);
  act(() => { screen.getAllByTitle("编辑卡片")[0]!.click(); remove().click(); }); expect(screen.queryByRole("dialog")).toBeNull();
  const signal = targetReads()[0]![1]!.signal; view.unmount(); expect(signal?.aborted).toBe(true); await act(async () => pending.resolve(item)); expect(screen.queryByRole("dialog")).toBeNull();
});
it("新建弹窗可见时旧删除入口不能开始确认", async () => {
  await setup(); const button = remove(); await act(async () => { screen.getByRole("button", { name: /登记新投递/ }).click(); button.click(); });
  expect(screen.queryByRole("dialog", { name: "确认删除投递记录？" })).toBeNull(); expect(screen.getByRole("dialog", { name: "新建求职投递" })).toBeTruthy();
});
it("卡片轮次弹窗也占用页面互斥，关闭后可再次删除", async () => {
  await setup(); const button = remove(); act(() => { screen.getAllByTitle("添加新面试轮次")[0]!.click(); button.click(); });
  expect(screen.queryByRole("dialog", { name: "确认删除投递记录？" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "关闭弹窗" })); fireEvent.click(button); expect(confirmation()).toBeTruthy();
});
it("阶段写入在同一事件中阻止删除，离页的迟到失败不弹出旧提示", async () => {
  const view = await setup(); const pending = Promise.withResolvers<unknown>(); vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise as never);
  act(() => { screen.getAllByTitle("推进至：已投递")[0]!.click(); remove().click(); });
  expect(screen.queryByRole("dialog")).toBeNull(); expect(writes()).toHaveLength(1); expect(writes()[0]![1]!.method).toBe("PATCH");
  view.unmount(); await act(async () => pending.reject(new Error("旧请求失败"))); expect(screen.queryByRole("dialog")).toBeNull();
});
it("编辑前串记录详情不能打开另一投递，失败提示随离页撤销", async () => {
  const view = await setup(); vi.mocked(jsonFetch).mockResolvedValueOnce(another); fireEvent.click(screen.getAllByTitle("编辑卡片")[0]!);
  await screen.findByRole("dialog", { name: "加载投递失败" }); expect(screen.queryByRole("dialog", { name: "编辑求职投递卡片" })).toBeNull(); view.unmount(); expect(screen.queryByRole("dialog")).toBeNull();
});
it.each([{}, { ok: false }, { ok: "true" }])("坏删除确认 %j 只读核对原 ID，仍存在时需重新确认", async result => {
  await setup(); vi.mocked(jsonFetch).mockResolvedValueOnce(result); fireEvent.click(remove()); confirmRemove();
  await screen.findByText(/目前仍存在/); expect(targetReads()).toHaveLength(1); expect(writes()).toHaveLength(1); expect(listReads()).toHaveLength(1); expect(screen.getByText(item.company)).toBeTruthy();
  expect(targetReads()[0]![1]).toEqual(expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) })); fireEvent.click(remove()); expect(confirmation()).toBeTruthy();
});
it.each([new Error("网络中断"), new HttpError("等待超时", 408), new HttpError("暂不可用", 503)])("%s 未知时不能再次写入，手动重读只 GET，404 才移除", async reason => {
  await setup(); vi.mocked(jsonFetch).mockRejectedValueOnce(reason).mockRejectedValueOnce(new Error("核对失败")); fireEvent.click(remove()); confirmRemove();
  const retry = await screen.findByRole("button", { name: "重新读取删除状态" }); expect(screen.getByRole("alert").textContent).toContain("删除结果尚未确认");
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("group", { name: "投递删除状态" })));
  fireEvent.click(remove()); fireEvent.click(screen.getByRole("button", { name: /登记新投递/ })); expect(screen.queryByRole("dialog")).toBeNull(); expect(writes()).toHaveLength(1);
  vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("不存在", 404)); act(() => { retry.click(); retry.click(); });
  await waitFor(() => expect(screen.queryByText(item.company)).toBeNull()); expect(targetReads()).toHaveLength(2); expect(writes()).toHaveLength(1); expect(await screen.findByText(another.company)).toBeTruthy();
});
it.each([null, { ...item, id: 8 }, { ...item, company: undefined }, { ...item, stage: "wrong" }, { ...item, interviews: [null] }, { ...item, stage_history: [null] }, { ...item, preparation_tasks: [null] }])("坏核对 %j 不能解锁或证明仍存在", async result => {
  await setup(); vi.mocked(jsonFetch).mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce(result); fireEvent.click(remove()); confirmRemove();
  await screen.findByRole("button", { name: "重新读取删除状态" }); expect(writes()).toHaveLength(1); expect(screen.getByText(item.company)).toBeTruthy();
  fireEvent.click(remove()); expect(screen.queryByRole("dialog")).toBeNull();
});
it.each([400, 404])("明确 %i 按拒绝或不存在处理，不再 GET", async status => {
  await setup(); vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("明确结果", status)); fireEvent.click(remove()); confirmRemove();
  await waitFor(() => expect(writes()).toHaveLength(1)); await act(async () => {}); expect(targetReads()).toHaveLength(0);
  if (status === 404) await waitFor(() => expect(screen.queryByText(item.company)).toBeNull()); else { expect(screen.getByRole("alert").textContent).toContain("明确结果"); fireEvent.click(remove()); expect(confirmation()).toBeTruthy(); }
});
it("DELETE 等待中离页中止本地等待，迟到坏回复不再 GET 或提示", async () => {
  const view = await setup(); const pending = Promise.withResolvers<unknown>(); vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise as never); fireEvent.click(remove()); confirmRemove();
  await waitFor(() => expect(writes()).toHaveLength(1));
  const signal = writes()[0]![1]!.signal; view.unmount(); expect(signal?.aborted).toBe(true); await act(async () => pending.resolve({ ok: false })); expect(targetReads()).toHaveLength(0); expect(screen.queryByRole("dialog")).toBeNull();
});
