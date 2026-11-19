// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirmDialog } from "@/components/common/confirm-dialog";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import { useToolHistoryDeletion } from "../use-tool-history-deletion";

vi.mock("@/lib/fetcher", async (original) => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
vi.mock("@/components/common/confirm-dialog", () => ({ confirmDialog: vi.fn() }));
beforeEach(() => { vi.mocked(confirmDialog).mockResolvedValue(true); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const existing = { id: 1, jd: "原文 <T> &amp;", result: null, created_at: "2026-10-28" };
const gapScript = { label: "旧标签", applicableScene: "历史场景", script: "旧原文 <T> &amp;\n".repeat(200), keyPoints: [] };
const gapResult = { title: "历史标题".repeat(40), punchline: "历史摘要", hrMindsetAnalysis: { coreConcerns: [], riskPoints: [], whatHrWantsToHear: "原稿" },
  reframeFormula: { factAcknowledgment: "事实", positiveAttribution: "原归因", growthAndValue: "未开展项目", motivationAlignment: "尚未确认" },
  scripts: { concise: { ...gapScript, script: "" }, detailed: gapScript, pivoting: { ...gapScript, script: "" } },
  drills: [], forbiddenList: [], closingTips: [] };

describe("工具历史删除核对", () => {
  it.each([
    ["原报告", gapResult],
    ["坏报告", null],
  ])("空窗%s仍可核对实际原稿，不倒灌新生成限制", async (_label, result) => {
    const saved = { id: 1, raw_story: "完整经历 <T> &amp;\n未知安排", target_role: "原岗位", scenario_type: "legacy", persona_style: "legacy", created_at: "original", result };
    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("响应丢失")).mockResolvedValueOnce(saved);
    const onDeleted = vi.fn(); const hook = renderHook(() => useToolHistoryDeletion("career-gap-remedies", onDeleted));
    await act(() => hook.result.current.remove(1, "完整经历"));
    expect(hook.result.current.error).toContain("目前仍存在"); expect(hook.result.current.busy).toBe(false);
    expect(onDeleted).not.toHaveBeenCalled();
    expect(jsonFetch).toHaveBeenNthCalledWith(2, "/api/tools/career-gap-remedies/1", expect.objectContaining({ cache: "no-store" }));
  });

  it.each([{}, { id: 2 }, { raw_story: null }, { target_role: null }, { persona_style: null }, { scenario_type: null }, { created_at: null }, { result: {} }])("空窗状态字段损坏或串记录 %# 保持锁，显式重读才能确认", async (changed) => {
    const saved = { id: 1, raw_story: "原稿", target_role: "原岗位", persona_style: "pragmatic", scenario_type: "gap", created_at: "original", result: null };
    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("响应丢失")).mockResolvedValueOnce(Object.keys(changed).length ? { ...saved, ...changed } : {})
      .mockRejectedValueOnce(new HttpError("不存在", 404));
    const onDeleted = vi.fn(); const hook = renderHook(() => useToolHistoryDeletion("career-gap-remedies", onDeleted));
    await act(() => hook.result.current.remove(1, "原稿"));
    expect(hook.result.current.busy).toBe(true); expect(hook.result.current.phase).toBe("unknown");
    expect(onDeleted).not.toHaveBeenCalled();
    await act(async () => { hook.result.current.retryCheck(); });
    await waitFor(() => expect(onDeleted).toHaveBeenCalledOnce());
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
  });
  it("确认即加同步锁；其他记录和重复触发不再排队，取消释放", async () => {
    const confirm = Promise.withResolvers<boolean>();
    vi.mocked(confirmDialog).mockReturnValueOnce(confirm.promise);
    const onDeleted = vi.fn();
    const { result } = renderHook(() => useToolHistoryDeletion("jd-portraits", onDeleted));
    let pending!: Promise<void>;
    act(() => { pending = result.current.remove(1, "原文标题"); void result.current.remove(2, "其他标题"); });
    expect(confirmDialog).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: "确定删除考点画像 #1「原文标题」？" }));
    expect(result.current.busy).toBe(true);
    await act(async () => { confirm.resolve(false); await pending; });
    expect(result.current.busy).toBe(false);
    expect(jsonFetch).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("确认成功后记住已删 ID，旧列表残留不能重复删除，使用最新刷新回调", async () => {
    const first = vi.fn();
    const next = vi.fn();
    const write = Promise.withResolvers<unknown>();
    vi.mocked(jsonFetch).mockReturnValueOnce(write.promise);
    const { result, rerender } = renderHook(({ reload }) => useToolHistoryDeletion("jd-portraits", reload), { initialProps: { reload: first } });
    let pending!: Promise<void>;
    act(() => { pending = result.current.remove(1, "标题"); });
    await waitFor(() => expect(jsonFetch).toHaveBeenCalledOnce());
    rerender({ reload: next });
    await act(async () => { write.resolve({ ok: true }); await pending; });
    expect(first).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledOnce();
    expect(result.current.deletedIds.has(1)).toBe(true);
    expect(result.current.notice).toContain("#1 不存在");
    await act(async () => { await result.current.remove(1, "旧列表残留"); });
    expect(jsonFetch).toHaveBeenCalledOnce();
  });

  it.each([new Error("网络失败"), new HttpError("请求超时", 408), new HttpError("暂不可用", 503), null, {}, { ok: "true" }])("异常删除必须核对同 ID，404 确认删除 %#", async (response) => {
    if (response instanceof Error) vi.mocked(jsonFetch).mockRejectedValueOnce(response);
    else vi.mocked(jsonFetch).mockResolvedValueOnce(response);
    vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("不存在", 404));
    const onDeleted = vi.fn();
    const { result } = renderHook(() => useToolHistoryDeletion("jd-portraits", onDeleted));
    await act(async () => { await result.current.remove(1, "标题"); });
    expect(jsonFetch).toHaveBeenNthCalledWith(2, "/api/tools/jd-portraits/1", expect.objectContaining({ cache: "no-store" }));
    expect(onDeleted).toHaveBeenCalledOnce();
    expect(result.current.deletedIds.has(1)).toBe(true);
  });

  it("DELETE 404 直接确认，不重复核对", async () => {
    vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("不存在", 404));
    const onDeleted = vi.fn();
    const { result } = renderHook(() => useToolHistoryDeletion("jd-portraits", onDeleted));
    await act(async () => { await result.current.remove(1, "标题"); });
    expect(jsonFetch).toHaveBeenCalledOnce();
    expect(onDeleted).toHaveBeenCalledOnce();
  });

  it("明确拒绝保留记录并释放，不用 GET 猜测", async () => {
    vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("禁止删除", 403));
    const onDeleted = vi.fn();
    const { result } = renderHook(() => useToolHistoryDeletion("jd-portraits", onDeleted));
    await act(async () => { await result.current.remove(1, "标题"); });
    expect(jsonFetch).toHaveBeenCalledOnce();
    expect(result.current.error).toContain("禁止删除");
    expect(result.current.busy).toBe(false);
    expect(result.current.deletedIds.size).toBe(0);
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("记录仍存在时允许显式重试，不刷新列表掩盖失败原因", async () => {
    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("写入响应损坏")).mockResolvedValueOnce(existing).mockResolvedValueOnce({ ok: true });
    const onDeleted = vi.fn();
    const { result } = renderHook(() => useToolHistoryDeletion("jd-portraits", onDeleted));
    await act(async () => { await result.current.remove(1, "标题"); });
    expect(result.current.error).toContain("写入响应损坏；记录 #1 目前仍存在");
    expect(result.current.busy).toBe(false);
    expect(onDeleted).not.toHaveBeenCalled();
    await act(async () => { await result.current.remove(1, "标题"); });
    expect(onDeleted).toHaveBeenCalledOnce();
  });

  it.each([new Error("读取失败"), { ...existing, id: 2 }, { ...existing, result: {} }, { id: 1 }])("状态读取异常保留锁，只允许重新 GET %#", async (response) => {
    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("响应丢失"));
    if (response instanceof Error) vi.mocked(jsonFetch).mockRejectedValueOnce(response);
    else vi.mocked(jsonFetch).mockResolvedValueOnce(response);
    const check = Promise.withResolvers<unknown>();
    vi.mocked(jsonFetch).mockReturnValueOnce(check.promise);
    const onDeleted = vi.fn();
    const { result } = renderHook(() => useToolHistoryDeletion("jd-portraits", onDeleted));
    await act(async () => { await result.current.remove(1, "原标题"); });
    expect(result.current.phase).toBe("unknown");
    expect(result.current.target).toEqual({ id: 1, title: "原标题" });
    await act(async () => { await result.current.remove(2, "其他记录"); });
    expect(jsonFetch).toHaveBeenCalledTimes(2);
    act(() => { result.current.retryCheck(); result.current.retryCheck(); });
    expect(jsonFetch).toHaveBeenCalledTimes(3);
    await act(async () => { check.reject(new HttpError("不存在", 404)); });
    expect(onDeleted).toHaveBeenCalledOnce();
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
  });

  it.each(["confirm", "delete", "check"])("卸载后 %s 的迟到结果不刷新，且取消请求", async (phase) => {
    const pending = Promise.withResolvers<unknown>();
    const onDeleted = vi.fn();
    if (phase === "confirm") vi.mocked(confirmDialog).mockReturnValueOnce(pending.promise as Promise<boolean>);
    if (phase === "delete") vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
    if (phase === "check") vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("写失败")).mockReturnValueOnce(pending.promise);
    const { result, unmount } = renderHook(() => useToolHistoryDeletion("jd-portraits", onDeleted));
    let operation!: Promise<void>;
    act(() => { operation = result.current.remove(1, "旧标题"); });
    if (phase !== "confirm") await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(phase === "check" ? 2 : 1));
    const signal = phase === "confirm" ? vi.mocked(confirmDialog).mock.lastCall?.[0].signal : vi.mocked(jsonFetch).mock.lastCall?.[1]?.signal;
    unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => { pending.resolve(phase === "confirm" ? true : { ok: true }); await operation; });
    expect(onDeleted).not.toHaveBeenCalled();
    expect(jsonFetch).toHaveBeenCalledTimes(phase === "confirm" ? 0 : phase === "check" ? 2 : 1);
  });

  it("解码报告核对使用对应协议，历史异常报告仍可明确存在", async () => {
    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("写失败")).mockResolvedValueOnce({ id: 1, source_text: "原文", created_at: "2026-10-28", result: null });
    const { result } = renderHook(() => useToolHistoryDeletion("jargon-decodings", vi.fn()));
    await act(async () => { await result.current.remove(1, "解码报告"); });
    expect(jsonFetch).toHaveBeenNthCalledWith(2, "/api/tools/jargon-decodings/1", expect.objectContaining({ cache: "no-store" }));
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toContain("目前仍存在");
  });

  it("排雷删除确认标出报告身份与演练清理，核对历史只确认存在，不按新生成规则筛掉旧报告", async () => {
    const source = "原始履历 <T> &amp;\n".repeat(300);
    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("写入响应损坏")).mockResolvedValueOnce({
      report: { id: 1, title: "历史标题", sourceContent: source, targetRole: "岗位", createdAt: "2026-10-29", items: null },
      drills: [],
    });
    const onDeleted = vi.fn();
    const { result } = renderHook(() => useToolHistoryDeletion("resume-defenses", onDeleted));
    await act(async () => { await result.current.remove(1, "历史标题"); });
    expect(confirmDialog).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      message: "确定删除简历排雷报告 #1「历史标题」？删除后相关防御演练记录将一并清除。",
    }));
    expect(jsonFetch).toHaveBeenNthCalledWith(1, "/api/tools/resume-defenses/1", expect.objectContaining({ method: "DELETE" }));
    expect(jsonFetch).toHaveBeenNthCalledWith(2, "/api/tools/resume-defenses/1", expect.objectContaining({ cache: "no-store" }));
    expect(result.current.error).toContain("记录 #1 目前仍存在");
    expect(result.current.busy).toBe(false); expect(result.current.deletedIds.size).toBe(0);
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it.each([null, {}, { report: null }, { id: 1, sourceContent: "报告字段不能冒充外壳" },
    { report: { id: 2, title: "另一份", sourceContent: "原文", targetRole: "岗位", createdAt: "2026-10-29" } },
    { report: { id: "1", title: "标题", sourceContent: "原文", targetRole: "岗位", createdAt: "2026-10-29" } },
    { report: { id: 1, title: "标题", sourceContent: null, targetRole: "岗位", createdAt: "2026-10-29" } },
    { report: { id: 1, title: "标题", sourceContent: "原文", targetRole: "岗位", createdAt: null } },
  ])("排雷核对异常或串报告 %# 保持未知锁，只能重读，不重复 DELETE", async (response) => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce(response).mockRejectedValueOnce(new HttpError("报告已删除", 404));
    const onDeleted = vi.fn();
    const { result } = renderHook(() => useToolHistoryDeletion("resume-defenses", onDeleted));
    await act(async () => { await result.current.remove(1, "原标题"); });
    expect(result.current.phase).toBe("unknown");
    expect(result.current.target).toEqual({ id: 1, title: "原标题" });
    await act(async () => { await result.current.remove(2, "另一记录"); });
    expect(jsonFetch).toHaveBeenCalledTimes(2);
    act(() => result.current.retryCheck());
    await waitFor(() => expect(onDeleted).toHaveBeenCalledOnce());
    expect(result.current.deletedIds.has(1)).toBe(true);
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
  });

  const salary = { id: 1, revision: "a".repeat(64), target_company_tier: "自定义", target_role: "原始岗位", expected_salary: "30k", hr_style: "旧风格", status: "ongoing",
    initial_offer: "", final_package: "", report: null, created_at: "2026-10-29", finished_at: "", turns: [{
      id: 3, negotiation_id: 1, turn_no: 4, user_message: "  旧原话 <T> &amp;\n".repeat(500), hr_response: "旧回应", hr_tactics: "旧策略",
      hr_mindset: {}, mentor_analysis: {}, created_at: "2026-10-29",
    }] };
  it("谈薪删除确认展示身份、完整岗位和级联范围；核对旧长历史不应用新生成限制", async () => {
    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("删除响应异常")).mockResolvedValueOnce(salary);
    const { result } = renderHook(() => useToolHistoryDeletion("salary-negotiations", vi.fn()));
    await act(() => result.current.remove(1, "完整岗位 <T> &amp;"));
    expect(confirmDialog).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: "确定删除谈薪演练 #1「完整岗位 <T> &amp;」？删除后所有谈判回合及复盘将一并清除。" }));
    expect(result.current.phase).toBe("idle"); expect(result.current.error).toContain("目前仍存在");
    expect(vi.mocked(jsonFetch).mock.calls[1]).toEqual(["/api/tools/salary-negotiations/1", expect.objectContaining({ cache: "no-store" })]);
  });
  it.each([null, { ...salary, id: 2 }, { ...salary, turns: [{ ...salary.turns[0], negotiation_id: 2 }] }, { ...salary, turns: [salary.turns[0], salary.turns[0]] },
    { ...salary, report: { turn_critiques: [{ turn_no: 99, gain_or_loss: "neutral" }] } }])("谈薪核对坏存档 %# 保持只读锁，不误删另一记录", async (invalid) => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce(invalid).mockRejectedValueOnce(new HttpError("不存在", 404));
    const removed = vi.fn(); const { result } = renderHook(() => useToolHistoryDeletion("salary-negotiations", removed));
    await act(() => result.current.remove(1, "原始岗位")); expect(result.current.phase).toBe("unknown"); expect(result.current.canStart()).toBe(false);
    await act(() => result.current.remove(2, "其他岗位")); expect(jsonFetch).toHaveBeenCalledTimes(2);
    act(() => result.current.retryCheck()); await waitFor(() => expect(removed).toHaveBeenCalledOnce());
    expect(result.current.deletedIds.has(1)).toBe(true); expect(result.current.deletedIds.has(2)).toBe(false);
  });
});
