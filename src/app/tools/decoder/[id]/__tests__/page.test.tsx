// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Page from "../page";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import type { JargonDecoderResult } from "@/lib/jargon-decoder";
import { confirmDialog } from "@/components/common/confirm-dialog";

const navigation = vi.hoisted(() => ({ id: "1", push: vi.fn() }));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: navigation.id }), useRouter: () => ({ push: navigation.push }) }));
vi.mock("@/lib/fetcher", async original => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
vi.mock("@/components/common/confirm-dialog", () => ({ confirmDialog: vi.fn() }));
beforeEach(() => { navigation.id = "1"; });
afterEach(() => { cleanup(); vi.resetAllMocks(); });

function report(score: number | null): JargonDecoderResult {
  return {
    targetSummary: "合成岗位文本", punchline: "需要核实工作安排", overallRiskScore: score === null ? null : score * 10,
    riskRatings: { overtime: score, stability: score, resources: score, management: score },
    items: [{
      keyword: "弹性工作制", surfaceMeaning: "时间安排可能灵活", hiddenMeaning: "仅凭这句话不能确认实际工时",
      riskLevel: score === null ? null : score >= 7 ? "high" : score >= 4 ? "medium" : "low",
      riskCategory: "响应边界", warning: "若要求非工作时间持续响应，休息可能受影响",
      interviewRule: "询问核心协作时段，表达真实偏好", counterQuestions: ["核心协作时段如何安排？"],
    }],
    companyProfile: { teamStyle: "信息不足", riskFlags: [], cultureSummary: "只有岗位文本，无法确认实际安排" },
    goldenQuestions: ["最近一次值班是怎样安排的？"],
  };
}

describe("黑话报告的风险信号展示", () => {
  it.each(["exists", "missing", "unreadable", "mismatched"])("408 删除超时后只读核对 %s，两个删除入口保持一致", async mode => {
    const record = { id: 1, source_text: "原输入 <T> &amp;", result: report(4), created_at: "2026-10-28" };
    const read = Promise.withResolvers<unknown>(); vi.mocked(confirmDialog).mockResolvedValue(true);
    vi.mocked(jsonFetch).mockResolvedValueOnce(record).mockRejectedValueOnce(new HttpError("等待删除超时", 408)).mockReturnValueOnce(read.promise);
    render(<Page />); fireEvent.click(await screen.findByRole("button", { name: "删除报告" }));
    await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(3));
    for (const name of ["删除报告", "删除本份报告"]) expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    expect(navigation.push).not.toHaveBeenCalled();
    expect(jsonFetch).toHaveBeenLastCalledWith("/api/tools/jargon-decodings/1", expect.objectContaining({ cache: "no-store" }));
    await act(async () => {
      if (mode === "missing") read.reject(new HttpError("已不存在", 404));
      else if (mode === "unreadable") read.reject(new Error("状态读取失败"));
      else read.resolve({ ...record, id: mode === "mismatched" ? 2 : 1 });
    });
    if (mode === "missing") expect(navigation.push).toHaveBeenCalledExactlyOnceWith("/tools/decoder");
    else if (mode === "exists") {
      for (const name of ["删除报告", "删除本份报告"]) expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(false);
      expect(screen.getByRole("alert").textContent).toContain("记录目前仍存在");
    } else {
      for (const name of ["删除报告", "删除本份报告"]) expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
      expect(screen.getByRole("button", { name: "重新读取删除状态" })).toBeTruthy();
      expect(navigation.push).not.toHaveBeenCalled(); expect(screen.queryByText("报告 #2")).toBeNull();
    }
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
  });

  it("两个删除入口共用确认锁，取消后均恢复", async () => {
    let resolve!: (confirmed: boolean) => void;
    vi.mocked(confirmDialog).mockReturnValueOnce(new Promise<boolean>((yes) => { resolve = yes; }));
    vi.mocked(jsonFetch).mockResolvedValue({ id: 1, source_text: "原输入", result: report(4), created_at: "2026-10-28" });
    render(<Page />);
    const bottom = await screen.findByRole("button", { name: "删除本份报告" });
    act(() => {
      fireEvent.click(bottom);
      fireEvent.click(screen.getByRole("button", { name: "删除报告" }));
    });
    expect(confirmDialog).toHaveBeenCalledOnce();
    // 确认期间保留触发焦点；同步命令锁拦截两个入口的重复点击。
    for (const name of ["删除报告", "删除本份报告"]) fireEvent.click(screen.getByRole("button", { name }));
    expect(confirmDialog).toHaveBeenCalledOnce(); expect(jsonFetch).toHaveBeenCalledOnce();
    await act(async () => resolve(false));
    for (const name of ["删除报告", "删除本份报告"]) expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(false);
    expect(jsonFetch).toHaveBeenCalledOnce();
  });

  it.each([true, false])("切换记录清空旧复制反馈，旧复制完成不影响新报告：%s", async (success) => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const clipboard = vi.fn().mockReturnValueOnce(new Promise<void>((yes, no) => { resolve = yes; reject = no; })).mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: clipboard } });
    try {
      vi.mocked(jsonFetch).mockResolvedValueOnce({ id: 1, source_text: "旧原文", result: report(4), created_at: "2026-10-28" })
        .mockResolvedValueOnce({ id: 2, source_text: "新原文", result: report(7), created_at: "2026-10-28" });
      const view = render(<Page />);
      fireEvent.click(await screen.findByRole("button", { name: "复制" }));
      navigation.id = "2";
      view.rerender(<Page />);
      await screen.findByText("报告 #2");
      await act(async () => success ? resolve() : reject(new Error("旧复制失败")));
      expect(screen.queryByRole("button", { name: "已复制 ✓" })).toBeNull();
      expect(screen.queryByRole("alert")).toBeNull();
      expect((screen.getByRole("button", { name: "复制" }) as HTMLButtonElement).disabled).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: "复制" }));
      await screen.findByRole("button", { name: "已复制 ✓" });
    } finally {
      if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("读取历史无效评分仍按未评估展示，不截断原有长文字", async () => {
    const result = { ...report(4), targetSummary: "原文_".repeat(100), riskRatings: {}, overallRiskScore: "未知" };
    vi.mocked(jsonFetch).mockResolvedValue({ id: 1, source_text: "原输入", result, created_at: "2026-10-28" });
    render(<Page />);
    await screen.findByText(result.targetSummary, { exact: true });
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.getAllByText("未评估")).toHaveLength(5);
  });

  it("复制原问题期间禁用其他写入，失败在问题旁显示，重试不沿用旧成功提示", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const clipboard = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: clipboard } });
    try {
      const result = report(4);
      result.items[0]!.counterQuestions = ["原问题 <T> &amp;\n尚未确认的响应条件有哪些？"];
      const original = structuredClone(result);
      vi.mocked(jsonFetch).mockResolvedValue({ id: 1, source_text: "原输入", result, created_at: "2026-10-28" });
      render(<Page />);
      fireEvent.click(await screen.findByRole("button", { name: "复制" }));
      const copied = await screen.findByRole("button", { name: "已复制 ✓" });
      let reject!: (reason: Error) => void;
      clipboard.mockReturnValueOnce(new Promise<void>((_resolve, no) => { reject = no; }));
      fireEvent.click(copied);
      expect(screen.queryByRole("button", { name: "已复制 ✓" })).toBeNull();
      for (const name of ["复制", "复制提问"]) expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "复制提问" }));
      expect(clipboard).toHaveBeenCalledTimes(2);
      await act(async () => { reject(new Error("denied")); });
      const alert = await screen.findByRole("alert");
      expect(alert.closest("li")?.textContent).toContain(result.items[0]!.counterQuestions[0]);
      expect(alert.textContent).toContain("手动复制");
      fireEvent.click(screen.getByRole("button", { name: "复制" }));
      await screen.findByRole("button", { name: "已复制 ✓" });
      expect(screen.queryByRole("alert")).toBeNull();
      await waitFor(() => expect(clipboard).toHaveBeenLastCalledWith(result.items[0]!.counterQuestions[0]));
      fireEvent.click(screen.getByRole("button", { name: "复制提问" }));
      await waitFor(() => expect(clipboard).toHaveBeenLastCalledWith(result.goldenQuestions[0]));
      expect(result).toEqual(original);
      expect(jsonFetch).toHaveBeenCalledOnce();
    } finally {
      if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("损坏报告保留原始输入供核对，不把恢复流程导向先删除记录", async () => {
    const source = "原输入 <T> &amp;\n弹性工作制，核心协作时段尚未说明。";
    vi.mocked(jsonFetch).mockResolvedValue({ id: 1, source_text: source, result: null, created_at: "2026-10-28" });
    render(<Page />);
    await screen.findByText(/该报告内容无法解析/);
    fireEvent.click(screen.getByText("查看原始 JD / 输入文本"));
    expect(screen.getByRole("region", { name: "原始输入文本" }).textContent).toBe(source);
    expect(screen.getByRole("link", { name: "返回重试" }).getAttribute("href")).toBe("/tools/decoder");
    expect(screen.queryByText(/可删除.*后重新生成/)).toBeNull();
    expect(screen.queryByRole("meter")).toBeNull();
    expect(jsonFetch).toHaveBeenCalledOnce();
  });

  it.each([
    { score: 1, label: "文本风险信号较弱", color: "bg-primary" },
    { score: 3, label: "文本风险信号较弱", color: "bg-primary" },
    { score: 4, label: "存在待核实信号", color: "bg-accent" },
    { score: 6, label: "存在待核实信号", color: "bg-accent" },
    { score: 7, label: "风险信号较强", color: "bg-danger" },
    { score: 10, label: "风险信号较强", color: "bg-danger" },
    { score: null, label: "未提供有效评分", color: "bg-line" },
  ])("四维 $score 分遵循 1-3 / 4-6 / 7-10 的含义，未评估不当低风险", async ({ score, label, color }) => {
    const result = report(score);
    const original = structuredClone(result);
    vi.mocked(jsonFetch).mockResolvedValue({ id: 1, source_text: "岗位提供弹性工作制", result, created_at: "2026-10-28" });
    render(<Page />);
    await screen.findByText(result.targetSummary);
    for (const name of ["加班过劳指数", "业务动荡指数", "资源匮乏指数", "管理内耗指数"]) {
      const group = within(screen.getByRole("group", { name }));
      expect(group.getByText(new RegExp(label))).toBeTruthy();
      if (score === null) {
        expect(group.queryByRole("meter")).toBeNull();
        expect(group.getByText("未评估")).toBeTruthy();
      } else {
        const meter = group.getByRole("meter", { name });
        expect(meter.getAttribute("aria-valuenow")).toBe(String(score));
        expect(meter.firstElementChild?.classList.contains(color)).toBe(true);
      }
    }
    expect(screen.getByText(result.items[0]!.hiddenMeaning)).toBeTruthy();
    expect(screen.getByText(result.companyProfile.cultureSummary)).toBeTruthy();
    expect(screen.getByText(/分数不代表实际风险概率，低分不等于已确认安全/)).toBeTruthy();
    expect(screen.queryByText(/风险可控|相对稳健|大概率无偿高频加班|主营业务稳固/)).toBeNull();
    expect(result).toEqual(original);
    expect(jsonFetch).toHaveBeenCalledTimes(1);
  });
});
