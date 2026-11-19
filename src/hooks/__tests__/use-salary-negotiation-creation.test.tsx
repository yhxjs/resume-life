// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import { useSalaryNegotiationCreation, type SalaryNegotiationStartInput } from "../use-salary-negotiation-creation";
import { SALARY_CREATION_STORAGE_KEY, savePendingSalaryCreation } from "@/lib/salary-creation-storage";

vi.mock("@/lib/fetcher", async (original) => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
afterEach(() => { cleanup(); sessionStorage.clear(); vi.restoreAllMocks(); vi.resetAllMocks(); });

function input(): SalaryNegotiationStartInput {
  return { target_company_tier: "自定义场景 <T>", target_role: "接口工程师", expected_salary: "税前30k，薪数未确认",
    current_or_competing_offer: "原始筹码 <T> &amp;\n只是询价，尚未承诺", hr_style: "standard" };
}
function saved() {
  return { ...input(), id: 7, revision: "a".repeat(64), status: "ongoing", initial_offer: "模拟开价，尚未确认", final_package: "", report: null, created_at: "2026-10-29", finished_at: "",
    turns: [{ id: 71, negotiation_id: 7, turn_no: 1, user_message: "", hr_response: "模拟开场，先核对薪数", hr_tactics: "澄清",
      hr_mindset: { looseness: 20, current_attitude: "模拟态度", estimated_package: "模拟方案", tactics_label: "澄清", internal_pressure: "模拟预算" },
      mentor_analysis: { user_argument_score: 5, strengths: ["提供了期望"], vulnerabilities: ["薪数未知"], tactical_tips: "先核对保证现金",
        suggested_replies: [{ title: "核对", content: "请确认保证薪数", rationale: "区分保证与浮动" }] }, created_at: "2026-10-29" }] };
}
function options(historyReady = true) { return { historyReady, onCreated: vi.fn(), onUnknown: vi.fn() }; }
function requestReceipt(id = 7) {
  const { requestId } = JSON.parse(sessionStorage.getItem(SALARY_CREATION_STORAGE_KEY)!);
  return { request_id: requestId, status: "succeeded", id };
}

describe("谈薪创建的提交快照及只读核对", () => {
  it.each(["replaced", "changed", "generation", "broken", "removed"])("详情等待期间暂存 %s，旧结果不导航或清理新记录", async mode => {
    const detail = Promise.withResolvers<unknown>(); const props = options();
    vi.mocked(jsonFetch).mockResolvedValueOnce({ id: 7 }).mockImplementationOnce(async () => requestReceipt()).mockReturnValueOnce(detail.promise);
    const hook = renderHook(() => useSalaryNegotiationCreation(props));
    let done!: Promise<void>; act(() => { done = hook.result.current.start(input()); });
    await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(3));
    const value = JSON.parse(sessionStorage.getItem(SALARY_CREATION_STORAGE_KEY)!);
    if (mode === "replaced") value.requestId = crypto.randomUUID();
    if (mode === "changed") value.snapshot.current_or_competing_offer += " 当前记录另有补充";
    if (mode === "generation") value.generation = "another-generation";
    if (mode === "removed") sessionStorage.removeItem(SALARY_CREATION_STORAGE_KEY);
    else sessionStorage.setItem(SALARY_CREATION_STORAGE_KEY, mode === "broken" ? "{新的损坏原文" : JSON.stringify(value));
    const raw = sessionStorage.getItem(SALARY_CREATION_STORAGE_KEY);
    await act(async () => { detail.resolve(saved()); await done; });
    expect(props.onCreated).not.toHaveBeenCalled();
    expect(hook.result.current.phase).toBe("unknown"); expect(hook.result.current.canStart()).toBe(false);
    expect(sessionStorage.getItem(SALARY_CREATION_STORAGE_KEY)).toBe(raw);
    act(() => hook.result.current.reviewUnresolved());
    act(() => hook.result.current.allowRetry());
    expect(hook.result.current.canStart()).toBe(false);
    expect(sessionStorage.getItem(SALARY_CREATION_STORAGE_KEY)).toBe(raw);
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("损坏恢复信息被另一命令替换后，旧的人工核对不能清理新命令", async () => {
    sessionStorage.setItem(SALARY_CREATION_STORAGE_KEY, "{待人工核对的原文");
    const hook = renderHook(() => useSalaryNegotiationCreation(options()));
    await waitFor(() => expect(hook.result.current.phase).toBe("review"));
    const next = { requestId: crypto.randomUUID(), snapshot: input() };
    savePendingSalaryCreation(next); const raw = sessionStorage.getItem(SALARY_CREATION_STORAGE_KEY);
    act(() => hook.result.current.allowRetry());
    expect(hook.result.current.canStart()).toBe(false);
    expect(sessionStorage.getItem(SALARY_CREATION_STORAGE_KEY)).toBe(raw);
    expect(jsonFetch).not.toHaveBeenCalled();
  });

  it("初始化无法读取暂存时，恢复读取能力后也不能盲删未经核对的新命令", async () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("初始化读取被拒绝"); });
    const hook = renderHook(() => useSalaryNegotiationCreation(options()));
    await waitFor(() => expect(hook.result.current.phase).toBe("review"));
    get.mockRestore();
    savePendingSalaryCreation({ requestId: crypto.randomUUID(), snapshot: input() });
    const raw = sessionStorage.getItem(SALARY_CREATION_STORAGE_KEY);
    act(() => hook.result.current.allowRetry());
    expect(hook.result.current.canStart()).toBe(false);
    expect(hook.result.current.error).toContain("请刷新页面");
    expect(sessionStorage.getItem(SALARY_CREATION_STORAGE_KEY)).toBe(raw); expect(jsonFetch).not.toHaveBeenCalled();
  });

  it("明确拒绝后暂存已被替换时继续锁定，不静默允许新建覆盖另一请求", async () => {
    const write = Promise.withResolvers<unknown>(); vi.mocked(jsonFetch).mockReturnValueOnce(write.promise);
    const hook = renderHook(() => useSalaryNegotiationCreation(options()));
    let done!: Promise<void>; act(() => { done = hook.result.current.start(input()); });
    savePendingSalaryCreation({ requestId: crypto.randomUUID(), snapshot: { ...input(), target_role: "新命令" } });
    const raw = sessionStorage.getItem(SALARY_CREATION_STORAGE_KEY);
    await act(async () => { write.reject(new HttpError("明确拒绝旧请求", 400)); await done; });
    expect(hook.result.current.canStart()).toBe(false); expect(hook.result.current.phase).toBe("review");
    act(() => hook.result.current.allowRetry());
    expect(hook.result.current.canStart()).toBe(false); expect(sessionStorage.getItem(SALARY_CREATION_STORAGE_KEY)).toBe(raw);
    expect(jsonFetch).toHaveBeenCalledOnce();
  });

  it("408 超时不能撤销原命令，刷新保留原编号并只读找回已保存的结果", async () => {
    vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("请求超时，结果未知", 408));
    const props = options(); const hook = renderHook(() => useSalaryNegotiationCreation(props));
    await act(() => hook.result.current.start(input()));
    expect(hook.result.current.canStart()).toBe(false);
    expect(hook.result.current.phase).toBe("review");
    const raw = sessionStorage.getItem(SALARY_CREATION_STORAGE_KEY)!;
    expect(JSON.parse(raw).snapshot).toEqual(input());
    const { requestId } = JSON.parse(raw);
    await act(() => hook.result.current.start(input()));
    expect(jsonFetch).toHaveBeenCalledOnce(); expect(props.onUnknown).toHaveBeenCalledOnce();
    hook.unmount();
    const restored = { ...options(), onRestore: vi.fn() };
    const next = renderHook(() => useSalaryNegotiationCreation(restored));
    await waitFor(() => expect(next.result.current.phase).toBe("unknown"));
    expect(restored.onRestore).toHaveBeenCalledExactlyOnceWith(input());
    expect(sessionStorage.getItem(SALARY_CREATION_STORAGE_KEY)).toBe(raw);
    vi.mocked(jsonFetch).mockResolvedValueOnce({ request_id: requestId, status: "succeeded", id: 7 }).mockResolvedValueOnce(saved());
    await act(async () => { next.result.current.retryCheck(); });
    await waitFor(() => expect(restored.onCreated).toHaveBeenCalledExactlyOnceWith(7));
    expect(vi.mocked(jsonFetch).mock.calls[1]![0]).toBe(`/api/tools/salary-negotiations/requests/${requestId}`);
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(sessionStorage.getItem(SALARY_CREATION_STORAGE_KEY)).toBeNull();
  });

  it.each(["read", "allow", "review-and-allow"])("旧恢复回调 %s 不能抢跑新的 POST，或在导航后重新核对", async mode => {
    const requestId = crypto.randomUUID(); savePendingSalaryCreation({ requestId, snapshot: input() });
    const props = options(); const hook = renderHook(() => useSalaryNegotiationCreation(props));
    await waitFor(() => expect(hook.result.current.phase).toBe("unknown"));
    const oldReview = hook.result.current.reviewUnresolved;
    const oldCheck = hook.result.current.retryCheck;
    act(() => hook.result.current.reviewUnresolved());
    const oldAllow = hook.result.current.allowRetry;
    act(() => hook.result.current.allowRetry());
    const write = Promise.withResolvers<unknown>();
    vi.mocked(jsonFetch).mockReturnValueOnce(write.promise).mockImplementationOnce(async () => requestReceipt()).mockResolvedValueOnce(saved());
    let done!: Promise<void>;
    act(() => { done = hook.result.current.start(input()); });
    const raw = sessionStorage.getItem(SALARY_CREATION_STORAGE_KEY);
    act(() => {
      if (mode === "read") oldCheck();
      else if (mode === "allow") oldAllow();
      else { oldReview(); oldAllow(); }
    });
    expect(hook.result.current.phase).toBe("posting"); expect(hook.result.current.canStart()).toBe(false);
    expect(sessionStorage.getItem(SALARY_CREATION_STORAGE_KEY)).toBe(raw);
    expect(jsonFetch).toHaveBeenCalledOnce();
    await act(async () => { write.resolve({ id: 7 }); await done; });
    expect(props.onCreated).toHaveBeenCalledExactlyOnceWith(7);
    expect(hook.result.current.phase).toBe("navigating");
    const calls = vi.mocked(jsonFetch).mock.calls.length;
    act(() => { oldCheck(); oldReview(); oldAllow(); });
    expect(jsonFetch).toHaveBeenCalledTimes(calls); expect(hook.result.current.phase).toBe("navigating");
    expect(props.onUnknown).toHaveBeenCalledOnce();
  });

  it("创建响应串到同背景的旧演练时不能认领，重读按请求编号找回实际创建", async () => {
    const other = { ...saved(), id: 8, turns: saved().turns.map(turn => ({ ...turn, id: 81, negotiation_id: 8 })) };
    vi.mocked(jsonFetch).mockImplementation(async (url, init) => {
      if (init?.method === "POST") return { id: 8 };
      if (url.includes("/requests/")) return requestReceipt();
      return url.endsWith("/8") ? other : saved();
    });
    const props = options(); const hook = renderHook(() => useSalaryNegotiationCreation(props));
    await act(() => hook.result.current.start(input()));
    expect(props.onCreated).not.toHaveBeenCalled();
    expect(hook.result.current.error).toContain("创建响应与请求回执记录不符");
    expect(sessionStorage.getItem(SALARY_CREATION_STORAGE_KEY)).not.toBeNull();
    expect(vi.mocked(jsonFetch).mock.calls.some(([url]) => url.endsWith("/8"))).toBe(false);
    await act(async () => { hook.result.current.retryCheck(); });
    await waitFor(() => expect(props.onCreated).toHaveBeenCalledExactlyOnceWith(7));
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(vi.mocked(jsonFetch).mock.calls.filter(([url]) => url.includes("/requests/"))).toHaveLength(2);
  });

  it("有效创建 ID 也必须核对回执，处理中不能借同背景历史提前导航", async () => {
    let pending = true;
    vi.mocked(jsonFetch).mockImplementation(async (url, init) => {
      if (init?.method === "POST") return { id: 7 };
      if (url.includes("/requests/")) return { ...requestReceipt(), status: pending ? "pending" : "succeeded" };
      return saved();
    });
    const props = options(); const hook = renderHook(() => useSalaryNegotiationCreation(props));
    await act(() => hook.result.current.start(input()));
    expect(props.onCreated).not.toHaveBeenCalled(); expect(hook.result.current.error).toContain("仍在处理中");
    expect(jsonFetch).toHaveBeenCalledTimes(2);
    pending = false; await act(async () => { hook.result.current.retryCheck(); });
    await waitFor(() => expect(props.onCreated).toHaveBeenCalledExactlyOnceWith(7));
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("回执曾指向坏背景时重读必须重新核对编号，不能被错误记录 ID 永久锁住", async () => {
    let reads = 0;
    vi.mocked(jsonFetch).mockImplementation(async (url, init) => {
      if (init?.method === "POST") return { id: 8 };
      if (url.includes("/requests/")) return requestReceipt(++reads === 1 ? 8 : 7);
      if (url.endsWith("/8")) return { ...saved(), id: 8, target_role: "另一岗位", turns: saved().turns.map(turn => ({ ...turn, id: 81, negotiation_id: 8 })) };
      return saved();
    });
    const props = options(); const hook = renderHook(() => useSalaryNegotiationCreation(props));
    await act(() => hook.result.current.start(input()));
    expect(hook.result.current.error).toContain("背景不符"); expect(props.onCreated).not.toHaveBeenCalled();
    await act(async () => { hook.result.current.retryCheck(); });
    await waitFor(() => expect(props.onCreated).toHaveBeenCalledExactlyOnceWith(7));
    expect(reads).toBe(2); expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it.each(["missing", "unavailable", "wrong-request", "bad-id", "bad-status", "null", "array"])("POST 返回有效 ID，但回执 %s 时保留表单和锁，只读重试后才能导航", async (mode) => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({ id: 7 });
    if (mode === "missing" || mode === "unavailable") vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("回执读取失败", mode === "missing" ? 404 : 503));
    else vi.mocked(jsonFetch).mockImplementationOnce(async () => mode === "null" ? null : mode === "array" ? [] : {
      ...requestReceipt(), request_id: mode === "wrong-request" ? crypto.randomUUID() : requestReceipt().request_id,
      id: mode === "bad-id" ? "7" : 7, status: mode === "bad-status" ? "unknown" : "succeeded",
    });
    const props = options(); const hook = renderHook(() => useSalaryNegotiationCreation(props));
    await act(() => hook.result.current.start(input()));
    expect(hook.result.current.phase).toBe("unknown"); expect(hook.result.current.canStart()).toBe(false);
    expect(props.onCreated).not.toHaveBeenCalled(); expect(props.onUnknown).not.toHaveBeenCalled();
    expect(jsonFetch).toHaveBeenCalledTimes(2); expect(sessionStorage.getItem(SALARY_CREATION_STORAGE_KEY)).not.toBeNull();
    vi.mocked(jsonFetch).mockImplementationOnce(async () => requestReceipt()).mockResolvedValueOnce(saved());
    await act(async () => { hook.result.current.retryCheck(); });
    await waitFor(() => expect(props.onCreated).toHaveBeenCalledExactlyOnceWith(7));
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("失联的处理中请求可显式转为历史核对，但不能借此自动重发或立即新建", async () => {
    const requestId = crypto.randomUUID(); savePendingSalaryCreation({ requestId, snapshot: input() });
    const props = options(false); const hook = renderHook(value => useSalaryNegotiationCreation(value), { initialProps: props });
    await waitFor(() => expect(hook.result.current.phase).toBe("unknown"));
    act(() => hook.result.current.reviewUnresolved());
    expect(hook.result.current.error).toContain("不会撤销原请求"); expect(props.onUnknown).toHaveBeenCalledOnce();
    act(() => hook.result.current.allowRetry()); expect(hook.result.current.phase).toBe("review");
    hook.rerender({ ...props, historyReady: true }); act(() => hook.result.current.allowRetry());
    expect(hook.result.current.phase).toBe("idle"); expect(jsonFetch).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(SALARY_CREATION_STORAGE_KEY)).toBeNull();
  });

  it("历史核对状态开始读取回执后，同事件的允许重建不能解除同步锁或清除原请求", async () => {
    const requestId = crypto.randomUUID(); savePendingSalaryCreation({ requestId, snapshot: input() });
    const hook = renderHook(() => useSalaryNegotiationCreation(options()));
    await waitFor(() => expect(hook.result.current.phase).toBe("unknown"));
    act(() => hook.result.current.reviewUnresolved()); expect(hook.result.current.phase).toBe("review");
    const receipt = Promise.withResolvers<unknown>(); vi.mocked(jsonFetch).mockReturnValueOnce(receipt.promise);
    act(() => { hook.result.current.retryCheck(); hook.result.current.allowRetry(); void hook.result.current.start(input()); });
    expect(hook.result.current.phase).toBe("checking"); expect(jsonFetch).toHaveBeenCalledOnce();
    expect(JSON.parse(sessionStorage.getItem(SALARY_CREATION_STORAGE_KEY)!).requestId).toBe(requestId);
    await act(async () => { receipt.resolve({ request_id: requestId, status: "failed" }); });
    expect(hook.result.current.phase).toBe("review");
    act(() => hook.result.current.allowRetry()); expect(hook.result.current.phase).toBe("idle");
    expect(sessionStorage.getItem(SALARY_CREATION_STORAGE_KEY)).toBeNull(); expect(jsonFetch).toHaveBeenCalledOnce();
  });

  it("提交编号在 POST 前持久化，刷新只读恢复背景和结果，不自动重发", async () => {
    const props = options(); const pending = Promise.withResolvers<unknown>();
    vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
    const original = renderHook(() => useSalaryNegotiationCreation(props));
    act(() => { void original.result.current.start(input()); });
    const requestId = JSON.parse(sessionStorage.getItem(SALARY_CREATION_STORAGE_KEY)!).requestId;
    expect(vi.mocked(jsonFetch).mock.calls[0]![1]!.headers).toMatchObject({ "Idempotency-Key": requestId });
    original.unmount();
    const restored = { ...options(), onRestore: vi.fn() };
    const next = renderHook(() => useSalaryNegotiationCreation(restored));
    await waitFor(() => expect(next.result.current.phase).toBe("unknown"));
    expect(restored.onRestore).toHaveBeenCalledExactlyOnceWith(input());
    expect(jsonFetch).toHaveBeenCalledOnce(); expect(next.result.current.canStart()).toBe(false);
    vi.mocked(jsonFetch).mockResolvedValueOnce({ request_id: requestId, status: "succeeded", id: 7 }).mockResolvedValueOnce(saved());
    await act(async () => { next.result.current.retryCheck(); });
    await waitFor(() => expect(restored.onCreated).toHaveBeenCalledExactlyOnceWith(7));
    expect(vi.mocked(jsonFetch).mock.calls[1]![0]).toBe(`/api/tools/salary-negotiations/requests/${requestId}`);
    expect(sessionStorage.getItem(SALARY_CREATION_STORAGE_KEY)).toBeNull();
    await act(async () => pending.resolve({ id: 8 }));
    expect(props.onCreated).not.toHaveBeenCalled(); expect(jsonFetch).toHaveBeenCalledTimes(3);
  });

  it.each(["pending", "bad-id", "bad-status", "wrong-request", "missing"])("恢复回执 %s 保留同步锁，不重新创建", async (status) => {
    const requestId = crypto.randomUUID(); savePendingSalaryCreation({ requestId, snapshot: input() });
    const props = options(); const hook = renderHook(() => useSalaryNegotiationCreation(props));
    await waitFor(() => expect(hook.result.current.phase).toBe("unknown"));
    if (status === "missing") vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("未找到", 404));
    else vi.mocked(jsonFetch).mockResolvedValueOnce({ request_id: status === "wrong-request" ? crypto.randomUUID() : requestId,
      status: status === "pending" ? status : status === "bad-status" ? "unknown" : "succeeded", id: status === "bad-id" ? "7" : 7 });
    await act(async () => { hook.result.current.retryCheck(); hook.result.current.retryCheck(); });
    expect(hook.result.current.phase).toBe("unknown"); expect(hook.result.current.canStart()).toBe(false);
    expect(props.onCreated).not.toHaveBeenCalled(); expect(jsonFetch).toHaveBeenCalledOnce();
    expect(sessionStorage.getItem(SALARY_CREATION_STORAGE_KEY)).not.toBeNull();
  });

  it.each(["failed", "deleted"])("%s 回执仍须核对历史及显式允许，新创建使用新编号", async (status) => {
    const requestId = crypto.randomUUID(); savePendingSalaryCreation({ requestId, snapshot: input() });
    const props = options(false); const hook = renderHook(value => useSalaryNegotiationCreation(value), { initialProps: props });
    await waitFor(() => expect(hook.result.current.phase).toBe("unknown"));
    vi.mocked(jsonFetch).mockResolvedValueOnce({ request_id: requestId, status });
    await act(async () => { hook.result.current.retryCheck(); });
    expect(hook.result.current.phase).toBe("review"); expect(props.onUnknown).toHaveBeenCalledOnce();
    act(() => hook.result.current.allowRetry()); expect(hook.result.current.phase).toBe("review");
    hook.rerender({ ...props, historyReady: true }); act(() => hook.result.current.allowRetry());
    expect(sessionStorage.getItem(SALARY_CREATION_STORAGE_KEY)).toBeNull();
    vi.mocked(jsonFetch).mockResolvedValueOnce({ id: 7 }).mockImplementationOnce(async () => requestReceipt()).mockResolvedValueOnce(saved());
    await act(() => hook.result.current.start(input()));
    expect((vi.mocked(jsonFetch).mock.calls[1]![1]!.headers as Record<string, string>)["Idempotency-Key"]).not.toBe(requestId);
  });

  it("无法暂存恢复信息时不提交，损坏恢复信息须显式核对后清除", async () => {
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    const hook = renderHook(() => useSalaryNegotiationCreation(options()));
    await act(() => hook.result.current.start(input()));
    expect(jsonFetch).not.toHaveBeenCalled(); expect(hook.result.current.error).toContain("本次未提交");
    hook.unmount(); set.mockRestore();
    sessionStorage.setItem(SALARY_CREATION_STORAGE_KEY, "{broken");
    const next = renderHook(() => useSalaryNegotiationCreation(options()));
    await waitFor(() => expect(next.result.current.phase).toBe("review"));
    expect(next.result.current.canStart()).toBe(false);
    act(() => next.result.current.allowRetry());
    expect(next.result.current.phase).toBe("idle"); expect(sessionStorage.getItem(SALARY_CREATION_STORAGE_KEY)).toBeNull();
  });

  it("同步锁覆盖创建、详情核对及导航；使用原始快照，重复触发不新增请求", async () => {
    const write = Promise.withResolvers<unknown>(); const receipt = Promise.withResolvers<unknown>(); const read = Promise.withResolvers<unknown>();
    const value = input(); const snapshot = structuredClone(value); const props = options();
    vi.mocked(jsonFetch).mockReturnValueOnce(write.promise).mockReturnValueOnce(receipt.promise).mockReturnValueOnce(read.promise);
    const hook = renderHook(() => useSalaryNegotiationCreation(props)); let command!: Promise<void>;
    act(() => { command = hook.result.current.start(value); void hook.result.current.start(value); });
    value.target_role = "调用方等待期间变更";
    expect(jsonFetch).toHaveBeenCalledOnce(); expect(hook.result.current.phase).toBe("posting");
    expect(vi.mocked(jsonFetch).mock.calls[0]![1]).toMatchObject({ method: "POST", body: JSON.stringify(snapshot), signal: expect.any(AbortSignal) });
    await act(async () => { write.resolve({ id: 7 }); await write.promise; });
    expect(hook.result.current.phase).toBe("checking");
    await act(() => hook.result.current.start(input())); expect(jsonFetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(jsonFetch).mock.calls[1]).toEqual([expect.stringMatching(/\/requests\//), expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) })]);
    await act(async () => { receipt.resolve(requestReceipt()); });
    expect(vi.mocked(jsonFetch).mock.calls[2]).toEqual(["/api/tools/salary-negotiations/7", expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) })]);
    await act(() => hook.result.current.start(input())); expect(jsonFetch).toHaveBeenCalledTimes(3);
    await act(async () => { read.resolve(saved()); await command; });
    expect(props.onCreated).toHaveBeenCalledExactlyOnceWith(7); expect(hook.result.current.phase).toBe("navigating");
    await act(() => hook.result.current.start(input())); expect(jsonFetch).toHaveBeenCalledTimes(3);
  });

  it.each(["target_role", "expected_salary"] as const)("缺失 %s 本地拒绝，不调用模型", async (field) => {
    const props = options(); const hook = renderHook(() => useSalaryNegotiationCreation(props));
    await act(() => hook.result.current.start({ ...input(), [field]: "  \n" }));
    expect(jsonFetch).not.toHaveBeenCalled(); expect(hook.result.current.phase).toBe("idle");
    expect(hook.result.current.error).toBe("请填写目标岗位与期望薪资");
  });

  it.each([null, [], {}, { id: "7" }, { id: 0 }, { id: -1 }, { id: 1.5 }, { id: Number.MAX_SAFE_INTEGER + 1 }])(
    "创建 ID 异常 %j 不导航、不猜测同文记录；历史核对前锁住重复创建", async (response) => {
      const props = options(false); vi.mocked(jsonFetch).mockResolvedValueOnce(response);
      const hook = renderHook((value) => useSalaryNegotiationCreation(value), { initialProps: props });
      await act(() => hook.result.current.start(input()));
      expect(props.onCreated).not.toHaveBeenCalled(); expect(props.onUnknown).toHaveBeenCalledOnce(); expect(hook.result.current.phase).toBe("review");
      await act(async () => { hook.result.current.allowRetry(); await hook.result.current.start(input()); });
      expect(jsonFetch).toHaveBeenCalledOnce(); expect(hook.result.current.phase).toBe("review");
      hook.rerender({ ...props, historyReady: true });
      act(() => hook.result.current.allowRetry());
      expect(hook.result.current.phase).toBe("idle"); expect(hook.result.current.notice).toContain("此前请求仍可能已保存");
      expect(jsonFetch).toHaveBeenCalledOnce();
      vi.mocked(jsonFetch).mockResolvedValueOnce({ id: 7 }).mockImplementationOnce(async () => requestReceipt()).mockResolvedValueOnce(saved());
      await act(() => hook.result.current.start(input()));
      expect(props.onCreated).toHaveBeenCalledExactlyOnceWith(7);
      expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
    },
  );

  it.each([new Error("网络断连"), new HttpError("请求超时", 408), new HttpError("服务失败", 503), new HttpError("上游失败", 502), new HttpError("状态冲突", 409)])(
    "未知创建结果 %s 保留待核对状态，不自动再次 POST", async (error) => {
      const props = options(); vi.mocked(jsonFetch).mockRejectedValueOnce(error);
      const hook = renderHook(() => useSalaryNegotiationCreation(props)); await act(() => hook.result.current.start(input()));
      expect(hook.result.current.phase).toBe("review"); expect(hook.result.current.error).toContain("仍可能已经保存");
      await act(() => hook.result.current.start(input())); expect(jsonFetch).toHaveBeenCalledOnce(); expect(props.onUnknown).toHaveBeenCalledOnce();
    },
  );

  it.each([400, 401, 403, 413, 422])("明确 %s 拒绝允许修改重试，不核对不存在的创建 ID", async (status) => {
    const props = options(); vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("明确拒绝", status));
    const hook = renderHook(() => useSalaryNegotiationCreation(props)); await act(() => hook.result.current.start(input()));
    expect(hook.result.current.phase).toBe("idle"); expect(hook.result.current.error).toBe("明确拒绝");
    expect(props.onUnknown).not.toHaveBeenCalled(); expect(jsonFetch).toHaveBeenCalledOnce();
  });

  const invalidHistories = [null, { ...saved(), id: 8 }, ...Object.keys(input()).map((key) => ({ ...saved(), [key]: "另一份背景" })),
    { ...saved(), turns: [] }, { ...saved(), turns: [{ ...saved().turns[0]!, negotiation_id: 8 }] },
    { ...saved(), turns: [{ ...saved().turns[0]!, turn_no: 2 }] }, { ...saved(), turns: [{ ...saved().turns[0]!, user_message: "旧候选人发言" }] },
    { ...saved(), turns: [{ ...saved().turns[0]!, mentor_analysis: {} }] }, { ...saved(), created_at: "" },
    { ...saved(), initial_offer: "" }, { ...saved(), turns: [{ ...saved().turns[0]!, created_at: "另一时刻" }] }];
  it.each(invalidHistories)("创建后核对异常 %# 保留 ID，只读重试互斥且不重复调用模型", async (invalid) => {
    const props = options(); vi.mocked(jsonFetch).mockResolvedValueOnce({ id: 7 }).mockImplementationOnce(async () => requestReceipt()).mockResolvedValueOnce(invalid);
    const hook = renderHook(() => useSalaryNegotiationCreation(props)); await act(() => hook.result.current.start(input()));
    expect(hook.result.current.phase).toBe("unknown"); expect(props.onCreated).not.toHaveBeenCalled(); expect(props.onUnknown).not.toHaveBeenCalled();
    const read = Promise.withResolvers<unknown>(); vi.mocked(jsonFetch).mockReturnValueOnce(read.promise).mockResolvedValueOnce(saved());
    act(() => { hook.result.current.retryCheck(); hook.result.current.retryCheck(); hook.result.current.allowRetry(); void hook.result.current.start(input()); });
    expect(jsonFetch).toHaveBeenCalledTimes(4);
    await act(async () => { read.resolve(requestReceipt()); await read.promise; });
    expect(props.onCreated).toHaveBeenCalledExactlyOnceWith(7); expect(hook.result.current.phase).toBe("navigating");
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it.each(["posting", "receipt", "detail"] as const)("离页中止 %s，旧成功或失败不能导航、刷新或解锁新页", async (phase) => {
    for (const fails of [false, true]) {
      sessionStorage.clear();
      vi.mocked(jsonFetch).mockReset(); const props = options(); const pending = Promise.withResolvers<unknown>();
      if (phase !== "posting") vi.mocked(jsonFetch).mockResolvedValueOnce({ id: 7 });
      if (phase === "detail") vi.mocked(jsonFetch).mockImplementationOnce(async () => requestReceipt());
      vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
      const hook = renderHook(() => useSalaryNegotiationCreation(props)); let command!: Promise<void>;
      act(() => { command = hook.result.current.start(input()); });
      const callCount = phase === "posting" ? 1 : phase === "receipt" ? 2 : 3;
      await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(callCount));
      const response = phase === "posting" ? { id: 7 } : phase === "receipt" ? requestReceipt() : saved();
      const signal = vi.mocked(jsonFetch).mock.lastCall![1]!.signal!; hook.unmount(); expect(signal.aborted).toBe(true);
      await act(async () => { if (fails) pending.reject(new Error("迟到失败")); else pending.resolve(response); await command; });
      expect(props.onCreated).not.toHaveBeenCalled(); expect(props.onUnknown).not.toHaveBeenCalled();
      expect(jsonFetch).toHaveBeenCalledTimes(callCount);
    }
  });
});
