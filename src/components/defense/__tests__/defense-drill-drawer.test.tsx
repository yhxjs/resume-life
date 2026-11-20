// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DefenseDrillDrawer } from "../defense-drill-drawer";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import type { DefenseDrillRecord, ScannedDefenseItem } from "@/lib/resume-defense";

vi.mock("@/lib/fetcher", async (original) => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

const item: ScannedDefenseItem = { id: "item_1", originalText: "接口校验 <T> &amp;", sectionHint: "项目", riskLevel: "medium", riskType: "scope_ambiguity",
  interviewerRoast: "核对分工", deadlyQuestions: ["具体分工？", "如何验证？"],
  defensePlan: { interviewerIntent: "核对", standardDefense: "仅说明事实", tabooMistakes: ["编造经历"] } };
const saved = (patch: Partial<DefenseDrillRecord> = {}): DefenseDrillRecord => ({ id: 10, defenseId: 1, itemId: item.id,
  question: item.deadlyQuestions[0]!, userAnswer: "原答 <T> &amp;\n尚未上线", defenseScore: 87.5, interviewerRoast: "对应原答的点评",
  defenseCritique: "结果待核对", improvedAnswer: "仅说明已知事实", createdAt: "2026-10-29", updatedAt: "2026-10-29", ...patch });
const detail = (drills: DefenseDrillRecord[] = [], id = 1) => ({ report: { id, resumeId: null, title: `报告${id}`,
  sourceContent: item.originalText, targetRole: "接口工程师", riskLevel: "medium", overallRoast: "待核实", createdAt: "2026-10-29", items: [item] }, drills });
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function mount(existingDrill?: DefenseDrillRecord) {
  const onDrillSaved = vi.fn(); const onClose = vi.fn(); const onDrillsReloaded = vi.fn();
  const props = { defenseId: 1, item, isOpen: true, existingDrill, onDrillSaved, onClose, onDrillsReloaded };
  return { ...render(<DefenseDrillDrawer {...props} />), props, onDrillSaved, onClose, onDrillsReloaded };
}
const answer = () => screen.getByRole("textbox", { name: "你的练习回答：" }) as HTMLTextAreaElement;
const submit = () => screen.getByRole("button", { name: "提交练习回答" }) as HTMLButtonElement;
function send(text = saved().userAnswer) {
  fireEvent.change(answer(), { target: { value: text } }); fireEvent.submit(answer().closest("form")!);
}

describe("演练提交快照与互斥", () => {
  it("代码定位与替代方案保存到本次问题，提交后修改草稿不改变已提交快照", async () => {
    const pending = deferred<unknown>(); vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
    mount();
    fireEvent.click(screen.getByText("定位依据与条件变化"));
    fireEvent.change(screen.getByLabelText("来源位置"), { target: { value: "src/queue.ts L2–3" } });
    fireEvent.change(screen.getByLabelText(/依据原文/), { target: { value: "await save(order);" } });
    fireEvent.change(screen.getByLabelText("追问方式"), { target: { value: "alternative" } });
    fireEvent.change(screen.getByLabelText("替代方案"), { target: { value: "异步队列" } });
    fireEvent.click(screen.getByRole("button", { name: "应用到本次问题" }));
    send();
    const submitted = JSON.parse(vi.mocked(jsonFetch).mock.calls[0]![1]!.body as string);
    expect(submitted.question).toContain("src/queue.ts L2–3");
    expect(submitted.question).toContain("await save(order);");
    expect(submitted.question).toContain("假设改用「异步队列」");
    fireEvent.change(screen.getByLabelText("本次问题（可编辑）"), { target: { value: "新问题" } });
    await act(async () => pending.resolve(saved({ question: submitted.question })));
    expect(screen.getByRole("status").textContent).toContain("问题或回答已修改");
  });
  it("同一事件重复提交只发一次，等待仍能修改草稿，完整响应按原快照展示", async () => {
    const pending = deferred<unknown>(); vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
    const view = mount();
    const original = saved();
    fireEvent.change(answer(), { target: { value: `  ${original.userAnswer}\n ` } });
    act(() => { fireEvent.submit(answer().closest("form")!); fireEvent.submit(answer().closest("form")!); });
    expect(jsonFetch).toHaveBeenCalledOnce(); expect(answer().disabled).toBe(false);
    const [url, options] = vi.mocked(jsonFetch).mock.calls[0]!;
    expect(url).toBe("/api/tools/resume-defenses/1/drill");
    expect(JSON.parse(options!.body as string)).toEqual({ itemId: item.id, question: original.question, userAnswer: original.userAnswer, defensePlan: item.defensePlan.standardDefense });
    expect(options!.signal!.aborted).toBe(false);
    fireEvent.change(answer(), { target: { value: "等待期间新草稿" } });
    fireEvent.click(screen.getByRole("button", { name: /如何验证/ }));
    await act(async () => pending.resolve(original));
    expect(answer().value).toBe("等待期间新草稿"); expect(screen.queryByText(original.interviewerRoast)).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("问题或回答已修改");
    expect(view.onDrillSaved).toHaveBeenCalledExactlyOnceWith(original);
    fireEvent.change(answer(), { target: { value: original.userAnswer } });
    fireEvent.click(screen.getByRole("button", { name: /具体分工/ }));
    expect(screen.getByText(original.interviewerRoast)).toBeTruthy(); expect(submit().disabled).toBe(false);
  });

  it("空白原答不请求，明确 4xx 拒绝保留草稿且不读取或自动重试", async () => {
    vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("演练已更新，请重新核对", 409));
    const view = mount(); send(" \n "); expect(jsonFetch).not.toHaveBeenCalled();
    send(); await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain("演练已更新");
    expect(answer().value).toBe(saved().userAnswer); expect(submit().disabled).toBe(false);
    expect(jsonFetch).toHaveBeenCalledOnce(); expect(view.onDrillSaved).not.toHaveBeenCalled();
  });

  it("历史空白问题不能触发评分，保留原答供用户修正", () => {
    const view = mount();
    view.rerender(<DefenseDrillDrawer {...view.props} item={{ ...item, deadlyQuestions: [" "] }} />);
    fireEvent.click(screen.getByRole("button", { name: "追问 #1" })); send();
    expect(screen.getByRole("alert").textContent).toContain("请选择有效的练习问题");
    expect(jsonFetch).not.toHaveBeenCalled(); expect(answer().value).toBe(saved().userAnswer);
  });
});

describe("演练异常完成与存档读取", () => {
  it.each(["matched", "different", "absent", "mismatched", "changed-quote", "unreadable"])(
    "408 后核对 %s 存档，等待禁写并保留当前问题及新草稿", async (mode) => {
      const read = deferred<unknown>();
      vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("提交等待超时", 408)).mockReturnValueOnce(read.promise);
      const view = mount(); send();
      await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(2));
      expect(jsonFetch).toHaveBeenLastCalledWith("/api/tools/resume-defenses/1", expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }));
      expect(screen.getByRole("button", { name: "面试官批改中…" }).hasAttribute("disabled")).toBe(true);
      fireEvent.change(answer(), { target: { value: "超时核对期间继续输入的新草稿" } });
      fireEvent.click(screen.getByRole("button", { name: /如何验证/ }));
      fireEvent.submit(answer().closest("form")!);
      expect(jsonFetch).toHaveBeenCalledTimes(2);
      const matching = detail([saved()]);
      const stored = mode === "different" ? detail([saved({ userAnswer: "另一份原答", interviewerRoast: "另一原答点评" })])
        : mode === "absent" ? detail() : matching;
      await act(async () => {
        if (mode === "unreadable") read.reject(new HttpError("存档读取失败", 503));
        else read.resolve(mode === "mismatched" ? detail([], 2)
          : mode === "changed-quote" ? { ...matching, report: { ...matching.report, items: [{ ...item, originalText: "引用已改变" }] } } : stored);
      });
      if (["mismatched", "changed-quote", "unreadable"].includes(mode)) {
        expect(screen.getByRole("alert").textContent).toContain("演练保存结果尚未确认");
        expect(submit().disabled).toBe(true);
        expect(view.onDrillsReloaded).not.toHaveBeenCalled();
        const retryRead = deferred<unknown>();
        vi.mocked(jsonFetch).mockReturnValueOnce(retryRead.promise);
        const retry = screen.getByRole("button", { name: "重新读取演练存档" });
        act(() => { fireEvent.click(retry); fireEvent.click(retry); });
        expect(jsonFetch).toHaveBeenCalledTimes(3);
        await act(async () => retryRead.resolve(matching));
      }
      expect(answer().value).toBe("超时核对期间继续输入的新草稿");
      expect(submit().disabled).toBe(false);
      expect(screen.queryByText(saved().interviewerRoast)).toBeNull();
      expect(screen.queryByText("另一原答点评")).toBeNull();
      expect(view.onDrillSaved).not.toHaveBeenCalled();
      expect(view.onDrillsReloaded).toHaveBeenCalledExactlyOnceWith(stored.drills);
      expect(screen.getByRole("alert").textContent).toContain(mode === "different" || mode === "absent" ? "原请求仍可能稍后保存" : "不能确认本次请求已完成");
      expect(vi.mocked(jsonFetch).mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
      fireEvent.change(answer(), { target: { value: saved().userAnswer } });
      fireEvent.click(screen.getByRole("button", { name: /具体分工/ }));
      if (mode !== "different" && mode !== "absent") expect(screen.getByText(saved().interviewerRoast)).toBeTruthy();
    }
  );

  it.each([null, {}, { ...saved(), defenseId: 2 }, { ...saved(), itemId: "item_2" }, { ...saved(), question: "别的题" },
    { ...saved(), userAnswer: "别的原答" }, { ...saved(), id: "10" }, { ...saved(), defenseScore: null },
    { ...saved(), defenseScore: 101 }, { ...saved(), interviewerRoast: {} }, { ...saved(), updatedAt: null }])("坏响应 %# 不显示、不回调，核对失败只允许只读重试", async (value) => {
    vi.mocked(jsonFetch).mockResolvedValueOnce(value).mockRejectedValueOnce(new HttpError("状态读取失败", 503));
    const view = mount(); send();
    await screen.findByText(/演练保存结果尚未确认/);
    expect(view.onDrillSaved).not.toHaveBeenCalled(); expect(view.onDrillsReloaded).not.toHaveBeenCalled();
    expect(screen.queryByText(saved().interviewerRoast)).toBeNull(); expect(submit().disabled).toBe(true);
    expect(screen.getByText("请先核对存档，再决定是否提交")).toBeTruthy();
    expect(screen.getByRole("button", { name: "关闭演练" })).toBeTruthy();
    fireEvent.submit(answer().closest("form")!); expect(jsonFetch).toHaveBeenCalledTimes(2);
    expect(jsonFetch).toHaveBeenLastCalledWith("/api/tools/resume-defenses/1", expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }));
  });

  it("损坏完成后核对同问题原答的存档，保留等待期间新稿，并声明无法证明本次请求已完成", async () => {
    const read = deferred<unknown>();
    vi.mocked(jsonFetch).mockResolvedValueOnce({}).mockReturnValueOnce(read.promise);
    const view = mount(); send();
    await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(2));
    fireEvent.change(answer(), { target: { value: "核对期间继续写的新稿" } });
    await act(async () => read.resolve(detail([saved()])));
    expect(answer().value).toBe("核对期间继续写的新稿"); expect(submit().disabled).toBe(false);
    expect(screen.queryByText(saved().interviewerRoast)).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("不能确认本次请求已完成");
    expect(view.onDrillsReloaded).toHaveBeenCalledExactlyOnceWith([saved()]);
    expect(view.onDrillSaved).not.toHaveBeenCalled();
    fireEvent.change(answer(), { target: { value: saved().userAnswer } });
    expect(screen.getByText(saved().interviewerRoast)).toBeTruthy();
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
  });

  it.each([[], [saved({ userAnswer: "另一份已存原答", interviewerRoast: "另一个原答的点评" })]].map((stored) => ({ stored })))("存档没有相同原答时不冒充成功，刷新实际演练列表并只允许显式再提交 %#", async ({ stored }) => {
    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("写入响应异常")).mockResolvedValueOnce(detail(stored)).mockResolvedValueOnce(saved());
    const view = mount(saved({ userAnswer: "之前的原答" })); send();
    await screen.findByText(/当前存档未找到/); expect(answer().value).toBe(saved().userAnswer);
    expect(submit().disabled).toBe(false); expect(view.onDrillsReloaded).toHaveBeenCalledExactlyOnceWith(stored);
    expect(screen.queryByText("另一个原答的点评")).toBeNull(); expect(jsonFetch).toHaveBeenCalledTimes(2);
    fireEvent.click(submit()); await screen.findByText(saved().interviewerRoast);
    expect(view.onDrillSaved).toHaveBeenCalledExactlyOnceWith(saved()); expect(jsonFetch).toHaveBeenCalledTimes(3);
  });

  it.each([detail([], 2), { report: detail().report }, { ...detail(), drills: [saved({ defenseId: 2 })] },
    { ...detail(), report: { ...detail().report, items: [{ ...item, originalText: "已变化的引用" }] } }, new HttpError("报告已删除", 404)])("串记录、坏存档或材料变化 %# 保持未知锁，不自动评分", async (value) => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({});
    if (value instanceof Error) vi.mocked(jsonFetch).mockRejectedValueOnce(value); else vi.mocked(jsonFetch).mockResolvedValueOnce(value);
    const view = mount(); send(); await screen.findByText(/演练保存结果尚未确认/);
    expect(submit().disabled).toBe(true); expect(view.onDrillsReloaded).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "重新读取演练存档" })).toBeTruthy(); expect(jsonFetch).toHaveBeenCalledTimes(2);
  });

  it("重新读取同步互斥，连续失败保留锁，读到相同原答才展示实际存档", async () => {
    const pending = deferred<unknown>();
    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("网络失败")).mockRejectedValueOnce(new Error("首读失败"))
      .mockReturnValueOnce(pending.promise).mockResolvedValueOnce(detail([saved()]));
    const view = mount(); send(); await screen.findByText(/首读失败/);
    const retry = screen.getByRole("button", { name: "重新读取演练存档" });
    act(() => { fireEvent.click(retry); fireEvent.click(retry); });
    expect(jsonFetch).toHaveBeenCalledTimes(3);
    await act(async () => pending.reject(new Error("第二次读取失败")));
    await screen.findByText(/第二次读取失败/); expect(submit().disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "重新读取演练存档" }));
    await screen.findByText(saved().interviewerRoast); expect(submit().disabled).toBe(false);
    expect(view.onDrillsReloaded).toHaveBeenCalledOnce();
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
  });

  it("存档与提交前旧评估完全相同也不声称本次提交完成", async () => {
    const original = saved();
    vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("完成响应丢失")).mockResolvedValueOnce(detail([original]));
    const view = mount(original); send();
    await screen.findByText(/不能确认本次请求已完成/);
    expect(screen.getByText(original.interviewerRoast)).toBeTruthy();
    expect(view.onDrillSaved).not.toHaveBeenCalled(); expect(view.onDrillsReloaded).toHaveBeenCalledExactlyOnceWith([original]);
    expect(jsonFetch).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("等待期间更新回调后使用最新回调；存档核对=%s", async (recover) => {
    const pending = deferred<unknown>();
    if (recover) vi.mocked(jsonFetch).mockResolvedValueOnce({}).mockReturnValueOnce(pending.promise);
    else vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
    const view = mount(); send(); await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(recover ? 2 : 1));
    const latestSaved = vi.fn(); const latestRead = vi.fn();
    view.rerender(<DefenseDrillDrawer {...view.props} onDrillSaved={latestSaved} onDrillsReloaded={latestRead} />);
    await act(async () => pending.resolve(recover ? detail([saved()]) : saved()));
    expect(view.onDrillSaved).not.toHaveBeenCalled(); expect(view.onDrillsReloaded).not.toHaveBeenCalled();
    if (recover) expect(latestRead).toHaveBeenCalledExactlyOnceWith([saved()]);
    else expect(latestSaved).toHaveBeenCalledExactlyOnceWith(saved());
  });
});

describe("关闭与切换后的演练请求归属", () => {
  it.each(["success", "failure"])("关闭后旧提交 %s 不读取存档、不回调或覆盖重新打开的草稿", async (outcome) => {
    const old = deferred<unknown>(); const fresh = deferred<unknown>();
    vi.mocked(jsonFetch).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const view = mount(); send();
    view.rerender(<DefenseDrillDrawer {...view.props} isOpen={false} />);
    expect(vi.mocked(jsonFetch).mock.calls[0]![1]!.signal!.aborted).toBe(true);
    view.rerender(<DefenseDrillDrawer {...view.props} />); send("新抽屉原答");
    await act(async () => { if (outcome === "success") old.resolve(saved()); else old.reject(new Error("旧错误")); });
    expect(view.onDrillSaved).not.toHaveBeenCalled(); expect(view.onDrillsReloaded).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull(); expect(answer().value).toBe("新抽屉原答");
    expect(jsonFetch).toHaveBeenCalledTimes(2); expect(screen.getByRole("button", { name: "面试官批改中…" })).toBeTruthy();
    await act(async () => fresh.resolve(saved({ userAnswer: "新抽屉原答", interviewerRoast: "新点评" })));
    expect(screen.getByText("新点评")).toBeTruthy(); expect(view.onDrillSaved).toHaveBeenCalledOnce();
  });

  it.each(["success", "failure"])("切换条目后旧核对 %s 不影响新条目", async (outcome) => {
    const old = deferred<unknown>();
    vi.mocked(jsonFetch).mockResolvedValueOnce({}).mockReturnValueOnce(old.promise);
    const view = mount(); send(); await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(2));
    const next = { ...item, id: "item_2", originalText: "另一条引用" };
    view.rerender(<DefenseDrillDrawer {...view.props} item={next} />);
    fireEvent.change(answer(), { target: { value: "新条目草稿" } });
    await act(async () => { if (outcome === "success") old.resolve(detail([saved()])); else old.reject(new Error("旧读取错误")); });
    expect(answer().value).toBe("新条目草稿"); expect(submit().disabled).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull(); expect(view.onDrillsReloaded).not.toHaveBeenCalled();
    expect(view.onDrillSaved).not.toHaveBeenCalled();
  });
});
