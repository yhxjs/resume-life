// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Page from "../page";
import { PRESET_JARGONS } from "@/lib/jargon-decoder";
import { jsonFetch } from "@/lib/fetcher";

const state = vi.hoisted(() => ({
  records: [] as { id: number; source_text: string; result: string; created_at: string }[],
  push: vi.fn(), reload: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
vi.mock("@/hooks/use-cursor-list", () => ({ useCursorList: () => ({
  items: state.records, total: state.records.length, nextCursor: null, loadingMore: false,
  listError: "", failedCursor: null, loadMore: vi.fn(), reload: state.reload,
}) }));

beforeEach(() => { state.records = []; vi.mocked(jsonFetch).mockReset(); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("黑话速查与历史的证据边界", () => {
  it("提交互斥覆盖确认导航，等待时禁用全部改写入口", async () => {
    const pending = Promise.withResolvers<unknown>();
    vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
    render(<Page />);
    const input = screen.getByRole("textbox", { name: "待解码的 JD 文本或面试原话" });
    fireEvent.change(input, { target: { value: "  原话 <T> &amp;\n不要求值班。  " } });
    fireEvent.click(screen.getByRole("button", { name: PRESET_JARGONS[0]!.keyword }));
    const submit = screen.getByRole("button", { name: "启动暗号解码器 →" });
    act(() => { fireEvent.click(submit); fireEvent.click(submit); });
    expect(jsonFetch).toHaveBeenCalledOnce();
    expect(JSON.parse(vi.mocked(jsonFetch).mock.calls[0]![1]!.body as string)).toEqual({ text: "原话 <T> &amp;\n不要求值班。" });
    expect((input as HTMLTextAreaElement).disabled).toBe(true);
    for (const name of ["填入经典黑话 JD 示例 ↗", "+ 加到输入框", "清空内容"]) {
      const button = screen.getByRole("button", { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      fireEvent.click(button);
    }
    expect((input as HTMLTextAreaElement).value).toBe("  原话 <T> &amp;\n不要求值班。  ");
    expect(screen.getByRole("status").textContent).toContain("风险信号分不代表实际风险概率");
    await act(async () => pending.resolve({ id: 28 }));
    expect(state.push).toHaveBeenCalledExactlyOnceWith("/tools/decoder/28");
    fireEvent.click(submit);
    expect(jsonFetch).toHaveBeenCalledOnce();
    expect((input as HTMLTextAreaElement).disabled).toBe(true);
  });

  it("预置问题复制失败在当前问题旁反馈，重试成功清错，原始输入不被覆盖", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const clipboard = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: clipboard } });
    try {
      const preset = PRESET_JARGONS[0]!;
      render(<Page />);
      const input = screen.getByRole("textbox") as HTMLTextAreaElement;
      fireEvent.change(input, { target: { value: "公司原话 <T> &amp;\n未说明核心协作时段" } });
      fireEvent.click(screen.getByRole("button", { name: preset.keyword }));
      fireEvent.click(screen.getAllByRole("button", { name: "复制" })[0]!);
      const copied = await screen.findByRole("button", { name: "已复制 ✓" });
      clipboard.mockRejectedValueOnce(new Error("denied"));
      fireEvent.click(copied);
      const alert = await screen.findByRole("alert");
      expect(alert.closest("li")?.textContent).toContain(preset.counterQuestions[0]);
      expect(screen.queryByRole("button", { name: "已复制 ✓" })).toBeNull();
      fireEvent.click(screen.getAllByRole("button", { name: "复制" })[0]!);
      await screen.findByRole("button", { name: "已复制 ✓" });
      expect(screen.queryByRole("alert")).toBeNull();
      expect(clipboard).toHaveBeenLastCalledWith(preset.counterQuestions[0]);
      expect(input.value).toBe("公司原话 <T> &amp;\n未说明核心协作时段");
      expect(jsonFetch).not.toHaveBeenCalled();
    } finally {
      if (descriptor) Object.defineProperty(navigator, "clipboard", descriptor);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it.each(PRESET_JARGONS)("$keyword 仅为通用示例，不对未知公司预评风险，追加时保留已有原话", (preset) => {
    render(<Page />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "公司原话：无需加班。" } });
    fireEvent.click(screen.getByRole("button", { name: preset.keyword }));
    expect(preset.riskLevel).toBeNull();
    expect(screen.getByText("通用示例 · 未评估")).toBeTruthy();
    expect(screen.getByText(preset.hiddenMeaning)).toBeTruthy();
    expect(screen.getByText(preset.interviewRule)).toBeTruthy();
    expect(jsonFetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "+ 加到输入框" }));
    expect((input as HTMLTextAreaElement).value).toBe(`公司原话：无需加班。\n${preset.keyword}`);
  });

  it.each([
    [null, "风险未评估"], [1, "文本风险信号较弱 (1分)"], [49, "文本风险信号较弱 (49分)"],
    [50, "存在待核实信号 (50分)"], [74, "存在待核实信号 (74分)"],
    [75, "文本风险信号较强 (75分)"], [100, "文本风险信号较强 (100分)"],
  ])("历史总分 %s 只描述文本信号，不补写公司事实", (score, label) => {
    state.records = [{ id: 17, source_text: "岗位原话", created_at: "2026-10-28", result: JSON.stringify({
      targetSummary: "合成报告", punchline: "仅有岗位文本，需核实实际安排", overallRiskScore: score,
      items: [], riskRatings: {}, companyProfile: { teamStyle: "信息不足", riskFlags: [], cultureSummary: "实际安排尚未确认" }, goldenQuestions: [],
    }) }];
    render(<Page />);
    expect(screen.getByText(label!)).toBeTruthy();
    expect(screen.queryByText(/风险可控|相对稳健/)).toBeNull();
    expect(screen.getByRole("link", { name: "查看报告" }).getAttribute("href")).toBe("/tools/decoder/17");
    expect(jsonFetch).not.toHaveBeenCalled();
  });

  it("损坏历史报告在列表中回退原文标题，仍可打开核对，且不显示残缺评分", () => {
    state.records = [{ id: 17, source_text: "原岗位文字 <T> &amp;\n时间安排未说明", created_at: "2026-10-28", result: JSON.stringify({
      targetSummary: "不完整的报告摘要", punchline: "旧点评", overallRiskScore: 100, items: [null],
    }) }];
    render(<Page />);
    expect(screen.getByRole("link", { name: "原岗位文字 <T> &amp;" }).getAttribute("href")).toBe("/tools/decoder/17");
    expect(screen.queryByText("不完整的报告摘要")).toBeNull();
    expect(screen.queryByText(/100分|旧点评/)).toBeNull();
    expect(jsonFetch).not.toHaveBeenCalled();
  });

  it("提交追加后的原话，沿用服务端报告 ID 导航", async () => {
    vi.mocked(jsonFetch).mockResolvedValue({ id: 27 });
    render(<Page />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "原话：弹性工作制，不要求非工作时间响应。" } });
    fireEvent.click(screen.getByRole("button", { name: "启动暗号解码器 →" }));
    await waitFor(() => expect(state.push).toHaveBeenCalledWith("/tools/decoder/27"));
    expect(jsonFetch).toHaveBeenCalledWith("/api/tools/jargon-decodings", expect.objectContaining({
      method: "POST", body: JSON.stringify({ text: "原话：弹性工作制，不要求非工作时间响应。" }),
    }));
  });
});

it.each([null, {}, { id: "17" }, { id: 0 }, { id: -1 }, { id: 1.5 }, { id: Number.MAX_SAFE_INTEGER + 1 }])("拒绝无效成功 ID，保留 原话 并重读历史（%j）", async (response) => {
  vi.mocked(jsonFetch).mockResolvedValueOnce(response);
  render(<Page />);
  fireEvent.change(screen.getByRole("textbox", { name: "待解码的 JD 文本或面试原话" }), { target: { value: "原 原话 <template> &amp;" } });
  fireEvent.click(screen.getByRole("button", { name: "启动暗号解码器 →" }));
  await screen.findByRole("alert");
  expect(state.push).not.toHaveBeenCalled();
  expect(state.reload).toHaveBeenCalledTimes(1);
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("原 原话 <template> &amp;");
  expect(screen.getByRole("alert").textContent).toContain("请先核对历史是否已有报告");
});

it.each(["success", "failure"])("离开后旧请求 %s 不导航、刷新列表或干扰新页面", async (outcome) => {
  const old = Promise.withResolvers<unknown>();
  const next = Promise.withResolvers<unknown>();
  vi.mocked(jsonFetch).mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
  render(<Page />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "旧 原话" } });
  fireEvent.click(screen.getByRole("button", { name: "启动暗号解码器 →" }));
  const signal = vi.mocked(jsonFetch).mock.calls[0]![1]!.signal;
  cleanup();
  expect(signal?.aborted).toBe(true);
  render(<Page />);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "新 原话" } });
  fireEvent.click(screen.getByRole("button", { name: "启动暗号解码器 →" }));
  await act(async () => { if (outcome === "success") old.resolve({ id: 1 }); else old.reject(new Error("旧请求失败")); });
  expect(state.push).not.toHaveBeenCalled();
  expect(state.reload).not.toHaveBeenCalled();
  expect(screen.queryByRole("alert")).toBeNull();
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("新 原话");
  await act(async () => next.resolve({ id: 2 }));
  expect(state.push).toHaveBeenCalledExactlyOnceWith("/tools/decoder/2");
});

it("生成失败后解锁并保留原话，显式重试只清理输入首尾", async () => {
  vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("上游暂不可用")).mockResolvedValueOnce({ id: 8 });
  render(<Page />);
  const original = "  原话 <T> &amp;\n没有说明值班安排。  ";
  const input = screen.getByRole("textbox") as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: original } });
  fireEvent.click(screen.getByRole("button", { name: "启动暗号解码器 →" }));
  await screen.findByText("上游暂不可用");
  expect(input.value).toBe(original); expect(input.disabled).toBe(false);
  expect((screen.getByRole("button", { name: "启动暗号解码器 →" }) as HTMLButtonElement).disabled).toBe(false);
  expect(state.push).not.toHaveBeenCalled(); expect(state.reload).toHaveBeenCalledOnce();
  expect(JSON.parse(vi.mocked(jsonFetch).mock.calls[0]![1]!.body as string)).toEqual({ text: original.trim() });
  fireEvent.click(screen.getByRole("button", { name: "启动暗号解码器 →" }));
  await act(async () => {});
  expect(state.push).toHaveBeenCalledExactlyOnceWith("/tools/decoder/8");
  expect(jsonFetch).toHaveBeenCalledTimes(2);
  expect(JSON.parse(vi.mocked(jsonFetch).mock.calls[1]![1]!.body as string)).toEqual({ text: original.trim() });
});
