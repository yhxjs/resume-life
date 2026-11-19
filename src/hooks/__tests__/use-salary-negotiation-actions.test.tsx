// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmDialog } from "@/components/common/confirm-dialog";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import type { SalaryNegotiationHistory } from "@/lib/salary-negotiation-history";
import { useSalaryNegotiationActions } from "../use-salary-negotiation-actions";

vi.mock("@/lib/fetcher", async (original) => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
vi.mock("@/components/common/confirm-dialog", () => ({ confirmDialog: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

const revision = "a".repeat(64);
const updatedRevision = "b".repeat(64);

function turn(no: number, message = "已保存的旧原话") {
  return { id: no, negotiation_id: 1, turn_no: no, user_message: message, hr_response: `第${no}轮回应，奖金待审批`, hr_tactics: "澄清",
    hr_mindset: { looseness: 20, current_attitude: "模拟态度", estimated_package: "模拟方案", tactics_label: "核实", internal_pressure: "预算未确认" },
    mentor_analysis: { user_argument_score: 7, strengths: ["诉求明确"], vulnerabilities: ["条件待确认"], tactical_tips: "核实薪数",
      suggested_replies: [{ title: "核实", content: "请确认保证收入", rationale: "保持条件边界" }] }, created_at: "2026-10-29" };
}
function history(): SalaryNegotiationHistory {
  return { id: 1, revision, target_company_tier: "custom", target_role: "工程师", expected_salary: "30k", current_or_competing_offer: "无",
    hr_style: "standard", status: "ongoing", initial_offer: "模拟开价", final_package: "", report: null, created_at: "original", finished_at: "", turns: [turn(1, "")] };
}
function finished(): SalaryNegotiationHistory {
  return { ...history(), revision: updatedRevision, status: "finished", final_package: "尚未达成", finished_at: "saved-finish", report: {
    final_package_summary: "尚未达成", score: null, persuasion_grade: null, leverage_efficiency: "", mentor_summary: "旧总结", real_world_tips: [], turn_critiques: [],
  } };
}
function turnResponse(no: number, message: string, baseRevision = revision, nextRevision = updatedRevision) {
  return { ...turn(no, message), base_revision: baseRevision, revision: nextRevision };
}
function options() {
  return { data: history() as SalaryNegotiationHistory | null, userInput: "  本次原话 <T> &amp;\n奖金待确认  ", finalWords: "  结束补充，未达成  ",
    onHistory: vi.fn(), onTurnSaved: vi.fn(), onFinished: vi.fn(), onRecovery: vi.fn(), onDeleted: vi.fn() };
}
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function requests(method: string) { return vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === method); }

describe("谈薪操作同步互斥及响应核对", () => {
  it("同事件重复发送、结束和删除只发一个回合请求，保留发送快照", async () => {
    const pending = deferred<unknown>(); const props = options();
    vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
    const hook = renderHook((value) => useSalaryNegotiationActions(value), { initialProps: props });
    let command!: Promise<void>;
    act(() => {
      command = hook.result.current.sendTurn(); void hook.result.current.sendTurn();
      void hook.result.current.finalize(); void hook.result.current.remove();
    });
    expect(jsonFetch).toHaveBeenCalledOnce(); expect(confirmDialog).not.toHaveBeenCalled();
    expect(requests("POST")[0]![1]).toMatchObject({ body: JSON.stringify({ user_message: props.userInput.trim(), expected_revision: revision }), signal: expect.any(AbortSignal) });
    hook.rerender({ ...props, userInput: "等待期间的新稿" });
    await act(async () => { pending.resolve(turnResponse(2, props.userInput.trim())); await command; });
    expect(hook.result.current.phase).toBe("idle"); expect(props.onTurnSaved).toHaveBeenCalledExactlyOnceWith(props.userInput);
    expect(props.onHistory.mock.calls[0]![0].turns.at(-1).user_message).toBe(props.userInput.trim());
  });

  const invalidTurns = [null, [], { ...turn(2), negotiation_id: 2 }, { ...turn(2), turn_no: 3 }, { ...turn(2), id: 1 },
    { ...turn(2), user_message: "串原答" }, { ...turn(2), hr_mindset: {} }, { ...turn(2), mentor_analysis: {} },
    { ...turn(2), hr_mindset: { ...turn(2).hr_mindset, extra: true } },
    { ...turn(2), created_at: null }, { ...turn(2), mentor_analysis: { ...turn(2).mentor_analysis, user_argument_score: 99 } }]
    .map(value => value && !Array.isArray(value) ? { ...value, base_revision: revision, revision: updatedRevision } : value);
  it.each(invalidTurns)("坏回合 %# 先完整回读，核对失败期间不开放任何写入口", async (invalid) => {
    const props = { ...options(), userInput: "已保存的旧原话" };
    vi.mocked(jsonFetch).mockResolvedValueOnce(invalid).mockRejectedValueOnce(new Error("存档读取失败"));
    const hook = renderHook(() => useSalaryNegotiationActions(props));
    await act(() => hook.result.current.sendTurn());
    expect(hook.result.current.phase).toBe("unknown"); expect(props.onHistory).not.toHaveBeenCalled(); expect(props.onTurnSaved).not.toHaveBeenCalled();
    expect(vi.mocked(jsonFetch).mock.calls[1]).toEqual(["/api/tools/salary-negotiations/1", expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) })]);
    await act(async () => { await hook.result.current.sendTurn(); await hook.result.current.finalize(); await hook.result.current.remove(); });
    expect(jsonFetch).toHaveBeenCalledTimes(2); expect(confirmDialog).not.toHaveBeenCalled();
  });

  it.each([null, { ...finished(), id: 2 }, { ...finished(), id: undefined }, { ...finished(), status: "ongoing" },
    { ...finished(), finished_at: undefined }, { ...finished(), final_package: null }, { ...finished(), report: [] },
    { ...finished(), report: { turn_critiques: [{ turn_no: 99, gain_or_loss: "neutral" }] } }]
    .map(value => value ? { ...value, base_revision: revision } : value))("坏复盘 %# 不封板、不展示，先只读核对", async (invalid) => {
    const props = options(); vi.mocked(jsonFetch).mockResolvedValueOnce(invalid).mockRejectedValueOnce(new Error("核对失败"));
    const hook = renderHook(() => useSalaryNegotiationActions(props));
    await act(() => hook.result.current.finalize());
    expect(hook.result.current.phase).toBe("unknown"); expect(props.onHistory).not.toHaveBeenCalled(); expect(props.onFinished).not.toHaveBeenCalled();
    expect(requests("POST")).toHaveLength(1); expect(props.onRecovery).toHaveBeenCalledOnce();
  });

  it("合法旧复盘保留缺失评分，不重算或补默认值", async () => {
    const props = options(); const saved = finished(); vi.mocked(jsonFetch).mockResolvedValueOnce({ ...saved, base_revision: revision });
    const hook = renderHook(() => useSalaryNegotiationActions(props));
    await act(() => hook.result.current.finalize());
    expect(props.onHistory).toHaveBeenCalledExactlyOnceWith(saved); expect(props.onFinished).toHaveBeenCalledOnce();
    expect(hook.result.current.phase).toBe("idle");
    await act(() => hook.result.current.sendTurn()); expect(jsonFetch).toHaveBeenCalledOnce();
  });

  it.each([400, 401, 403, 413, 422])("明确 %s 拒绝保留原稿，不自动读取或重发", async (status) => {
    const props = options(); vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("明确拒绝", status));
    const hook = renderHook(() => useSalaryNegotiationActions(props)); await act(() => hook.result.current.sendTurn());
    expect(hook.result.current.phase).toBe("idle"); expect(hook.result.current.error).toBe("明确拒绝");
    expect(jsonFetch).toHaveBeenCalledOnce(); expect(props.onTurnSaved).not.toHaveBeenCalled();
  });
});

describe("谈薪异常后的存档恢复", () => {
  it.each(["turn", "finalize"] as const)("%s 的旧版本被拒绝后读取新报价并保留草稿，明确重试才发送新版本", async kind => {
    const props = options();
    const changed = { ...history(), revision: updatedRevision, turns: [{ ...turn(1, ""), hr_response: "最新报价：保证 12 薪，奖金仍待审批。" }] };
    vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("谈薪记录已更新，请重新读取", 409)).mockResolvedValueOnce(changed);
    const hook = renderHook(value => useSalaryNegotiationActions(value), { initialProps: props });
    const run = () => kind === "turn" ? hook.result.current.sendTurn() : hook.result.current.finalize();
    await act(run);
    const draftField = kind === "turn" ? { user_message: props.userInput.trim() } : { final_words: props.finalWords.trim() };
    expect(JSON.parse(requests("POST")[0]![1]!.body as string)).toEqual({ ...draftField, expected_revision: revision });
    expect(props.onHistory).toHaveBeenCalledExactlyOnceWith(changed);
    expect(props.onTurnSaved).not.toHaveBeenCalled(); expect(props.onFinished).not.toHaveBeenCalled();
    expect(hook.result.current.error).toContain("原话与结束补充已保留");
    expect(hook.result.current.phase).toBe("idle"); expect(jsonFetch).toHaveBeenCalledTimes(2);
    hook.rerender({ ...props, data: changed });
    expect(requests("POST")).toHaveLength(1);
    const nextRevision = "c".repeat(64);
    vi.mocked(jsonFetch).mockResolvedValueOnce(kind === "turn"
      ? turnResponse(2, props.userInput.trim(), updatedRevision, nextRevision)
      : { ...finished(), base_revision: updatedRevision, revision: nextRevision });
    await act(run);
    expect(JSON.parse(requests("POST")[1]![1]!.body as string)).toEqual({ ...draftField, expected_revision: updatedRevision });
    expect(props.onHistory.mock.calls.at(-1)![0]).toMatchObject({ revision: nextRevision });
    if (kind === "turn") expect(props.onTurnSaved).toHaveBeenCalledExactlyOnceWith(props.userInput);
    else expect(props.onFinished).toHaveBeenCalledOnce();
  });

  it.each(["turn", "finalize"] as const)("%s 完成回包的基础版本缺失或变化时不合并旧历史，只读恢复且不清稿", async kind => {
    for (const baseRevision of [undefined, updatedRevision]) {
      vi.mocked(jsonFetch).mockReset();
      const props = options();
      const changed = { ...history(), revision: updatedRevision, created_at: "metadata-updated", turns: [{ ...turn(1, ""), hr_response: "存档中的真实报价" }] };
      const raw = kind === "turn" ? turnResponse(2, props.userInput.trim()) : finished();
      vi.mocked(jsonFetch).mockResolvedValueOnce({ ...raw, base_revision: baseRevision, revision: "c".repeat(64) }).mockResolvedValueOnce(changed);
      const hook = renderHook(() => useSalaryNegotiationActions(props));
      await act(() => kind === "turn" ? hook.result.current.sendTurn() : hook.result.current.finalize());
      expect(props.onHistory).toHaveBeenCalledExactlyOnceWith(changed);
      expect(props.onTurnSaved).not.toHaveBeenCalled(); expect(props.onFinished).not.toHaveBeenCalled();
      expect(props.onRecovery).toHaveBeenCalledOnce(); expect(requests("POST")).toHaveLength(1);
      expect(hook.result.current.phase).toBe("idle"); expect(hook.result.current.error).toContain("原话与结束补充已保留");
      hook.unmount();
    }
  });

  it.each(["turn", "finalize", "delete"] as const)("%s 的 408 不是明确拒绝，未变化的存档不能解除在途锁", async kind => {
    const props = options(); vi.mocked(confirmDialog).mockResolvedValue(true);
    vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("请求等待超时", 408)).mockResolvedValueOnce(history());
    const hook = renderHook(() => useSalaryNegotiationActions(props));
    await act(async () => { await (kind === "turn" ? hook.result.current.sendTurn() : kind === "finalize" ? hook.result.current.finalize() : hook.result.current.remove()); });
    expect(jsonFetch).toHaveBeenCalledTimes(2);
    expect(hook.result.current.phase).toBe("unknown"); expect(hook.result.current.canStart()).toBe(false);
    expect(props.onRecovery).toHaveBeenCalledOnce(); expect(props.onTurnSaved).not.toHaveBeenCalled(); expect(props.onDeleted).not.toHaveBeenCalled();
    await act(async () => { await hook.result.current.sendTurn(); await hook.result.current.finalize(); await hook.result.current.remove(); });
    expect(jsonFetch).toHaveBeenCalledTimes(2);
    vi.mocked(jsonFetch).mockResolvedValueOnce(history());
    await act(async () => { hook.result.current.retryCheck(); });
    expect(hook.result.current.phase).toBe("unknown");
    if (kind === "delete") vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("已不存在", 404));
    else vi.mocked(jsonFetch).mockResolvedValueOnce(kind === "finalize" ? finished() : { ...history(), revision: updatedRevision, turns: [turn(1, ""), turn(2, props.userInput.trim())] });
    await act(async () => { hook.result.current.retryCheck(); });
    expect(props.onTurnSaved).not.toHaveBeenCalled();
    if (kind === "delete") expect(props.onDeleted).toHaveBeenCalledOnce();
    else expect(hook.result.current.canStart()).toBe(true);
    expect(requests(kind === "delete" ? "DELETE" : "POST")).toHaveLength(1);
  });

  it.each(["turn", "finalize", "confirm-delete", "delete", "navigating"] as const)("旧重读入口不能抢跑后续 %s 或解除新命令", async stage => {
    const props = options();
    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("旧断连")).mockResolvedValueOnce(history());
    const hook = renderHook(value => useSalaryNegotiationActions(value), { initialProps: props });
    await act(() => hook.result.current.sendTurn());
    const oldRetry = hook.result.current.retryCheck;
    const recovered = { ...history(), revision: updatedRevision, turns: [turn(1, ""), turn(2, props.userInput.trim())] };
    vi.mocked(jsonFetch).mockResolvedValueOnce(recovered);
    await act(async () => { oldRetry(); });
    expect(hook.result.current.phase).toBe("idle");
    hook.rerender({ ...props, data: recovered });
    const waiting = deferred<unknown>(); const confirmation = deferred<boolean>();
    vi.mocked(jsonFetch).mockReturnValueOnce(waiting.promise).mockResolvedValue(history());
    vi.mocked(confirmDialog).mockReturnValueOnce(stage === "confirm-delete" ? confirmation.promise : Promise.resolve(true));
    let done!: Promise<void>;
    act(() => { done = stage === "turn" ? hook.result.current.sendTurn() : stage === "finalize" ? hook.result.current.finalize() : hook.result.current.remove(); });
    await act(async () => { await Promise.resolve(); });
    if (stage === "navigating") await act(async () => { waiting.resolve({ ok: true }); await done; });
    const calls = vi.mocked(jsonFetch).mock.calls.length;
    act(() => { oldRetry(); oldRetry(); });
    await act(async () => { await Promise.resolve(); });
    expect(jsonFetch).toHaveBeenCalledTimes(calls);
    expect(hook.result.current.phase).toBe(stage === "navigating" ? "delete" : stage);
    expect(hook.result.current.canStart()).toBe(false);
    if (stage === "confirm-delete") await act(async () => { confirmation.resolve(false); await done; });
    else if (stage !== "navigating") await act(async () => { waiting.resolve(stage === "turn" ? turnResponse(3, props.userInput.trim(), recovered.revision, "c".repeat(64)) : stage === "finalize" ? { ...finished(), base_revision: recovered.revision, revision: "c".repeat(64), turns: recovered.turns } : { ok: true }); await done; });
    if (stage === "turn") expect(props.onTurnSaved).toHaveBeenCalledExactlyOnceWith(props.userInput);
    if (stage === "finalize") expect(props.onFinished).toHaveBeenCalledOnce();
    if (stage === "delete" || stage === "navigating") expect(props.onDeleted).toHaveBeenCalledOnce();
    expect(hook.result.current.phase).toBe(stage === "delete" || stage === "navigating" ? "delete" : "idle");
  });

  it("旧回合同文不能认领本次断连提交；新增匹配回合只恢复存档，不清稿或宣称按请求成功", async () => {
    const props = options(); props.data!.turns.push(turn(2, props.userInput.trim()));
    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("断连")).mockResolvedValueOnce(props.data);
    const hook = renderHook(() => useSalaryNegotiationActions(props)); await act(() => hook.result.current.sendTurn());
    expect(hook.result.current.phase).toBe("unknown"); expect(hook.result.current.error).toContain("尚未确认");
    expect(props.onTurnSaved).not.toHaveBeenCalled();
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ...props.data!, revision: updatedRevision, turns: [...props.data!.turns, turn(3, props.userInput.trim())] });
    await act(async () => { hook.result.current.retryCheck(); });
    expect(hook.result.current.phase).toBe("idle"); expect(hook.result.current.notice).toContain("无法确认是否来自本次请求");
    expect(props.onTurnSaved).not.toHaveBeenCalled(); expect(requests("POST")).toHaveLength(1);
  });

  it.each([409, 500, 502, 503])("HTTP %s 之后先核对存档，读取成功才允许用户显式重试", async (status) => {
    const props = options(); const read = deferred<unknown>();
    vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("上次操作异常", status)).mockReturnValueOnce(read.promise);
    const hook = renderHook(() => useSalaryNegotiationActions(props)); let command!: Promise<void>;
    act(() => { command = hook.result.current.sendTurn(); });
    await act(async () => { await Promise.resolve(); }); expect(hook.result.current.phase).toBe("checking");
    await act(() => hook.result.current.sendTurn()); expect(requests("POST")).toHaveLength(1);
    await act(async () => { read.resolve(props.data); await command; });
    expect(hook.result.current.phase).toBe("idle"); expect(hook.result.current.error).toContain("已重新读取当前存档");
    expect(props.onTurnSaved).not.toHaveBeenCalled();
    vi.mocked(jsonFetch).mockResolvedValueOnce(turnResponse(2, props.userInput.trim()));
    await act(() => hook.result.current.sendTurn()); expect(requests("POST")).toHaveLength(2);
    expect(props.onTurnSaved).toHaveBeenCalledOnce();
  });

  it.each([null, { ...history(), id: 2 }, { ...history(), turns: [{ ...turn(1), negotiation_id: 2 }] },
    { ...history(), turns: [turn(1), turn(1)] }])("坏存档 %# 保留待确认锁；重复重读互斥且不再 POST", async (invalid) => {
    const props = options(); vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("断连")).mockResolvedValueOnce(invalid);
    const hook = renderHook(() => useSalaryNegotiationActions(props)); await act(() => hook.result.current.finalize());
    expect(hook.result.current.phase).toBe("unknown"); expect(props.onHistory).not.toHaveBeenCalled();
    const read = deferred<unknown>(); vi.mocked(jsonFetch).mockReturnValueOnce(read.promise);
    act(() => { hook.result.current.retryCheck(); hook.result.current.retryCheck(); });
    expect(jsonFetch).toHaveBeenCalledTimes(3);
    await act(async () => { read.resolve(finished()); await read.promise; });
    expect(hook.result.current.phase).toBe("idle"); expect(props.onFinished).toHaveBeenCalledOnce();
    expect(requests("POST")).toHaveLength(1); expect(props.onTurnSaved).not.toHaveBeenCalled();
    expect(hook.result.current.notice).toContain("本次补充是否被采用无法按请求确认");
  });
});

describe("谈薪删除与离页隔离", () => {
  it("确认弹窗等待期间互斥；取消零写入并释放锁", async () => {
    const props = options(); const confirmation = deferred<boolean>(); vi.mocked(confirmDialog).mockReturnValueOnce(confirmation.promise);
    const hook = renderHook(() => useSalaryNegotiationActions(props)); let command!: Promise<void>;
    act(() => { command = hook.result.current.remove(); void hook.result.current.remove(); void hook.result.current.sendTurn(); void hook.result.current.finalize(); });
    expect(confirmDialog).toHaveBeenCalledOnce(); expect(jsonFetch).not.toHaveBeenCalled();
    await act(async () => { confirmation.resolve(false); await command; }); expect(hook.result.current.phase).toBe("idle");
    expect(props.onDeleted).not.toHaveBeenCalled();
  });

  it("成功确认删除后保留互斥到导航，不接受旧页面的再次操作", async () => {
    const props = options(); vi.mocked(confirmDialog).mockResolvedValueOnce(true); vi.mocked(jsonFetch).mockResolvedValueOnce({ ok: true });
    const hook = renderHook(() => useSalaryNegotiationActions(props)); await act(() => hook.result.current.remove());
    expect(props.onDeleted).toHaveBeenCalledOnce(); expect(hook.result.current.busy).toBe(true);
    await act(async () => { await hook.result.current.remove(); await hook.result.current.sendTurn(); }); expect(jsonFetch).toHaveBeenCalledOnce();
  });

  it.each([null, {}, { ok: false }])("损坏删除响应 %j 不能导航；GET 404 才确认已不存在", async (raw) => {
    const props = options(); vi.mocked(confirmDialog).mockResolvedValueOnce(true);
    vi.mocked(jsonFetch).mockResolvedValueOnce(raw).mockRejectedValueOnce(new HttpError("不存在", 404));
    const hook = renderHook(() => useSalaryNegotiationActions(props)); await act(() => hook.result.current.remove());
    expect(props.onDeleted).toHaveBeenCalledOnce(); expect(requests("DELETE")).toHaveLength(1); expect(jsonFetch).toHaveBeenCalledTimes(2);
  });

  it("断连后记录仍存在不重删，只读重试到 404 再导航", async () => {
    const props = options(); vi.mocked(confirmDialog).mockResolvedValueOnce(true);
    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("断连")).mockResolvedValueOnce(history());
    const hook = renderHook(() => useSalaryNegotiationActions(props)); await act(() => hook.result.current.remove());
    expect(props.onDeleted).not.toHaveBeenCalled(); expect(hook.result.current.phase).toBe("unknown");
    vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("不存在", 404)); await act(async () => { hook.result.current.retryCheck(); });
    expect(props.onDeleted).toHaveBeenCalledOnce(); expect(requests("DELETE")).toHaveLength(1);
  });

  it("离页后旧确认不能发 DELETE", async () => {
    const props = options(); const pending = deferred<boolean>(); vi.mocked(confirmDialog).mockReturnValueOnce(pending.promise);
    const hook = renderHook(() => useSalaryNegotiationActions(props)); let command!: Promise<void>;
    act(() => { command = hook.result.current.remove(); }); hook.unmount();
    await act(async () => { pending.resolve(true); await command; }); expect(jsonFetch).not.toHaveBeenCalled(); expect(props.onDeleted).not.toHaveBeenCalled();
  });

  it.each(["turn", "finalize", "delete"] as const)("%s 请求离页中止；忽略中止的迟到成功和失败均无副作用", async (kind) => {
    for (const fails of [false, true]) {
      vi.mocked(jsonFetch).mockReset(); const props = options(); const pending = deferred<unknown>();
      vi.mocked(confirmDialog).mockResolvedValueOnce(true); vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
      const hook = renderHook(() => useSalaryNegotiationActions(props)); let command!: Promise<void>;
      act(() => { command = kind === "turn" ? hook.result.current.sendTurn() : kind === "finalize" ? hook.result.current.finalize() : hook.result.current.remove(); });
      await act(async () => { await Promise.resolve(); });
      const signal = vi.mocked(jsonFetch).mock.calls[0]![1]!.signal!; hook.unmount(); expect(signal.aborted).toBe(true);
      await act(async () => { if (fails) pending.reject(new Error("迟到失败")); else pending.resolve(kind === "turn" ? turn(2, props.userInput.trim()) : kind === "finalize" ? finished() : { ok: true }); await command; });
      expect(props.onHistory).not.toHaveBeenCalled(); expect(props.onTurnSaved).not.toHaveBeenCalled(); expect(props.onFinished).not.toHaveBeenCalled(); expect(props.onDeleted).not.toHaveBeenCalled();
      expect(jsonFetch).toHaveBeenCalledOnce();
    }
  });
});
