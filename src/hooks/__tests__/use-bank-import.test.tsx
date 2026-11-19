// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBankImport } from "../use-bank-import";
import { confirmDialog } from "@/components/common/confirm-dialog";
import { HttpError, jsonFetch } from "@/lib/fetcher";

vi.mock("@/lib/fetcher", async original => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
vi.mock("@/components/common/confirm-dialog", () => ({ confirmDialog: vi.fn() }));
const raw = "  C++ / C# <T> &amp;\n\n真实题目内部  空格？\nC++ / C# <T> &amp;  ";
const initial = { direction: "  后端:基础  ", kind: "behavior" as const, text: raw };
const row = { id: 41, direction: "后端:基础", kind: "behavior", question: "旧题也不能认领本次写入 <T> &amp;", created_at: "2026-10-29" };
const page = { items: [row], nextCursor: null };
const pending = <T,>() => { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const posts = () => vi.mocked(jsonFetch).mock.calls.filter(([, options]) => options?.method === "POST");
const reads = () => vi.mocked(jsonFetch).mock.calls.filter(([, options]) => options?.method !== "POST");
const refresh = vi.fn();
beforeEach(() => { vi.mocked(confirmDialog).mockResolvedValue(true); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });

function setup() {
  const hook = renderHook(() => useBankImport(refresh));
  act(() => hook.result.current.change(initial));
  return hook;
}

describe("题库导入命令与只读恢复", () => {
  it("同事件变更后立即提交使用最新三项材料；完成后的旧提交函数不能再导入空稿", async () => {
    vi.mocked(jsonFetch).mockResolvedValue({ count: 2 });
    const { result } = renderHook(() => useBankImport(refresh)); const previousSubmit = result.current.submit;
    await act(async () => { result.current.change(initial); await previousSubmit(); });
    expect(posts()).toHaveLength(1);
    expect(posts()[0]?.[1]).toMatchObject({ signal: expect.any(AbortSignal), body: JSON.stringify({ ...initial, direction: "后端:基础" }) });
    expect(result.current.draft).toEqual({ ...initial, text: "" });
    await act(() => previousSubmit()); expect(posts()).toHaveLength(1); expect(refresh).toHaveBeenCalledOnce();
  });

  it("提交仍在途时旧重读入口不能获得允许重试资格，重复提交和原稿修改同步受阻", async () => {
    const response = pending<unknown>(); vi.mocked(jsonFetch).mockReturnValue(response.promise);
    const { result } = setup(); let submit!: Promise<void>;
    act(() => { submit = result.current.submit(); result.current.reread(); result.current.change({ text: "替换" }); void result.current.submit(); });
    expect(reads()).toHaveLength(0); expect(posts()).toHaveLength(1); expect(result.current.draft).toEqual(initial);
    await act(async () => { response.resolve({ count: 2 }); await submit; });
  });

  it("网络失败先读原筛选，不缓存，不能按旧同文题目认领，也不自动重发", async () => {
    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("响应中断")).mockResolvedValueOnce(page);
    const { result } = setup(); await act(() => result.current.submit());
    expect(result.current.phase).toBe("unknown"); expect(result.current.locked).toBe(true); expect(result.current.draft).toEqual(initial);
    expect(result.current.notice?.text).toContain("同文题目不能确认"); expect(result.current.recovery).toEqual(page); expect(posts()).toHaveLength(1);
    const [url, options] = reads()[0]!; const parsed = new URL(String(url), "http://localhost");
    expect(Object.fromEntries(parsed.searchParams)).toEqual({ kind: "behavior", direction: "后端:基础", limit: "50" });
    expect(options).toMatchObject({ cache: "no-store", signal: expect.any(AbortSignal) });
  });

  it.each([new HttpError("服务器异常", 500), new HttpError("等待超时", 408), new Error("网络断开")])("%s 后读取失败仍锁定，恢复成功后取消不放开，再确认只解锁而不自动 POST", async error => {
    vi.mocked(jsonFetch).mockRejectedValueOnce(error).mockRejectedValueOnce(new HttpError("读取失败", 503));
    const { result } = setup(); await act(() => result.current.submit());
    expect(result.current.notice?.text).toContain("读取题库失败"); expect(result.current.recovery).toBeNull();
    await act(() => result.current.allowRetry()); expect(confirmDialog).not.toHaveBeenCalled();
    vi.mocked(jsonFetch).mockResolvedValueOnce(page); await act(async () => result.current.reread());
    await waitFor(() => expect(result.current.recovery).toEqual(page));
    vi.mocked(confirmDialog).mockResolvedValueOnce(false); await act(() => result.current.allowRetry());
    expect(result.current.locked).toBe(true); expect(result.current.draft).toEqual(initial);
    await act(() => result.current.allowRetry());
    expect(confirmDialog).toHaveBeenLastCalledWith(expect.objectContaining({ danger: true, message: expect.stringContaining("可能产生重复") }));
    expect(result.current.phase).toBe("idle"); expect(result.current.draft).toEqual(initial); expect(posts()).toHaveLength(1);
    vi.mocked(jsonFetch).mockResolvedValueOnce({ count: 2 }); await act(() => result.current.submit()); expect(posts()).toHaveLength(2);
  });

  it("重读与允许另导在同一事件互斥，旧成功快照不能绕过正在进行的新读取", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({ count: -1 }).mockResolvedValueOnce(page);
    const { result } = setup(); await act(() => result.current.submit());
    const read = pending<unknown>(); vi.mocked(jsonFetch).mockReturnValueOnce(read.promise);
    await act(async () => { result.current.reread(); result.current.reread(); await result.current.allowRetry(); });
    expect(reads()).toHaveLength(2); expect(confirmDialog).not.toHaveBeenCalled(); expect(result.current.recovery).toBeNull();
    await act(async () => { read.reject(new Error("再次读取失败")); await read.promise.catch(() => {}); });
    await act(() => result.current.allowRetry()); expect(confirmDialog).not.toHaveBeenCalled(); expect(result.current.locked).toBe(true);
  });

  it("允许确认期间不能再次确认、重读、提交或改稿；取消后仍保留原稿和核对结果", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce(null).mockResolvedValueOnce(page);
    const { result } = setup(); await act(() => result.current.submit());
    const confirmation = pending<boolean>(); vi.mocked(confirmDialog).mockReturnValueOnce(confirmation.promise); let allowing!: Promise<void>;
    act(() => { allowing = result.current.allowRetry(); void result.current.allowRetry(); result.current.reread(); void result.current.submit(); result.current.change({ direction: "改方向" }); });
    expect(confirmDialog).toHaveBeenCalledOnce(); expect(reads()).toHaveLength(1); expect(posts()).toHaveLength(1); expect(result.current.draft).toEqual(initial);
    await act(async () => { confirmation.resolve(false); await allowing; });
    expect(result.current.phase).toBe("unknown"); expect(result.current.recovery).toEqual(page);
  });

  it.each(["post", "read"] as const)("离页中止 %s，旧成功不能刷新新实例或改写新原稿", async stage => {
    const old = pending<unknown>();
    if (stage === "read") vi.mocked(jsonFetch).mockResolvedValueOnce({ count: 0 });
    vi.mocked(jsonFetch).mockReturnValueOnce(old.promise);
    const first = setup(); let submission!: Promise<void>; act(() => { submission = first.result.current.submit(); });
    if (stage === "read") await waitFor(() => expect(reads()).toHaveLength(1));
    const oldActions = first.result.current; const signal = vi.mocked(jsonFetch).mock.calls.at(-1)?.[1]?.signal;
    first.unmount(); expect(signal?.aborted).toBe(true);
    const second = setup(); act(() => second.result.current.change({ text: "新页原稿" }));
    await act(async () => { old.resolve(stage === "post" ? { count: 2 } : page); await submission; await oldActions.submit(); oldActions.reread(); await oldActions.allowRetry(); });
    expect(second.result.current.draft.text).toBe("新页原稿"); expect(second.result.current.phase).toBe("idle"); expect(refresh).not.toHaveBeenCalled();
    expect(posts()).toHaveLength(1); expect(reads()).toHaveLength(stage === "read" ? 1 : 0);
  });

  it.each(["post", "read"] as const)("离页后的 %s 失败不能显示新页错误或继续读写", async stage => {
    const old = pending<unknown>();
    if (stage === "read") vi.mocked(jsonFetch).mockResolvedValueOnce(null);
    vi.mocked(jsonFetch).mockReturnValueOnce(old.promise);
    const first = setup(); let submission!: Promise<void>; act(() => { submission = first.result.current.submit(); });
    if (stage === "read") await waitFor(() => expect(reads()).toHaveLength(1));
    first.unmount(); const second = setup();
    await act(async () => { old.reject(new Error("旧失败")); await submission; });
    expect(second.result.current.notice).toBeNull(); expect(second.result.current.draft).toEqual(initial); expect(refresh).not.toHaveBeenCalled();
    expect(posts()).toHaveLength(1); expect(reads()).toHaveLength(stage === "read" ? 1 : 0);
  });

  it("确认后离页，迟到允许结果不能释放新页提交锁或改变原稿", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce(null).mockResolvedValueOnce(page);
    const first = setup(); await act(() => first.result.current.submit());
    const confirmation = pending<boolean>(); vi.mocked(confirmDialog).mockReturnValueOnce(confirmation.promise); let allowing!: Promise<void>;
    act(() => { allowing = first.result.current.allowRetry(); }); first.unmount(); const second = setup();
    const response = pending<unknown>(); vi.mocked(jsonFetch).mockReturnValueOnce(response.promise); let submitting!: Promise<void>; act(() => { submitting = second.result.current.submit(); });
    await act(async () => { confirmation.resolve(true); await allowing; }); expect(second.result.current.phase).toBe("submitting"); expect(second.result.current.draft).toEqual(initial);
    await act(async () => { response.resolve({ count: 2 }); await submitting; });
  });

  it("未指定方向时按题型读取全部方向，不伪造空方向筛选或写入回执", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce(null).mockResolvedValueOnce(page);
    const { result } = setup(); act(() => result.current.change({ direction: " " })); await act(() => result.current.submit());
    expect(new URL(String(reads()[0]?.[0]), "http://localhost").searchParams.has("direction")).toBe(false); expect(result.current.locked).toBe(true);
  });

  it("去重后 501 题不发 POST，500 题可导入，不静默截断原稿", async () => {
    vi.mocked(jsonFetch).mockResolvedValue({ count: 500 }); const { result } = setup();
    const questions = Array.from({ length: 501 }, (_, index) => `题目_${index}`).join("\n");
    act(() => result.current.change({ text: questions })); await act(() => result.current.submit());
    expect(posts()).toHaveLength(0); expect(result.current.draft.text).toBe(questions); expect(result.current.notice?.text).toContain("分批导入");
    const within = questions.split("\n").slice(0, 500).join("\n") + "\n  题目_0  \n\n";
    act(() => result.current.change({ text: within })); await act(() => result.current.submit());
    expect(posts()).toHaveLength(1); expect(JSON.parse(posts()[0]![1]!.body as string).text).toBe(within); expect(result.current.notice?.text).toContain("成功导入 500");
  });
});
