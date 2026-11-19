// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Page from "../page";
import { SalaryPlaygroundReport } from "@/components/salary/playground-report";
import { SalaryPlaygroundMentor } from "@/components/salary/playground-mentor";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import { confirmDialog } from "@/components/common/confirm-dialog";
import type { NegotiationReport, NegotiationTurnData, SalaryNegotiationDetail } from "@/lib/salary-negotiation";

const navigation = vi.hoisted(() => ({ id: "1", push: vi.fn() }));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: navigation.id }), useRouter: () => ({ push: navigation.push }) }));
vi.mock("@/lib/fetcher", async (original) => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
vi.mock("@/components/common/confirm-dialog", async (original) => ({ ...await original<typeof import("@/components/common/confirm-dialog")>(), confirmDialog: vi.fn() }));

const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
beforeEach(() => { navigation.id = "1"; Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() }); });
afterEach(() => {
  cleanup();
  if (originalScroll) Object.defineProperty(HTMLElement.prototype, "scrollTo", originalScroll);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

function turn(turnNo: number, userMessage = ""): NegotiationTurnData {
  return {
    id: turnNo, negotiation_id: 1, turn_no: turnNo, user_message: userMessage,
    hr_response: `模拟 HR 第 ${turnNo} 轮：奖金需审批，尚未书面确认。`, hr_tactics: "先核对条件",
    hr_mindset: { looseness: 0, current_attitude: "模拟：仍需核实", estimated_package: "模拟：未确定", tactics_label: "模拟澄清", internal_pressure: "未设定" },
    mentor_analysis: {
      user_argument_score: userMessage.trim() ? 8 : 5, strengths: [`第 ${turnNo} 轮原始亮点`],
      vulnerabilities: [`第 ${turnNo} 轮原始待确认事项`], tactical_tips: `第 ${turnNo} 轮原始建议`,
      suggested_replies: [{ title: `第 ${turnNo} 轮澄清方案`, content: `第 ${turnNo} 轮参考：我仅认可月薪，奖金仍需审批。`, rationale: "核对保证现金与附加条件" }],
    }, created_at: "2026-10-28",
  };
}

const revision = "a".repeat(64);
const updatedRevision = "b".repeat(64);

function turnResponse(turnNo: number, userMessage: string) {
  return { ...turn(turnNo, userMessage), base_revision: revision, revision: updatedRevision };
}

function detail(turns = [turn(1)]): SalaryNegotiationDetail & { revision: string } {
  return {
    id: 1, revision, target_company_tier: "top_tech", target_role: "接口工程师", expected_salary: "税前 CNY 30k × 12",
    current_or_competing_offer: "暂无竞品 Offer", hr_style: "standard", status: "ongoing", initial_offer: "模拟 28k × 12",
    final_package: "", report: null, created_at: "2026-10-28", finished_at: "", turns,
  };
}

function report(summary: string): NegotiationReport {
  return {
    final_package_summary: summary, score: 78, persuasion_grade: "B", leverage_efficiency: "金额口径尚未齐全，无法计算增益。",
    turn_critiques: [{ turn_no: 2, gain_or_loss: "neutral", summary: "尚未确认奖金", key_point: "提出核实请求，HR 尚未作答" }],
    real_world_tips: ["先确认审批与书面方案"], mentor_summary: "原始复盘建议，不保证涨薪。",
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe("谈薪模拟的状态、材料与评分展示", () => {
  it("旧空对象不显示默认评分、心理状态或自动生成的参考", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ...detail(), turns: [{ ...turn(1, "已有候选人发言"), hr_mindset: {}, mentor_analysis: {} }] });
    render(<Page />);
    await screen.findByText("旧记录未保存模拟方案");
    expect(screen.getAllByText("未保存有效评分")).toHaveLength(2);
    expect(screen.getByText("未保存有效数值")).toBeTruthy();
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.queryByText("/10")).toBeNull();
    expect(screen.queryByRole("button", { name: /一键填入/ })).toBeNull();
    expect(screen.getByText("旧记录未保存具体亮点")).toBeTruthy();
    expect(screen.queryByText(/态度稳健|底牌展露略快|综合表现稳健/)).toBeNull();
    expect(vi.mocked(jsonFetch).mock.calls[0]![1]).toMatchObject({ cache: "no-store", signal: expect.any(AbortSignal) });
  });

  it.each([null, "75", true, -1, 101])("历史报告分数 %j 不补分、不夹取，仍保留实际复盘正文", async (score) => {
    const summary = "历史结果，奖金尚未确认";
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ...detail([turn(2, "实际原话")]), status: "finished", report: { ...report(summary), score, persuasion_grade: "A" } });
    render(<Page />);
    await screen.findByRole("heading", { name: `本次模拟结果：${summary}` });
    expect(screen.getByText("未保存有效评分")).toBeTruthy();
    expect(screen.getByText("未保存有效评级")).toBeTruthy();
    expect(screen.queryByText("A", { exact: true })).toBeNull();
    expect(screen.getByText("原始复盘建议，不保证涨薪。")).toBeTruthy();
  });

  it("历史小数和长文本保持原样，参考原文可完整填入", async () => {
    const long = "Long_".repeat(100) + " <T> &amp;\n奖金需审批，尚未确认。";
    const saved = turn(2, "已有原答");
    saved.hr_mindset.looseness = 20.5;
    saved.mentor_analysis.user_argument_score = 7.5;
    saved.mentor_analysis.suggested_replies = Array.from({ length: 4 }, (_, index) => ({ title: `历史方案_${index}`, content: `${index}${long}`, rationale: long }));
    vi.mocked(jsonFetch).mockResolvedValueOnce(detail([saved]));
    render(<Page />);
    await screen.findByText("20.5%");
    expect(screen.getByText("7.5", { exact: true })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "一键填入输入框 ↗" })).toHaveLength(4);
    fireEvent.click(screen.getAllByRole("button", { name: "一键填入输入框 ↗" })[3]!);
    expect((screen.getByRole("textbox", { name: "你的练习回复" }) as HTMLTextAreaElement).value).toBe(`3${long}`);
    expect(jsonFetch).toHaveBeenCalledOnce();
  });

  it("报告零分不视为缺失，保留历史评级而不按新标尺重算", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ...detail([turn(2, "实际原话")]), status: "finished", report: { ...report("旧结果"), score: 0, persuasion_grade: "A" } });
    render(<Page />);
    await screen.findByRole("heading", { name: "本次模拟结果：旧结果" });
    expect(screen.getByText("0", { exact: false, selector: "span.font-mono.text-2xl" }).textContent).toBe("0 / 100");
    expect(screen.getByText("A", { exact: true })).toBeTruthy();
    expect(screen.queryByText("未保存有效评分")).toBeNull();
  });

  it.each([null, { ...detail(), id: 2 }, { ...detail(), turns: [{ ...turn(1), negotiation_id: 2 }] }, { ...detail(), turns: [turn(1), turn(1)] }])(
    "损坏或串记录响应不展示正文及写入口，只读重试可以恢复（%#）", async (invalid) => {
      vi.mocked(jsonFetch).mockResolvedValueOnce(invalid).mockResolvedValueOnce(detail());
      render(<Page />);
      await screen.findByRole("alert");
      expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
      expect(screen.queryByRole("textbox")).toBeNull();
      expect(screen.getByRole("link", { name: "← 返回博弈列表" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
      await screen.findByRole("textbox", { name: "你的练习回复" });
      expect(jsonFetch).toHaveBeenCalledTimes(2);
      expect(vi.mocked(jsonFetch).mock.calls.every(([url, options]) => url === "/api/tools/salary-negotiations/1" && !options?.method)).toBe(true);
    },
  );

  it.each([false, true])("切换记录立即移除旧草稿并中止旧读取，旧请求迟到%s不污染新页", async (fails) => {
    const old = deferred<SalaryNegotiationDetail>();
    const current = { ...detail([turn(1)]), id: 2, target_role: "新记录岗位", turns: [{ ...turn(1), negotiation_id: 2 }] };
    vi.mocked(jsonFetch).mockReturnValueOnce(old.promise).mockResolvedValueOnce(current);
    const view = render(<Page />);
    await waitFor(() => expect(jsonFetch).toHaveBeenCalledOnce());
    const oldSignal = vi.mocked(jsonFetch).mock.calls[0]![1]!.signal!;
    navigation.id = "2"; view.rerender(<Page />);
    await screen.findByRole("heading", { name: "新记录岗位" });
    expect(oldSignal.aborted).toBe(true);
    const input = screen.getByRole("textbox", { name: "你的练习回复" });
    fireEvent.change(input, { target: { value: "新记录草稿，尚未发送" } });
    await act(async () => { if (fails) old.reject(new Error("旧记录读取失败")); else old.resolve(detail()); });
    expect(screen.getByRole("heading", { name: "新记录岗位" })).toBeTruthy();
    expect((input as HTMLTextAreaElement).value).toBe("新记录草稿，尚未发送");
    expect(screen.queryByRole("alert")).toBeNull(); expect(jsonFetch).toHaveBeenCalledTimes(2);
  });

  it("已有正文切换后立即隐藏，等待新记录期间不能发送旧原答或删除旧记录", async () => {
    const pending = deferred<SalaryNegotiationDetail>();
    vi.mocked(jsonFetch).mockResolvedValueOnce(detail()).mockReturnValueOnce(pending.promise);
    const view = render(<Page />);
    const input = await screen.findByRole("textbox", { name: "你的练习回复" });
    fireEvent.change(input, { target: { value: "旧记录的未发送草稿" } });
    navigation.id = "2"; view.rerender(<Page />);
    expect(screen.queryByRole("textbox")).toBeNull(); expect(screen.queryByRole("button", { name: "删除" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "接口工程师" })).toBeNull();
    await act(async () => { pending.resolve({ ...detail(), id: 2, turns: [] }); });
    expect((screen.getByRole("textbox", { name: "你的练习回复" }) as HTMLTextAreaElement).value).toBe("");
  });

  it.each([
    "尚未达成一致；仅认可税前 CNY 月薪 30k，奖金与薪数待确认。",
    "模拟方案：税前 USD 6000 × 12，签字费需审批，尚未书面确认。",
    "候选人单方愿意接受，HR 尚未回应，不能确认双方一致。",
  ])("已结束记录保留完整结果 %j，不改写为达成", async (summary) => {
    const saved = { ...detail([turn(1), turn(2, "我只认可月薪")]), status: "finished", final_package: summary, report: report(summary) };
    const before = structuredClone(saved);
    vi.mocked(jsonFetch).mockResolvedValueOnce(saved);
    render(<Page />);
    await screen.findByRole("heading", { name: `本次模拟结果：${summary}` });
    expect(screen.getByText("● 模拟已结束 / 已复盘")).toBeTruthy();
    expect(screen.getByText(saved.report.leverage_efficiency)).toBeTruthy();
    expect(screen.getByText(saved.report.mentor_summary)).toBeTruthy();
    expect(screen.getByText("中性点评")).toBeTruthy();
    expect(screen.getByText("模拟练习评分")).toBeTruthy();
    expect(screen.queryByText(/最终锁定 Package|平稳推进|达成共识 \/ 结束复盘/)).toBeNull();
    expect(screen.queryByRole("textbox", { name: "你的练习回复" })).toBeNull();
    expect(screen.queryByRole("button", { name: /一键填入/ })).toBeNull();
    expect(jsonFetch).toHaveBeenCalledOnce();
    expect(saved).toEqual(before);
  });

  it("保存的单方接受不遮住报告中的未达成状态与未确认条件", async () => {
    const savedPackage = "我接受 36k。";
    const summary = "尚未达成；HR 尚未确认 36k，币种、保证薪数与奖金均待确认。";
    const saved = { ...detail([turn(2, "如果能给 36k，我可以接受。")]), status: "finished", final_package: savedPackage, report: report(summary) };
    const before = structuredClone(saved);
    vi.mocked(jsonFetch).mockResolvedValueOnce(saved);
    render(<Page />);
    await screen.findByRole("heading", { name: `本次模拟结果：${summary}` });
    expect(screen.getByText(`保存的方案说明：${savedPackage}`).textContent).toBe(`保存的方案说明：${savedPackage}`);
    expect(screen.queryByRole("heading", { name: `本次模拟结果：${savedPackage}` })).toBeNull();
    expect(saved).toEqual(before);
  });

  it.each([
    { summary: "报告：尚未达成，奖金待核实", savedPackage: "", heading: "本次模拟结果：报告：尚未达成，奖金待核实" },
    { summary: "", savedPackage: "旧记录中的方案，来源未另行标记", heading: "保存的方案说明：旧记录中的方案，来源未另行标记" },
    { summary: "", savedPackage: "", heading: "旧记录未保存结果摘要" },
  ])("历史报告缺少部分结果文字时仅显示已有信息（%#）", ({ summary, savedPackage, heading }) => {
    render(<SalaryPlaygroundReport report={report(summary)} finalPackage={savedPackage} hasCandidateResponses />);
    expect(screen.getByRole("heading", { name: heading })).toBeTruthy();
    if (!summary) expect(screen.queryByRole("heading", { name: /^本次模拟结果：/ })).toBeNull();
    expect(screen.queryByText(/候选人补记：|双方已确认：/)).toBeNull();
  });

  it("保存方案与报告摘要完全相同时只显示一份原文", () => {
    const summary = "尚未达成一致；税前 CNY 30k，奖金待确认。";
    const view = render(<SalaryPlaygroundReport report={report(summary)} finalPackage={summary} hasCandidateResponses />);
    expect(screen.getByRole("heading", { name: `本次模拟结果：${summary}` })).toBeTruthy();
    expect(view.container.textContent!.split(summary)).toHaveLength(2);
  });

  it("不同结果文字保留完整长文本、换行与字面量，不按空白归并", () => {
    const summary = "Long_".repeat(120) + " <T> &amp;\n奖金需审批，尚未确认。";
    const savedPackage = `  ${summary}\n`;
    const generated = report(summary);
    const before = structuredClone(generated);
    const view = render(<SalaryPlaygroundReport report={generated} finalPackage={savedPackage} hasCandidateResponses />);
    expect(view.container.querySelector("h2")?.textContent).toBe(`本次模拟结果：${summary}`);
    expect(screen.getByText(`保存的方案说明：${savedPackage}`, { normalizer: text => text }).textContent).toBe(`保存的方案说明：${savedPackage}`);
    expect(view.container.querySelector("T")).toBeNull();
    expect(generated).toEqual(before);
  });

  it("只有 HR 开场与结束补充的报告不展示候选人表现分或评级", async () => {
    const summary = "尚未达成，仅补记了单方意愿，HR 尚未确认";
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ...detail(), status: "finished", final_package: summary, report: { ...report(summary), turn_critiques: [] } });
    render(<Page />);
    await screen.findByRole("heading", { name: `本次模拟结果：${summary}` });
    expect(screen.queryByText("模拟练习评分")).toBeNull();
    expect(screen.queryByText("B", { exact: true })).toBeNull();
    expect(screen.getByText(/尚无已提交的候选人发言/)).toBeTruthy();
  });

  it.each([turn(1), turn(9, "  \n"), turn(1, "已有候选人发言")])("按实际发言判断第 $turn_no 回合是否展示评分", (item) => {
    render(<SalaryPlaygroundMentor turns={[item]} activeTurnNo={item.turn_no} onSelectTurn={vi.fn()} onApplySuggestion={vi.fn()} isFinished={false} />);
    if (item.user_message.trim()) {
      expect(screen.getByText(`第 ${item.turn_no} 回合说服力评分`)).toBeTruthy();
      expect(screen.getByText("/10")).toBeTruthy();
      expect(screen.queryByText("开局分析 · 尚未评分")).toBeNull();
    } else {
      expect(screen.getByText("开局分析 · 尚未评分")).toBeTruthy();
      expect(screen.queryByText("/10")).toBeNull();
      expect(screen.queryByText("5")).toBeNull();
    }
    expect(screen.getByText(item.mentor_analysis.tactical_tips)).toBeTruthy();
    expect(screen.getByText(item.mentor_analysis.strengths[0]!)).toBeTruthy();
  });

  it("切换历史回合只查看对应评估；填入参考后必须由用户主动提交", async () => {
    const opening = turn(1);
    const submitted = turn(2, "我的已提交原话");
    vi.mocked(jsonFetch).mockResolvedValueOnce(detail([opening, submitted]));
    render(<Page />);
    await screen.findByText("第 2 回合说服力评分");
    fireEvent.click(screen.getByRole("button", { name: "查看第 1 回合分析" }));
    expect(screen.getByRole("button", { name: "查看第 1 回合分析" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("开局分析 · 尚未评分")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /一键填入输入框/ }));
    const input = screen.getByRole("textbox", { name: "你的练习回复" }) as HTMLTextAreaElement;
    expect(input.value).toBe(opening.mentor_analysis.suggested_replies[0]!.content);
    expect(document.activeElement).toBe(input);
    expect(jsonFetch).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "查看第 2 回合分析" }));
    expect(screen.getByText("第 2 回合说服力评分")).toBeTruthy();
    expect(input.value).toBe(opening.mentor_analysis.suggested_replies[0]!.content);
    expect(jsonFetch).toHaveBeenCalledOnce();
  });

  it("未达成也可结束；按原话提交补充并展示返回的未确认条件", async () => {
    const pending = deferred<{ id: number; base_revision: string; revision: string; status: "finished"; final_package: string; finished_at: string; report: NegotiationReport }>();
    const summary = "尚未达成；税前 CNY 月薪 30k，奖金需审批，尚未书面确认。";
    const supplement = "我仅认可月薪，需 HR 确认奖金与保证薪数。";
    vi.mocked(jsonFetch).mockResolvedValueOnce(detail()).mockReturnValueOnce(pending.promise);
    render(<Page />);
    fireEvent.click(await screen.findByRole("button", { name: "结束模拟 / 生成复盘" }));
    const dialog = within(screen.getByRole("dialog", { name: "结束模拟并生成复盘报告" }));
    fireEvent.change(dialog.getByRole("textbox", { name: "结束补充（可选）" }), { target: { value: ` ${supplement}\n` } });
    fireEvent.click(dialog.getByRole("button", { name: "结束模拟并生成报告" }));
    await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(2));
    expect(vi.mocked(jsonFetch).mock.calls[1]![0]).toBe("/api/tools/salary-negotiations/1/finalize");
    expect(JSON.parse(vi.mocked(jsonFetch).mock.calls[1]![1]!.body as string)).toEqual({ final_words: supplement, expected_revision: revision });
    expect((dialog.getByRole("textbox", { name: "结束补充（可选）" }) as HTMLTextAreaElement).disabled).toBe(true);
    await act(async () => { pending.resolve({ id: 1, base_revision: revision, revision: updatedRevision, status: "finished", final_package: summary, finished_at: "2026-10-29", report: { ...report(summary), turn_critiques: [] } }); await pending.promise; });
    await screen.findByRole("heading", { name: `本次模拟结果：${summary}` });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "结束模拟 / 生成复盘" })).toBeNull();
  });

  it("复盘冲突保留结束补充；重试仍使用用户原话", async () => {
    const summary = "尚未达成，保留待审批条件";
    vi.mocked(jsonFetch).mockResolvedValueOnce(detail()).mockRejectedValueOnce(new HttpError("谈判记录已变更，请刷新后重新生成复盘", 409))
      .mockResolvedValueOnce(detail()).mockResolvedValueOnce({ id: 1, base_revision: revision, revision: updatedRevision, status: "finished", final_package: summary, finished_at: "2026-10-29", report: { ...report(summary), turn_critiques: [] } });
    render(<Page />);
    fireEvent.click(await screen.findByRole("button", { name: "结束模拟 / 生成复盘" }));
    const dialog = within(screen.getByRole("dialog"));
    const input = dialog.getByRole("textbox", { name: "结束补充（可选）" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: summary } });
    fireEvent.click(dialog.getByRole("button", { name: "结束模拟并生成报告" }));
    await screen.findByText(/谈判记录已变更，请刷新后重新生成复盘；已重新读取当前存档/);
    expect(jsonFetch).toHaveBeenCalledTimes(3);
    expect(vi.mocked(jsonFetch).mock.calls[2]![1]).toMatchObject({ cache: "no-store" });
    fireEvent.click(screen.getByRole("button", { name: "结束模拟 / 生成复盘" }));
    const reopened = within(screen.getByRole("dialog"));
    expect((reopened.getByRole("textbox", { name: "结束补充（可选）" }) as HTMLTextAreaElement).value).toBe(summary);
    fireEvent.click(reopened.getByRole("button", { name: "结束模拟并生成报告" }));
    await screen.findByRole("heading", { name: `本次模拟结果：${summary}` });
    expect(JSON.parse(vi.mocked(jsonFetch).mock.calls[3]![1]!.body as string)).toEqual({ final_words: summary, expected_revision: revision });
  });

  it("发送等待期间禁止结束与再次填入，避免覆盖待提交内容", async () => {
    const pending = deferred<NegotiationTurnData>();
    const original = "我仅认可税前月薪，请确认保证薪数。";
    vi.mocked(jsonFetch).mockResolvedValueOnce(detail()).mockReturnValueOnce(pending.promise);
    render(<Page />);
    const input = await screen.findByRole("textbox", { name: "你的练习回复" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: original } });
    fireEvent.click(screen.getByRole("button", { name: "发送话术 · 推进博弈" }));
    expect((screen.getByRole("button", { name: "结束模拟 / 生成复盘" }) as HTMLButtonElement).disabled).toBe(true);
    const apply = screen.getByRole("button", { name: /一键填入输入框/ }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    fireEvent.click(apply);
    expect(input.value).toBe(original);
    expect(JSON.parse(vi.mocked(jsonFetch).mock.calls[1]![1]!.body as string)).toEqual({ user_message: original, expected_revision: revision });
    await act(async () => { pending.resolve(turnResponse(2, original)); await pending.promise; });
    await screen.findByText("第 2 回合说服力评分");
    expect(input.value).toBe("");
    expect((screen.getByRole("button", { name: "结束模拟 / 生成复盘" }) as HTMLButtonElement).disabled).toBe(false);
    expect(jsonFetch).toHaveBeenCalledTimes(2);
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])("中文输入法确认阶段 %j 不发送；普通 Enter 才提交原话", async (ime) => {
    const message = "请确认保证薪数，奖金尚未达成一致。";
    vi.mocked(jsonFetch).mockResolvedValueOnce(detail()).mockResolvedValueOnce(turnResponse(2, message));
    render(<Page />);
    const input = await screen.findByRole("textbox", { name: "你的练习回复" });
    fireEvent.change(input, { target: { value: message } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", ...ime });
    expect(jsonFetch).toHaveBeenCalledOnce();
    expect((input as HTMLTextAreaElement).value).toBe(message);
    fireEvent.keyDown(input, { key: "Enter", code: "Enter", shiftKey: true });
    expect(jsonFetch).toHaveBeenCalledOnce();
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    await screen.findByText("第 2 回合说服力评分");
    expect(JSON.parse(vi.mocked(jsonFetch).mock.calls[1]![1]!.body as string)).toEqual({ user_message: message, expected_revision: revision });
  });

  it("旧版本发送冲突后展示最新报价且保留草稿，用户明确再发送才采用新版本", async () => {
    const original = "我先核对保证收入，未接受奖金条件。";
    const quote = "最新存档报价：月薪 29k，保证 12 薪，奖金另行审批。";
    const changed = { ...detail(), revision: updatedRevision, turns: [{ ...turn(1), hr_response: quote }] };
    vi.mocked(jsonFetch).mockResolvedValueOnce(detail())
      .mockRejectedValueOnce(new HttpError("谈薪记录已更新，请重新读取", 409)).mockResolvedValueOnce(changed)
      .mockResolvedValueOnce({ ...turnResponse(2, original), base_revision: updatedRevision, revision: "c".repeat(64) });
    render(<Page />);
    const input = await screen.findByRole("textbox", { name: "你的练习回复" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: original } });
    fireEvent.click(screen.getByRole("button", { name: "发送话术 · 推进博弈" }));
    await screen.findByText(quote);
    expect(input.value).toBe(original);
    expect(jsonFetch).toHaveBeenCalledTimes(3);
    expect(JSON.parse(vi.mocked(jsonFetch).mock.calls[1]![1]!.body as string)).toEqual({ user_message: original, expected_revision: revision });
    expect(vi.mocked(jsonFetch).mock.calls[2]![1]).toMatchObject({ cache: "no-store" });
    fireEvent.click(screen.getByRole("button", { name: "发送话术 · 推进博弈" }));
    await screen.findByText("第 2 回合说服力评分");
    expect(JSON.parse(vi.mocked(jsonFetch).mock.calls[3]![1]!.body as string)).toEqual({ user_message: original, expected_revision: updatedRevision });
    expect(input.value).toBe(""); expect(screen.getByText(quote)).toBeTruthy();
    expect(jsonFetch).toHaveBeenCalledTimes(4);
  });

  it("成功发送仅清除提交时仍未变化的草稿，不丢失等待期间的新稿", async () => {
    const pending = deferred<unknown>();
    vi.mocked(jsonFetch).mockResolvedValueOnce(detail()).mockReturnValueOnce(pending.promise);
    render(<Page />);
    const input = await screen.findByRole("textbox", { name: "你的练习回复" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "提交快照" } });
    fireEvent.click(screen.getByRole("button", { name: "发送话术 · 推进博弈" }));
    // 即便其他状态源在等待时更新草稿，完成回调也只清除原快照。
    fireEvent.change(input, { target: { value: "等待期间的新稿" } });
    await act(async () => { pending.resolve(turnResponse(2, "提交快照")); });
    expect(input.value).toBe("等待期间的新稿");
    expect(screen.getByText("提交快照", { exact: true })).toBeTruthy();
  });

  it.each(["turn", "finalize", "delete"] as const)("切换记录后旧 %s 的迟到成功或失败均不覆盖正文、草稿或导航", async (kind) => {
    for (const fails of [false, true]) {
      vi.mocked(jsonFetch).mockReset(); navigation.id = "1";
      const pending = deferred<unknown>();
      vi.mocked(confirmDialog).mockResolvedValueOnce(true);
      vi.mocked(jsonFetch).mockResolvedValueOnce(detail()).mockReturnValueOnce(pending.promise)
        .mockResolvedValueOnce({ ...detail([]), id: 2, target_role: "第二份记录的岗位" });
      const view = render(<Page />);
      await screen.findByRole("textbox", { name: "你的练习回复" });
      if (kind === "turn") {
        fireEvent.change(screen.getByRole("textbox", { name: "你的练习回复" }), { target: { value: "旧原话" } });
        fireEvent.click(screen.getByRole("button", { name: "发送话术 · 推进博弈" }));
      } else if (kind === "finalize") {
        fireEvent.click(screen.getByRole("button", { name: "结束模拟 / 生成复盘" }));
        fireEvent.click(screen.getByRole("button", { name: "结束模拟并生成报告" }));
      } else { fireEvent.click(screen.getByRole("button", { name: "删除" })); }
      await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(2));
      const oldSignal = vi.mocked(jsonFetch).mock.calls[1]![1]!.signal!;
      navigation.id = "2"; view.rerender(<Page />);
      await screen.findByRole("heading", { name: "第二份记录的岗位" });
      expect(oldSignal.aborted).toBe(true);
      const fresh = screen.getByRole("textbox", { name: "你的练习回复" }) as HTMLTextAreaElement;
      fireEvent.change(fresh, { target: { value: "新记录草稿" } });
      await act(async () => {
        if (fails) pending.reject(new Error("旧请求迟到失败"));
        else pending.resolve(kind === "turn" ? turnResponse(2, "旧原话") : kind === "delete" ? { ok: true } : {
          id: 1, base_revision: revision, revision: updatedRevision, status: "finished", final_package: "旧结果", finished_at: "2026-10-29", report: { ...report("旧结果"), turn_critiques: [] },
        });
      });
      expect(fresh.value).toBe("新记录草稿"); expect(navigation.push).not.toHaveBeenCalled();
      expect(screen.getByRole("heading", { name: "第二份记录的岗位" })).toBeTruthy();
      expect(screen.queryByText("旧请求迟到失败")).toBeNull(); expect(jsonFetch).toHaveBeenCalledTimes(3);
      view.unmount();
    }
  });
});
