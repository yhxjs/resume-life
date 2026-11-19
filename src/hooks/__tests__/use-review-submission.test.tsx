// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useReviewSubmission } from "../use-review-submission";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import type { ReviewSubmissionInput } from "@/lib/review-records";

vi.mock("@/lib/fetcher", async original => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.resetAllMocks(); });
const input: ReviewSubmissionInput = { cardId: 301, answer: "  原答 <T> &amp;\n内部  空格  ", grade: "good", expectedReviewCount: 1, timeZone: "Asia/Tokyo" };
const card = { id: 301, source: "notebook", source_id: 91, source_label: "来源", question: "原题", mastery: "learning", interval_days: 1, ease_factor: 250, repetitions: 1, review_count: 2, lapses: 0, next_review_date: "2026-11-03", last_reviewed_at: "旧日期" };
const result = { card, attempt: { id: 6, answer: input.answer.trim(), grade: "good", reviewed_at: "旧日期", interval_days: 1, next_review_date: "2026-11-03" } };
const posts = () => vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "POST");
const body = () => JSON.parse(String(posts().at(-1)![1]!.body));
const receipt = () => ({ ...result, request_id: body().request_id });

describe("复习提交编号核对与显式幂等重放", () => {
  it("同事件单写，正常确认也按原编号读取，通知实际最新排期", async () => {
    const pending = Promise.withResolvers<unknown>();
    vi.mocked(jsonFetch).mockImplementation(async (_url, init) => init?.method === "POST" ? pending.promise : { ...receipt(), card: { ...card, review_count: 4, interval_days: 21 } });
    const changed = vi.fn(); const hook = renderHook(() => useReviewSubmission(changed));
    await act(async () => { void hook.result.current.save(input); void hook.result.current.save({ ...input, grade: "easy" }); hook.result.current.reread(); });
    expect(jsonFetch).toHaveBeenCalledOnce(); expect(changed).not.toHaveBeenCalled();
    await act(async () => { pending.resolve(result); });
    expect(changed).toHaveBeenCalledExactlyOnceWith({ ...result, card: { ...card, review_count: 4, interval_days: 21 } });
    expect(body()).toMatchObject({ answer: input.answer, grade: input.grade, expected_review_count: 1, time_zone: input.timeZone });
    expect(jsonFetch).toHaveBeenLastCalledWith(`/api/reviews/301/requests/${body().request_id}`, expect.objectContaining({ cache: "no-store" }));
  });

  it.each([null, {}, { ...result, card: { ...card, id: 302 } }, { ...result, attempt: { ...result.attempt, answer: "串原答" } }])("坏成功确认 %j 只读核对", async ack => {
    vi.mocked(jsonFetch).mockImplementation(async (_url, init) => init?.method === "POST" ? ack : receipt());
    const changed = vi.fn(); const hook = renderHook(() => useReviewSubmission(changed));
    await act(() => hook.result.current.save(input)); expect(changed).toHaveBeenCalledExactlyOnceWith(result); expect(posts()).toHaveLength(1);
  });

  it.each([new Error("断线"), new HttpError("超时", 408), new HttpError("异常", 500), new HttpError("冲突", 409)])("异常 %j 按原编号恢复，不自动重写", async reason => {
    vi.mocked(jsonFetch).mockImplementation(async (_url, init) => { if (init?.method === "POST") throw reason; return receipt(); });
    const changed = vi.fn(); const hook = renderHook(() => useReviewSubmission(changed)); await act(() => hook.result.current.save(input));
    expect(changed).toHaveBeenCalledExactlyOnceWith(result); expect(posts()).toHaveLength(1);
  });

  it.each([400, 401, 403, 404, 422])("明确拒绝 %s 保留草稿并允许编辑，不核对也不重投", async status => {
    vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("明确拒绝", status)); const hook = renderHook(() => useReviewSubmission(vi.fn()));
    await act(() => hook.result.current.save(input)); expect(hook.result.current.phase).toBe("idle"); expect(hook.result.current.error).toBe("明确拒绝"); expect(jsonFetch).toHaveBeenCalledOnce();
  });

  it("坏读取保持未知锁，原编号重读同步互斥，旧入口不能发新提交", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({}).mockResolvedValueOnce({ ...result, request_id: "其他编号" });
    const changed = vi.fn(); const hook = renderHook(() => useReviewSubmission(changed)); await act(() => hook.result.current.save(input));
    expect(hook.result.current.phase).toBe("unknown"); const pending = Promise.withResolvers<unknown>(); vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
    await act(async () => { hook.result.current.reread(); hook.result.current.reread(); hook.result.current.retry(); void hook.result.current.save(input); });
    expect(jsonFetch).toHaveBeenCalledTimes(3); expect(changed).not.toHaveBeenCalled();
    await act(async () => { pending.resolve(receipt()); }); expect(changed).toHaveBeenCalledExactlyOnceWith(result);
  });

  it("404 不自动重投，显式重试冻结同一编号、原答、自评和版本", async () => {
    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("断线")).mockRejectedValueOnce(new HttpError("未找到", 404));
    const changed = vi.fn(); const hook = renderHook(() => useReviewSubmission(changed)); await act(() => hook.result.current.save(input));
    const original = body(); expect(hook.result.current.phase).toBe("missing");
    const pending = Promise.withResolvers<unknown>(); vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise).mockImplementation(async () => receipt());
    await act(async () => { hook.result.current.retry(); hook.result.current.retry(); hook.result.current.reread(); void hook.result.current.save({ ...input, answer: "换稿" }); });
    expect(posts()).toHaveLength(2); expect(body()).toEqual(original);
    await act(async () => { pending.resolve(result); }); expect(changed).toHaveBeenCalledExactlyOnceWith(result);
  });

  it("旧重试不能越过正在进行的新只读核对", async () => {
    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("断线")).mockRejectedValueOnce(new HttpError("未找到", 404));
    const hook = renderHook(() => useReviewSubmission(vi.fn())); await act(() => hook.result.current.save(input));
    const retry = hook.result.current.retry; const pending = Promise.withResolvers<unknown>(); vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
    await act(async () => { hook.result.current.reread(); retry(); }); expect(posts()).toHaveLength(1);
    await act(async () => { pending.resolve(receipt()); });
  });

  it("409 后核对失败不丢冲突，重读404后须重载，旧保存入口不能绕过", async () => {
    vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("旧进度", 409)).mockRejectedValueOnce(new Error("读取失败")).mockRejectedValueOnce(new HttpError("未找到", 404));
    const hook = renderHook(() => useReviewSubmission(vi.fn())); const oldSave = hook.result.current.save;
    await act(() => oldSave(input)); expect(hook.result.current.phase).toBe("unknown");
    await act(async () => { hook.result.current.reread(); }); expect(hook.result.current.conflict).toBe(true); expect(hook.result.current.phase).toBe("idle");
    await act(() => oldSave(input)); expect(posts()).toHaveLength(1);
    await act(async () => { hook.result.current.clearConflict(); });
    expect(hook.result.current.error).toBe("");
    vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("业务拒绝", 400)); await act(() => hook.result.current.save({ ...input, expectedReviewCount: 2 })); expect(posts()).toHaveLength(2);
  });

  it("正常ACK的错误历史ID不能认领，显式编号重读才能恢复", async () => {
    vi.mocked(jsonFetch).mockImplementation(async (_url, init) => init?.method === "POST" ? { ...result, attempt: { ...result.attempt, id: 999 } } : receipt());
    const changed = vi.fn(); const hook = renderHook(() => useReviewSubmission(changed)); await act(() => hook.result.current.save(input));
    expect(hook.result.current.phase).toBe("unknown"); expect(changed).not.toHaveBeenCalled(); await act(async () => { hook.result.current.reread(); }); expect(changed).toHaveBeenCalledExactlyOnceWith(result);
  });

  it.each([["posting", "resolve"], ["posting", "reject"], ["checking", "resolve"], ["checking", "reject"]])("离页取消 %s 等待，迟到 %s 不通知", async (phase, outcome) => {
    const pending = Promise.withResolvers<unknown>(); vi.mocked(jsonFetch).mockImplementation(async (_url, init) => (phase === "posting" || init?.method !== "POST") ? pending.promise : result);
    const changed = vi.fn(); const hook = renderHook(() => useReviewSubmission(changed)); await act(async () => { void hook.result.current.save(input); });
    const signal = vi.mocked(jsonFetch).mock.calls.at(-1)![1]!.signal!; hook.unmount(); expect(signal.aborted).toBe(true);
    await act(async () => { if (outcome === "reject") pending.reject(new Error("迟到失败")); else pending.resolve(phase === "posting" ? result : receipt()); }); expect(changed).not.toHaveBeenCalled();
  });

  it("请求编号生成失败零写入并释放入口", async () => {
    vi.spyOn(crypto, "randomUUID").mockImplementation(() => { throw new Error("编号生成失败"); });
    const hook = renderHook(() => useReviewSubmission(vi.fn())); await act(() => hook.result.current.save(input));
    expect(hook.result.current.error).toBe("编号生成失败"); expect(hook.result.current.canStart()).toBe(true); expect(jsonFetch).not.toHaveBeenCalled();
  });
});
