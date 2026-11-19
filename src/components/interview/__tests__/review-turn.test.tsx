// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InterviewReviewTurn, type ReviewTurnData, type TurnRetry } from "../review-turn";
import { jsonFetch } from "@/lib/fetcher";

vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
vi.mock("@/components/notebook", () => ({ NotebookStarButton: () => null }));
const clipboard = vi.fn();
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
beforeEach(() => {
  clipboard.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: clipboard } });
});
afterEach(() => {
  cleanup();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
  vi.resetAllMocks();
});

function retry(id: string): TurnRetry {
  return { id, answer: `重答 ${id}：仅负责接口校验，尚未上线。`, scores: { depth: 8, structure: 8, authenticity: 8, completeness: 8 }, comment: `点评 ${id}`,
    reference: `重答 ${id} 的参考：[待补充：真实方案]，未上线。`, created_at: "2026-10-28" };
}
function confirmed(next: TurnRetry, retries: TurnRetry[]) {
  const options = vi.mocked(jsonFetch).mock.calls.filter(([url]) => url.endsWith("/retry")).at(-1)![1];
  // 合成成功回复沿用生产路由的提交编号，后续历史也保留这个已保存编号。
  next.id = `retry_${new Headers(options?.headers).get("Idempotency-Key")}`;
  return { retry: next, retries };
}
function turn(retries: TurnRetry[] = []): ReviewTurnData {
  return { id: 10, idx: 1, kind: "question", question: "你个人负责哪些工作？", answer: "原答：只做接口联调，没有选型权。", comment: "原答点评，分工明确。",
    scores: { depth: 7, structure: 7, authenticity: 8, completeness: 7 }, reference: "原题参考：只描述实际分工，[待补充：真实方案]。", retries, answered_at: "2026-10-28", notebook_id: null };
}
function Harness({ initial }: { initial: ReviewTurnData }) {
  const [data, setData] = useState(initial);
  return <InterviewReviewTurn interviewId={1} turn={data} onTurnUpdated={(patch) => setData((current) => ({ ...current, ...patch }))} onNotebookChanged={vi.fn()} />;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe("面试复盘的版本参考与提交边界", () => {
  it("十二次重答保留全部版本入口，且只有当前版本标记为已选中", () => {
    const initial = turn(Array.from({ length: 12 }, (_, index) => retry(`v${index + 1}`)));
    render(<Harness initial={initial} />);
    const versions = within(screen.getByRole("group", { name: "作答版本" }));
    expect(versions.getAllByRole("button")).toHaveLength(13);
    expect(versions.getAllByRole("button", { pressed: true })).toHaveLength(1);
    expect(versions.getByRole("button", { pressed: true }).textContent).toContain("重答#12");
    for (const index of [0, 5, 11]) {
      const button = versions.getByRole("button", { name: new RegExp(`^重答#${index + 1}(?!\\d)`) });
      fireEvent.click(button);
      expect(versions.getAllByRole("button", { pressed: true })).toEqual([button]);
      expect(screen.getByText(initial.retries[index]!.answer)).toBeTruthy();
      expect(screen.getByText(initial.retries[index]!.comment, { exact: false })).toBeTruthy();
      expect(screen.getByRole("region", { name: "当前回答参考" }).textContent).toBe(initial.retries[index]!.reference);
    }
    const origin = versions.getByRole("button", { name: "原答" });
    fireEvent.click(origin);
    expect(versions.getAllByRole("button", { pressed: true })).toEqual([origin]);
    expect(screen.getByText(initial.answer)).toBeTruthy();
    expect(screen.getByRole("region", { name: "当前回答参考" }).textContent).toBe(initial.reference);
    expect(jsonFetch).not.toHaveBeenCalled();
  });

  it("切换原答与历史重答时显示并复制相应参考，不借用其他版本", async () => {
    const initial = turn([retry("a"), retry("b")]);
    const before = structuredClone(initial);
    render(<Harness initial={initial} />);
    expect(screen.getByText(initial.retries[1]!.reference!)).toBeTruthy();
    expect(screen.queryByText(initial.reference)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "复制参考答案" }));
    await waitFor(() => expect(clipboard).toHaveBeenLastCalledWith(initial.retries[1]!.reference));
    fireEvent.click(screen.getByRole("button", { name: /重答#1/ }));
    expect(screen.getByText(initial.retries[0]!.reference!)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "复制参考答案" }));
    await waitFor(() => expect(clipboard).toHaveBeenLastCalledWith(initial.retries[0]!.reference));
    fireEvent.click(screen.getByRole("button", { name: "查看题目参考" }));
    expect(screen.getByText(initial.reference)).toBeTruthy();
    expect(screen.getByText(initial.answer)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "复制参考答案" }));
    await waitFor(() => expect(clipboard).toHaveBeenLastCalledWith(initial.reference));
    expect(initial).toEqual(before);
    expect(jsonFetch).not.toHaveBeenCalled();
    expect(screen.queryByText(/满分标杆|高分示范/)).toBeNull();
  });

  it("旧重答缺参考时回退题目参考，并明确其依据，不冒充该次重答反馈", () => {
    const old = { ...retry("old"), reference: undefined };
    const initial = turn([old]);
    initial.reference = "旧版本保存的通用参考，来源记录不足。";
    render(<Harness initial={initial} />);
    expect(screen.getByText(initial.reference)).toBeTruthy();
    expect(screen.getByText(/该次重答未保存独立参考，当前回退到通用题目参考/)).toBeTruthy();
    expect(screen.queryByText("本次重答的回答参考")).toBeNull();
  });

  it("已有参考重新生成失败时保留旧内容并显示错误，重试成功只更新参考", async () => {
    const initial = turn();
    const reference = "新参考：仅用实际分工，假设方案须标注，未验证结果。";
    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("模型暂不可用")).mockResolvedValueOnce({ reference });
    render(<Harness initial={initial} />);
    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
    expect((await screen.findByRole("alert")).textContent).toContain("模型暂不可用");
    expect(screen.getByText(initial.reference)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
    await screen.findByText(reference);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText(initial.answer)).toBeTruthy();
    expect(screen.getByText(initial.comment, { exact: false })).toBeTruthy();
    expect(vi.mocked(jsonFetch).mock.calls[1]).toEqual(["/api/interviews/1/turns/10/reference", { method: "POST", signal: expect.any(AbortSignal) }]);
  });

  it("复制已有参考失败时有可见反馈，成功后清除错误", async () => {
    clipboard.mockRejectedValueOnce(new Error("denied"));
    render(<Harness initial={turn()} />);
    fireEvent.click(screen.getByRole("button", { name: "复制参考答案" }));
    expect((await screen.findByRole("alert")).textContent).toContain("复制失败");
    fireEvent.click(screen.getByRole("button", { name: "复制参考答案" }));
    await screen.findByRole("button", { name: "已复制 ✓" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("重答只提交用户输入；等待期间不能清空、导入或收起，新结果使用对应重答参考", async () => {
    const initial = turn([retry("a")]);
    const pending = deferred<{ retries: TurnRetry[]; reference: string }>();
    vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
    render(<Harness initial={initial} />);
    fireEvent.click(screen.getByRole("button", { name: /重答这一题/ }));
    const input = screen.getByRole("textbox", { name: /重新作答此题/ }) as HTMLTextAreaElement;
    expect(input.value).toBe(initial.retries[0]!.answer);
    const answer = "我仅负责接口参数校验，没有架构选型权，尚未上线。";
    fireEvent.change(input, { target: { value: ` ${answer}\n` } });
    fireEvent.click(screen.getByRole("button", { name: "提交并重新评分" }));
    expect(JSON.parse(vi.mocked(jsonFetch).mock.calls[0]![1]!.body as string)).toEqual({ answer });
    for (const name of ["清空重新写", "导入当前作答做修改", "收起重答面板"]) {
      const button = screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
    }
    expect(input.value).toBe(` ${answer}\n`);
    const newRetry = { ...retry("b"), answer };
    await act(async () => { pending.resolve({ ...confirmed(newRetry, [...initial.retries, newRetry]), reference: initial.reference }); await pending.promise; });
    await screen.findByText(newRetry.reference!);
    expect(screen.getByText(answer)).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByText(initial.reference)).toBeNull();
    expect(jsonFetch).toHaveBeenCalledOnce();
  });

  it.each(["参考先返回", "重答先返回"])("%s 时，重答响应中的旧参考不能覆盖已生成的新题目参考", async (order) => {
    const initial = turn();
    const reference = "新生成题目参考：仅基于原答，仍待核实。";
    const referenceRequest = deferred<{ reference: string }>();
    const retryRequest = deferred<{ retries: TurnRetry[]; reference: string }>();
    vi.mocked(jsonFetch).mockImplementation((url) => url.endsWith("/reference") ? referenceRequest.promise : retryRequest.promise);
    render(<Harness initial={initial} />);
    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
    fireEvent.click(screen.getByRole("button", { name: /重答这一题/ }));
    fireEvent.change(screen.getByRole("textbox", { name: /重新作答此题/ }), { target: { value: "本次重答，未上线。" } });
    fireEvent.click(screen.getByRole("button", { name: "提交并重新评分" }));
    const next = { ...retry("new"), answer: "本次重答，未上线。" };
    const finishReference = async () => act(async () => { referenceRequest.resolve({ reference }); await referenceRequest.promise; });
    const finishRetry = async () => act(async () => { retryRequest.resolve({ ...confirmed(next, [next]), reference: initial.reference }); await retryRequest.promise; });
    if (order === "参考先返回") { await finishReference(); await finishRetry(); }
    else { await finishRetry(); await finishReference(); }
    expect(screen.getByRole("region", { name: "当前回答参考" }).textContent).toBe(next.reference);
    fireEvent.click(screen.getByRole("button", { name: "查看题目参考" }));
    expect(screen.getByRole("region", { name: "当前回答参考" }).textContent).toBe(reference);
    expect(jsonFetch).toHaveBeenCalledTimes(2);
  });

  it("题目参考的失败只显示在通用参考旁，不能冒充当前重答参考的错误", async () => {
    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("原题参考暂时生成失败"));
    const initial = turn([retry("a")]);
    render(<Harness initial={initial} />);
    fireEvent.click(screen.getByRole("button", { name: "查看题目参考" }));
    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
    expect((await screen.findByRole("alert")).textContent).toBe("原题参考暂时生成失败");
    fireEvent.click(screen.getByRole("button", { name: /重答#1/ }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("region", { name: "当前回答参考" }).textContent).toBe(initial.retries[0]!.reference);
    fireEvent.click(screen.getByRole("button", { name: "查看题目参考" }));
    expect(screen.getByRole("alert").textContent).toBe("原题参考暂时生成失败");
  });

  it.each(["reference", "retry"])("%s 同一批连点只发一次请求，失败后可重试", async (action) => {
    const pending = deferred<unknown>();
    const next = { ...retry("a"), answer: "实际重答，尚未上线。" };
    vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise)
      .mockImplementationOnce(async () => action === "reference" ? { reference: "重试后的原题参考" } : confirmed(next, [next]));
    render(<Harness initial={turn()} />);
    if (action === "retry") {
      fireEvent.click(screen.getByRole("button", { name: /重答这一题/ }));
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "实际重答，尚未上线。" } });
    }
    const name = action === "reference" ? "重新生成" : "提交并重新评分";
    const button = screen.getByRole("button", { name });
    act(() => { fireEvent.click(button); fireEvent.click(button); });
    expect(jsonFetch).toHaveBeenCalledOnce();
    await act(async () => { pending.reject(new Error("本次调用失败，可重试")); });
    expect(screen.getByRole("alert").textContent).toBe("本次调用失败，可重试");
    if (action === "retry") expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("实际重答，尚未上线。");
    fireEvent.click(screen.getByRole("button", { name }));
    await screen.findByText(action === "reference" ? "重试后的原题参考" : next.reference!);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(jsonFetch).toHaveBeenCalledTimes(2);
  });

  it("响应丢失重试复用编号，恢复时选中所属版本，成功后的同文重答使用新编号", async () => {
    const own = retry("own");
    const other = retry("other");
    const next = { ...retry("next"), answer: own.answer };
    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("响应丢失"))
      .mockImplementationOnce(async () => confirmed(own, [own, other]))
      .mockImplementationOnce(async () => confirmed(next, [own, other, next]));
    render(<Harness initial={turn()} />);
    fireEvent.click(screen.getByRole("button", { name: /重答这一题/ }));
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: own.answer } });
    fireEvent.click(screen.getByRole("button", { name: "提交并重新评分" }));
    expect((await screen.findByRole("alert")).textContent).toBe("响应丢失");
    expect((input as HTMLTextAreaElement).value).toBe(own.answer);
    fireEvent.click(screen.getByRole("button", { name: "提交并重新评分" }));
    await screen.findByText(own.reference!);
    const selected = within(screen.getByRole("group", { name: "作答版本" })).getByRole("button", { pressed: true });
    expect(selected.textContent).toContain("重答#1");
    const ids = () => vi.mocked(jsonFetch).mock.calls.map(([, options]) => new Headers(options?.headers).get("Idempotency-Key"));
    expect(ids()[0]).toMatch(/^[0-9a-f-]{36}$/i);
    expect(ids()[1]).toBe(ids()[0]);
    fireEvent.click(screen.getByRole("button", { name: /重答这一题/ }));
    fireEvent.click(screen.getByRole("button", { name: "提交并重新评分" }));
    await screen.findByText(next.reference!);
    expect(ids()[2]).not.toBe(ids()[1]);
    expect(vi.mocked(jsonFetch).mock.calls.map(([, options]) => JSON.parse(options!.body as string))).toEqual([
      { answer: own.answer }, { answer: own.answer }, { answer: own.answer },
    ]);
  });

  it("失败后修改回答提交时换新编号，避免将新回答误认为旧提交", async () => {
    vi.mocked(jsonFetch).mockRejectedValue(new Error("暂时无法连接"));
    render(<Harness initial={turn()} />);
    fireEvent.click(screen.getByRole("button", { name: /重答这一题/ }));
    fireEvent.click(screen.getByRole("button", { name: "提交并重新评分" }));
    await screen.findByRole("alert");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "补充后的真实回答" } });
    fireEvent.click(screen.getByRole("button", { name: "提交并重新评分" }));
    await screen.findByRole("alert");
    const ids = vi.mocked(jsonFetch).mock.calls.map(([, options]) => new Headers(options?.headers).get("Idempotency-Key"));
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBeTruthy();
    expect(ids[1]).not.toBe(ids[0]);
  });

  it.each([{}, { retries: [] }, { retry: retry("missing"), retries: [retry("other")] }])("不完整的成功响应 %j 保留草稿及提交编号，不能冒充已完成", async (data) => {
    const own = retry("own");
    vi.mocked(jsonFetch).mockResolvedValueOnce(data).mockImplementationOnce(async () => confirmed(own, [own]));
    render(<Harness initial={turn()} />);
    fireEvent.click(screen.getByRole("button", { name: /重答这一题/ }));
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: own.answer } });
    fireEvent.click(screen.getByRole("button", { name: "提交并重新评分" }));
    expect((await screen.findByRole("alert")).textContent).toContain("请使用原提交重试");
    expect(input.value).toBe(own.answer);
    expect(screen.queryByRole("group", { name: "作答版本" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "提交并重新评分" }));
    await screen.findByText(own.reference!);
    const ids = vi.mocked(jsonFetch).mock.calls.map(([, options]) => new Headers(options?.headers).get("Idempotency-Key"));
    expect(ids[1]).toBe(ids[0]);
  });

  it.each([
    ["reference", "成功"], ["reference", "失败"], ["retry", "成功"], ["retry", "失败"],
  ])("%s 卸载后晚到的%s不再调用旧页面更新", async (action, result) => {
    const pending = deferred<unknown>();
    vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
    const onTurnUpdated = vi.fn();
    const { unmount } = render(<InterviewReviewTurn interviewId={1} turn={turn()} onTurnUpdated={onTurnUpdated} onNotebookChanged={vi.fn()} />);
    if (action === "reference") fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
    else {
      fireEvent.click(screen.getByRole("button", { name: /重答这一题/ }));
      fireEvent.click(screen.getByRole("button", { name: "提交并重新评分" }));
    }
    unmount();
    await act(async () => {
      if (result === "成功") pending.resolve(action === "reference" ? { reference: "旧页参考" } : { retries: [retry("old")] });
      else pending.reject(new Error("旧页失败"));
    });
    expect(onTurnUpdated).not.toHaveBeenCalled();
    expect(jsonFetch).toHaveBeenCalledOnce();
  });

  it("题目或面试切换后立即隔离旧状态，旧完成不清除新题等待", async () => {
    const old = deferred<{ reference: string }>();
    const current = deferred<{ reference: string }>();
    vi.mocked(jsonFetch).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const onOldUpdated = vi.fn();
    const onCurrentUpdated = vi.fn();
    const { rerender } = render(<InterviewReviewTurn interviewId={1} turn={turn([retry("old")])} onTurnUpdated={onOldUpdated} onNotebookChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "查看题目参考" }));
    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
    fireEvent.click(screen.getByRole("button", { name: /重答这一题/ }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "旧题草稿" } });
    const next = { ...turn(), id: 20, question: "新题：如何验证兼容性？", reference: "新题已有参考" };
    rerender(<InterviewReviewTurn interviewId={2} turn={next} onTurnUpdated={onCurrentUpdated} onNotebookChanged={vi.fn()} />);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /重答#1/ })).toBeNull();
    expect(screen.getByRole("region", { name: "当前回答参考" }).textContent).toBe(next.reference);
    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
    await act(async () => { old.resolve({ reference: "旧题晚到参考" }); await old.promise; });
    expect(onOldUpdated).not.toHaveBeenCalled();
    expect(onCurrentUpdated).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "生成中…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("旧题晚到参考")).toBeNull();
    await act(async () => { current.resolve({ reference: "新题最新参考" }); await current.promise; });
    expect(onCurrentUpdated).toHaveBeenCalledWith({ reference: "新题最新参考" });
    expect(vi.mocked(jsonFetch).mock.calls.map(([url]) => url)).toEqual([
      "/api/interviews/1/turns/10/reference", "/api/interviews/2/turns/20/reference",
    ]);
  });
});
