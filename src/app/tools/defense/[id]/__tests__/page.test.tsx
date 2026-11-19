// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Page from "../page";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import type { DefenseDrillRecord, ResumeDefenseReport } from "@/lib/resume-defense";

vi.mock("next/navigation", () => ({ useParams: () => ({ id: "1" }), useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/lib/fetcher", async (original) => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

function report(quote: string, tabooMistakes = ["原提醒_保留"]): ResumeDefenseReport {
  return {
    id: 1, resumeId: null, title: "合成排雷报告", sourceContent: `项目经历\n${quote}`, targetRole: "接口工程师",
    riskLevel: "medium", overallRoast: "分工已说明，结果仍待验证", createdAt: "2026-10-28T00:00:00Z",
    items: [{
      id: "item_1", originalText: quote, sectionHint: "项目经历", riskLevel: "medium", riskType: "scope_ambiguity",
      interviewerRoast: "原点评_保留", deadlyQuestions: ["个人负责哪些部分？", "如何验证本次结果？"],
      defensePlan: { interviewerIntent: "原追问意图_保留", standardDefense: "假设使用缓存；[待补充：真实方案]", tabooMistakes },
    }],
  };
}

function savedDrill(answer: string, question = "个人负责哪些部分？"): DefenseDrillRecord {
  return {
    id: 20, defenseId: 1, itemId: "item_1", question, userAnswer: answer,
    interviewerRoast: "已保存的原答点评", defenseScore: 85, defenseCritique: "原答仍待澄清",
    improvedAnswer: "已保存的原答参考", createdAt: "2026-10-28", updatedAt: "2026-10-28",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("排雷报告与演练的原文、参考和评分展示", () => {
  it.each([
    "保留 Array&lt;T&gt;、&amp;lt;T&amp;gt; 与 A &amp; B，尚未上线",
    "保留 <strong>接口校验</strong> 与 <T>，</resume_excerpt><script>不执行</script>",
  ])("引用 %j 可逐字核对；按实际回答提交，保留原点评", async (quote) => {
    const initial = report(quote);
    const before = structuredClone(initial);
    const answer = "我只负责接口校验，没有选型权，尚未上线。";
    const result: DefenseDrillRecord = {
      id: 20, defenseId: 1, itemId: "item_1", question: initial.items[0]!.deadlyQuestions[1]!, userAnswer: answer,
      interviewerRoast: "已说明适用边界", defenseScore: 85, defenseCritique: "结果仍待核实",
      improvedAnswer: "我仅负责接口校验，结果尚未验证。", createdAt: "2026-10-28", updatedAt: "2026-10-28",
    };
    vi.mocked(jsonFetch).mockResolvedValueOnce({ report: initial, drills: [] }).mockResolvedValueOnce(result);
    render(<Page />);
    await screen.findByRole("heading", { name: initial.title });
    expect(screen.getByText(initial.items[0]!.interviewerRoast)).toBeTruthy();
    expect(screen.getByText(initial.items[0]!.defensePlan.interviewerIntent)).toBeTruthy();
    expect(screen.getByText(/是待核实线索，不是事实认定/)).toBeTruthy();
    fireEvent.click(screen.getByText("核对原始引用"));
    expect(screen.getByLabelText("原始引用").textContent).toBe(quote);
    expect(document.querySelector("script")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "即刻防御演练" }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByLabelText("原始引用").textContent).toBe(quote);
    fireEvent.click(dialog.getByRole("button", { name: "填入练习参考" }));
    const input = dialog.getByRole("textbox", { name: "你的练习回答：" }) as HTMLTextAreaElement;
    expect(input.value).toBe(initial.items[0]!.defensePlan.standardDefense);
    expect(jsonFetch).toHaveBeenCalledTimes(1);
    fireEvent.change(input, { target: { value: answer } });
    fireEvent.click(dialog.getByRole("button", { name: /如何验证本次结果/ }));
    fireEvent.click(dialog.getByRole("button", { name: "提交练习回答" }));
    await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(2));
    const [url, options] = vi.mocked(jsonFetch).mock.calls[1]!;
    expect(url).toBe("/api/tools/resume-defenses/1/drill");
    expect(JSON.parse(options!.body as string)).toEqual({
      itemId: "item_1", question: result.question, userAnswer: answer, defensePlan: initial.items[0]!.defensePlan.standardDefense,
    });
    await screen.findByText("核心回答正确，部分待澄清（85分）");
    expect(screen.getByText(result.improvedAnswer)).toBeTruthy();
    expect(screen.queryByText(/真实动机|满分防御示范|风险可控|被抓包/)).toBeNull();
    expect(initial).toEqual(before);
  });

  it("无明确问题的空报告不暗示已确认安全，也不生成虚构条目", async () => {
    const initial = { ...report("本条无明确问题"), riskLevel: "low", items: [], overallRoast: "本次未发现明确问题，审阅范围有限" };
    vi.mocked(jsonFetch).mockResolvedValue({ report: initial, drills: [] });
    render(<Page />);
    await screen.findByRole("heading", { name: initial.title });
    expect(screen.getByText("本次未发现明确问题")).toBeTruthy();
    expect(screen.getByText(`“${initial.overallRoast}”`)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "即刻防御演练" })).toBeNull();
    expect(screen.queryByText(/风险可控|相对严密|破绽百出/)).toBeNull();
    expect(jsonFetch).toHaveBeenCalledOnce();
  });

  it("无具体禁忌提醒时不显示空的危险提示区块", async () => {
    const initial = report("参与接口校验", []);
    vi.mocked(jsonFetch).mockResolvedValue({ report: initial, drills: [] });
    render(<Page />);
    await screen.findByRole("heading", { name: initial.title });
    expect(screen.queryByText("🚫 应避免的失实表达：")).toBeNull();
    expect(screen.getByText(/追问可能核实的信息/)).toBeTruthy();
    expect(screen.getByText(/练习参考（按已确认事实调整）/)).toBeTruthy();
  });

  it.each(["answer", "question", "reference"])("修改 %s 后旧分数不冒充当前回答评估，恢复原答可查看", async (edit) => {
    const initial = report("参与接口校验");
    const original = savedDrill("我只负责接口校验。");
    vi.mocked(jsonFetch).mockResolvedValue({ report: initial, drills: [original] });
    render(<Page />);
    fireEvent.click(await screen.findByRole("button", { name: "查看/重做对练" }));
    const dialog = within(screen.getByRole("dialog"));
    const input = dialog.getByRole("textbox", { name: "你的练习回答：" });
    expect(dialog.getByText("核心回答正确，部分待澄清（85分）")).toBeTruthy();
    if (edit === "answer") fireEvent.change(input, { target: { value: "新的补充说明，尚未核实。" } });
    else if (edit === "question") fireEvent.click(dialog.getByRole("button", { name: /如何验证本次结果/ }));
    else fireEvent.click(dialog.getByRole("button", { name: "填入练习参考" }));
    expect(dialog.queryByText("核心回答正确，部分待澄清（85分）")).toBeNull();
    expect(dialog.queryByText(original.interviewerRoast)).toBeNull();
    expect(dialog.getByRole("status").textContent).toContain("问题或回答已修改，请重新提交评估");
    fireEvent.change(input, { target: { value: ` ${original.userAnswer} \n` } });
    fireEvent.click(dialog.getByRole("button", { name: /个人负责哪些部分/ }));
    expect(dialog.getByText("核心回答正确，部分待澄清（85分）")).toBeTruthy();
    expect(dialog.getByText(original.interviewerRoast)).toBeTruthy();
    expect(jsonFetch).toHaveBeenCalledOnce();
  });

  it.each(["answer", "question"])("首次评估等待期间修改 %s，响应到达不重置新草稿或把旧分数套到新草稿", async (edit) => {
    const pending = deferred<DefenseDrillRecord>();
    const original = savedDrill("首次提交的原答");
    vi.mocked(jsonFetch).mockResolvedValueOnce({ report: report("参与接口校验"), drills: [] }).mockReturnValueOnce(pending.promise);
    render(<Page />);
    fireEvent.click(await screen.findByRole("button", { name: "即刻防御演练" }));
    let dialog = within(screen.getByRole("dialog"));
    const input = dialog.getByRole("textbox", { name: "你的练习回答：" });
    fireEvent.change(input, { target: { value: original.userAnswer } });
    fireEvent.click(dialog.getByRole("button", { name: "提交练习回答" }));
    await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(2));
    if (edit === "answer") fireEvent.change(input, { target: { value: "等待期间继续写的新草稿" } });
    else fireEvent.click(dialog.getByRole("button", { name: /如何验证本次结果/ }));
    await act(async () => { pending.resolve(original); await pending.promise; });
    dialog = within(screen.getByRole("dialog"));
    expect((dialog.getByRole("textbox", { name: "你的练习回答：" }) as HTMLTextAreaElement).value)
      .toBe(edit === "answer" ? "等待期间继续写的新草稿" : original.userAnswer);
    expect(dialog.queryByText(original.interviewerRoast)).toBeNull();
    expect(dialog.getByRole("status").textContent).toContain("问题或回答已修改，请重新提交评估");
    fireEvent.change(dialog.getByRole("textbox", { name: "你的练习回答：" }), { target: { value: original.userAnswer } });
    fireEvent.click(dialog.getByRole("button", { name: /个人负责哪些部分/ }));
    expect(dialog.getByText(original.interviewerRoast)).toBeTruthy();
  });

  it("保存冲突保留新回答和问题，旧评估不冒充新稿，重试成功后显示对应反馈", async () => {
    const original = savedDrill("之前已保存的原答");
    const revised = { ...original, question: "如何验证本次结果？", userAnswer: "新稿仅说明实际联调分工", interviewerRoast: "新稿对应点评" };
    vi.mocked(jsonFetch).mockResolvedValueOnce({ report: report("参与接口校验"), drills: [original] })
      .mockRejectedValueOnce(new HttpError("该条演练已更新，请刷新后重新评估", 409))
      .mockResolvedValueOnce(revised);
    render(<Page />);
    fireEvent.click(await screen.findByRole("button", { name: "查看/重做对练" }));
    const dialog = within(screen.getByRole("dialog"));
    fireEvent.change(dialog.getByRole("textbox", { name: "你的练习回答：" }), { target: { value: revised.userAnswer } });
    fireEvent.click(dialog.getByRole("button", { name: /如何验证本次结果/ }));
    fireEvent.click(dialog.getByRole("button", { name: "提交练习回答" }));
    await screen.findByText("该条演练已更新，请刷新后重新评估");
    expect((dialog.getByRole("textbox", { name: "你的练习回答：" }) as HTMLTextAreaElement).value).toBe(revised.userAnswer);
    expect(dialog.queryByText(original.interviewerRoast)).toBeNull();
    fireEvent.click(dialog.getByRole("button", { name: "提交练习回答" }));
    await screen.findByText(revised.interviewerRoast);
    expect(JSON.parse(vi.mocked(jsonFetch).mock.calls[2]![1]!.body as string)).toMatchObject({ question: revised.question, userAnswer: revised.userAnswer });
  });
});
