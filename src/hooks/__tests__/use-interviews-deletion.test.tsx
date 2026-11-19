// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogHost, confirmDialog } from "@/components/common/confirm-dialog";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import { useInterviewsPage, type InterviewItem, type SeriesItem } from "../use-interviews-page";

const state = vi.hoisted(() => ({ singles: [] as InterviewItem[], series: [] as SeriesItem[], singleReload: vi.fn(), seriesReload: vi.fn() }));
vi.mock("@/hooks/use-resume-options", () => ({ useResumeOptions: () => ({ resumes: [], resumesError: "", reloadResumes: vi.fn() }) }));
vi.mock("@/hooks/use-cursor-list", () => ({ useCursorList: ({ queryKey }: { queryKey: string }) => {
  const single = queryKey.startsWith("interviews:single:");
  return { items: single ? state.singles : state.series, total: single ? state.singles.length : state.series.length, listError: "", reload: single ? state.singleReload : state.seriesReload, hasMore: false };
} }));
vi.mock("@/lib/fetcher", async original => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
const metadata = { id: 7, jd: "完整 JD <T> &amp;\n".repeat(80), created_at: "旧时间原文", resume_title: "完整简历", resume_version_id: 11, resume_version: 2, resume_version_name: "旧发布版" };
const single = { ...metadata, rounds: 8, answered: 1, style: "gentle", status: "ongoing" };
const series = { ...metadata, rounds_done: 1, rounds_total: 3, final_overall: null, status: "ongoing" };
const detail = (kind: string) => ({ ...metadata, resume_id: 1, rounds: 8, status: "ongoing", finished_at: "", ...(kind === "single"
  ? { series_id: null, round_no: 0, style: "gentle", turns: [{ id: 1, idx: 1, question: "历史长题目".repeat(500), answer: "原答复", comment: "原点评", reference: "", answered_at: "", kind: "question" }] }
  : { rounds_total: 3, entries: [{ interview_id: 3, round_no: 1, style: "gentle", status: "ongoing", rounds: 8, answered: 1, report: null }], final_report: null }) });
beforeEach(() => { state.singles = [single, { ...single, id: 8 }]; state.series = [series]; vi.mocked(jsonFetch).mockResolvedValue({ ok: true }); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });
function setup() { render(<ConfirmDialogHost />); return renderHook(() => useInterviewsPage(null)); }
type Page = ReturnType<typeof setup>;
const remove = (hook: Page, kind: string, id = 7) => kind === "single" ? hook.result.current.remove(id) : hook.result.current.removeSeries(id);
const confirm = () => fireEvent.click(screen.getByRole("dialog").querySelector<HTMLButtonElement>("button:last-child")!);

for (const kind of ["single", "series"]) describe(`${kind} 面试删除归属与核对`, () => {
  it("确认完整记录、一次互斥，并取消时零写入", async () => {
    const hook = setup(); act(() => { void remove(hook, kind); void remove(hook, kind === "single" ? "series" : "single"); });
    const dialog = screen.getByRole("dialog");
    for (const text of ["#7", metadata.jd, metadata.resume_title, metadata.resume_version_name, metadata.created_at]) expect(dialog.textContent).toContain(text);
    fireEvent.click(screen.getByRole("button", { name: "取消" })); await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeNull(); expect(jsonFetch).not.toHaveBeenCalled();
  });
  it("离页关闭本项确认，旧回调不再打开确认或发送删除", async () => {
    const hook = setup(); const methods = hook.result.current; act(() => { void remove(hook, kind); }); hook.unmount();
    expect(screen.queryByRole("dialog")).toBeNull(); await act(async () => { await (kind === "single" ? methods.remove(7) : methods.removeSeries(7)); });
    expect(screen.queryByRole("dialog")).toBeNull(); expect(jsonFetch).not.toHaveBeenCalled();
  });
  it("离页移除排队确认，不影响其他确认", async () => {
    const hook = setup(); act(() => { void confirmDialog({ title: "其他操作", message: "保留此项" }); void remove(hook, kind); });
    hook.unmount(); fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(screen.queryByRole("dialog")).toBeNull(); expect(jsonFetch).not.toHaveBeenCalled();
  });
  it("一次确认只发送一次，刷新带回旧记录也不复活或误删同 ID 的另一类", async () => {
    const hook = setup(); act(() => { void remove(hook, kind); void remove(hook, kind); }); confirm();
    await waitFor(() => expect(kind === "single" ? state.singleReload : state.seriesReload).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog")).toBeNull(); expect(jsonFetch).toHaveBeenCalledOnce(); hook.rerender();
    const remaining = kind === "single" ? hook.result.current.items : hook.result.current.seriesItems;
    const other = kind === "single" ? hook.result.current.seriesItems : hook.result.current.items;
    expect(remaining?.some(item => item.id === 7)).toBe(false); expect(other?.some(item => item.id === 7)).toBe(true);
    await act(async () => { await remove(hook, kind); }); expect(screen.queryByRole("dialog")).toBeNull(); expect(jsonFetch).toHaveBeenCalledOnce();
  });
  for (const response of [{}, { ok: "true" }, new Error("网络中断"), new HttpError("超时", 408), new HttpError("异常", 503)]) it(`异常删除 ${JSON.stringify(response)} 先 GET 核对，不自动重删`, async () => {
    if (response instanceof Error) vi.mocked(jsonFetch).mockRejectedValueOnce(response); else vi.mocked(jsonFetch).mockResolvedValueOnce(response);
    const original = detail(kind); const saved = structuredClone(original); vi.mocked(jsonFetch).mockResolvedValueOnce(original);
    const hook = setup(); let operation!: Promise<void>; act(() => { operation = remove(hook, kind); }); confirm(); await act(() => operation);
    expect(jsonFetch).toHaveBeenCalledTimes(2); expect(vi.mocked(jsonFetch).mock.calls[1]![1]).toMatchObject({ cache: "no-store" });
    expect(state.singleReload).not.toHaveBeenCalled(); expect(state.seriesReload).not.toHaveBeenCalled(); expect(original).toEqual(saved);
    expect((kind === "single" ? hook.result.current.items : hook.result.current.seriesItems)?.some(item => item.id === 7)).toBe(true);
  });
  for (const response of [null, { id: 7 }, { ...detail(kind), id: 8 }, { ...detail(kind), resume_version_name: null },
    { ...detail(kind), ...(kind === "single" ? { turns: [{ id: 1 }] } : { entries: [{ interview_id: 3 }] }) },
  ]) it(`核对响应损坏 ${JSON.stringify(response).slice(0, 45)} 保留记录，仅能重读`, async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({}).mockResolvedValueOnce(response); const hook = setup();
    let operation!: Promise<void>; act(() => { operation = remove(hook, kind); }); confirm(); await act(() => operation);
    act(() => { void remove(hook, kind); void remove(hook, kind === "single" ? "series" : "single"); });
    expect(jsonFetch).toHaveBeenCalledTimes(2); expect(screen.queryByRole("dialog")).toBeNull();
    expect(state.singleReload).not.toHaveBeenCalled(); expect(state.seriesReload).not.toHaveBeenCalled();
  });
  it("旧记录缺发布版、历史长正文和 null 报告仍能核对，原文不改写", async () => {
    const existing = { ...detail(kind), resume_version_id: null, resume_version: null, resume_version_name: null, report: null, evaluator_report: null };
    const saved = structuredClone(existing); vi.mocked(jsonFetch).mockResolvedValueOnce({}).mockResolvedValueOnce(existing);
    const hook = setup(); let operation!: Promise<void>; act(() => { operation = remove(hook, kind); }); confirm(); await act(() => operation);
    expect(hook.result.current.deletion.canStart()).toBe(true); expect(existing).toEqual(saved);
    expect((kind === "single" ? hook.result.current.deletion.single : hook.result.current.deletion.series).error).toContain("目前仍存在");
  });
  for (const phase of ["delete", "check"]) it(`离页中止 ${phase}，迟到成功不刷新新页面`, async () => {
    const pending = Promise.withResolvers<unknown>();
    if (phase === "check") vi.mocked(jsonFetch).mockResolvedValueOnce({}); vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
    const hook = setup(); let operation!: Promise<void>; act(() => { operation = remove(hook, kind); }); confirm();
    await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(phase === "delete" ? 1 : 2));
    const signal = vi.mocked(jsonFetch).mock.lastCall?.[1]?.signal; hook.unmount();
    await act(async () => { pending.resolve(phase === "delete" ? { ok: true } : detail(kind)); await operation; });
    expect(state.singleReload).not.toHaveBeenCalled(); expect(state.seriesReload).not.toHaveBeenCalled(); expect(signal?.aborted).toBe(true);
  });
  it("未知结果仅重读，重复读取互斥，404 后过滤旧页并正确更新总数", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({}).mockRejectedValueOnce(new HttpError("读取失败", 503));
    const hook = setup(); let operation!: Promise<void>; act(() => { operation = remove(hook, kind); }); confirm(); await act(() => operation);
    expect(hook.result.current.deletion.canStart()).toBe(false);
    const pending = Promise.withResolvers<unknown>(); vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
    const command = kind === "single" ? hook.result.current.deletion.single : hook.result.current.deletion.series;
    act(() => { command.retryCheck(); command.retryCheck(); }); expect(jsonFetch).toHaveBeenCalledTimes(3);
    await act(async () => { pending.reject(new HttpError("不存在", 404)); });
    expect(hook.result.current.deletion.canStart()).toBe(true); expect(hook.result.current.totalCount).toBe(2);
    if (kind === "single") state.singles = state.singles.filter(item => item.id !== 7); else state.series = [];
    hook.rerender(); expect(hook.result.current.totalCount).toBe(2);
  });
  it("DELETE 404 直接确认不存在，明确拒绝则保留记录且不核对", async () => {
    vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("不存在", 404));
    const hook = setup(); let operation!: Promise<void>; act(() => { operation = remove(hook, kind); }); confirm(); await act(() => operation);
    expect(kind === "single" ? state.singleReload : state.seriesReload).toHaveBeenCalledOnce();
    const otherKind = kind === "single" ? "series" : "single"; vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("明确拒绝", 409));
    act(() => { operation = remove(hook, otherKind); }); confirm(); await act(() => operation);
    expect(jsonFetch).toHaveBeenCalledTimes(2); expect(hook.result.current.deletion.canStart()).toBe(true);
    expect((otherKind === "single" ? hook.result.current.deletion.single : hook.result.current.deletion.series).error).toContain("明确拒绝");
  });
});
