// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Page from "../page";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import { confirmDialog } from "@/components/common/confirm-dialog";
import type { ResignationGapRemedyResult } from "@/lib/career-gap-remedy";

const navigation = vi.hoisted(() => ({ id: "1", push: vi.fn() }));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: navigation.id }), useRouter: () => ({ push: navigation.push }) }));
vi.mock("@/lib/fetcher", async (original) => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
vi.mock("@/components/common/confirm-dialog", () => ({ confirmDialog: vi.fn() }));
const clipboard = vi.fn();
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
beforeEach(() => {
  navigation.id = "1"; vi.mocked(confirmDialog).mockResolvedValue(true);
  clipboard.mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: clipboard } });
});
afterEach(() => {
  cleanup();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
  vi.resetAllMocks();
});

function report(): ResignationGapRemedyResult {
  return {
    title: "休整后的真实安排", punchline: "休息不等于能力不足，未确定的安排仍待澄清",
    hrMindsetAnalysis: { coreConcerns: [], riskPoints: [], whatHrWantsToHear: "到岗安排尚未确认；无需披露无关病史。" },
    reframeFormula: { factAcknowledgment: "休息六个月", positiveAttribution: "个人选择休息", growthAndValue: "未开展学习与项目", motivationAlignment: "[待补充：真实岗位方向]" },
    scripts: {
      concise: { label: "原精炼标签", applicableScene: "初步沟通", script: "我休息了六个月，没有学习与项目；到岗尚未确定。", keyPoints: ["保留原事实"] },
      detailed: { label: "原详细标签", applicableScene: "进一步沟通", script: "我休息了六个月，没有做项目。\n[待补充：岗位相关安排]；无需说明无关病史。", keyPoints: ["原隐私提醒"] },
      pivoting: { label: "原衔接标签", applicableScene: "讨论岗位", script: "尚未决定方向，不承诺立即到岗；<T> &amp; 仅为原字符。", keyPoints: ["原未知项"] },
    },
    drills: [{ question: "目前能确认哪些时间安排？", hrConcern: "可能核实到岗条件，不能确认招聘方心理", bestResponse: "[待补充：实际安排]，目前尚未承诺到岗。" }],
    forbiddenList: ["不编造学习、项目或康复结论"], closingTips: ["只沟通与岗位有关的实际条件"],
  };
}

function saved(result: ResignationGapRemedyResult | null) {
  return { id: 1, scenario_type: "gap", raw_story: "原始经历 <T> &amp;：休息六个月，没有学习或项目；到岗尚未确定。", target_role: "尚未确定", persona_style: "composed", result, created_at: "2026-10-28" };
}

describe("空窗详情的事实、参考与复制", () => {
  it("历史追问未保存回答时不允许复制空白覆盖剪贴板", async () => {
    const result = report(); result.drills[0]!.bestResponse = " \n ";
    vi.mocked(jsonFetch).mockResolvedValueOnce(saved(result)); render(<Page />);
    await screen.findByText(result.drills[0]!.question);
    const button = screen.getByRole("button", { name: "复制" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true); fireEvent.click(button); expect(clipboard).not.toHaveBeenCalled();
    expect(screen.getByText(/此追问未保存回答参考/)).toBeTruthy();
  });
  it.each(["detailed", "pivoting"] as const)("历史报告仅有 %s 正文时优先展示原文，空版本不可复制", async (available) => {
    const result = report();
    for (const key of ["concise", "detailed", "pivoting"] as const) {
      if (key !== available) result.scripts[key].script = " \n ";
    }
    const original = structuredClone(result);
    vi.mocked(jsonFetch).mockResolvedValueOnce(saved(result));
    render(<Page />);
    const region = await screen.findByRole("region", { name: "当前话术原文" });
    expect(region.textContent).toBe(`“${result.scripts[available].script}”`);
    expect(screen.getByText(/仅保存了部分版本/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /一键复制此话术/ }));
    await waitFor(() => expect(clipboard).toHaveBeenLastCalledWith(result.scripts[available].script));
    fireEvent.click(screen.getByRole("button", { name: "精炼说明版" }));
    expect(region.textContent).toContain("此版本未保存话术正文");
    const emptyCopy = screen.getByRole("button", { name: /一键复制此话术/ }) as HTMLButtonElement;
    expect(emptyCopy.disabled).toBe(true);
    fireEvent.click(emptyCopy);
    expect(clipboard).toHaveBeenCalledOnce();
    expect(screen.getByText(result.scripts.concise.keyPoints[0]!)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: available === "detailed" ? "详细说明版" : "岗位衔接版" }));
    expect(region.textContent).toBe(`“${result.scripts[available].script}”`);
    expect(result).toEqual(original);
    expect(jsonFetch).toHaveBeenCalledOnce();
  });

  it("三版切换和复制逐字保留原话、未知与隐私边界，不触发生成", async () => {
    const result = report();
    const before = structuredClone(result);
    vi.mocked(jsonFetch).mockResolvedValueOnce(saved(result));
    render(<Page />);
    await screen.findByRole("heading", { name: new RegExp(result.title) });
    expect(screen.getByText(/当前材料未支持明确关注点/)).toBeTruthy();
    expect(screen.getByText(/本次未识别具体表述风险/)).toBeTruthy();
    expect(screen.queryByText(/心理测谎仪|潜意识隐忧|把空白变成资产|打死不能说漏嘴|满分拆解|可直接背诵|听着舒适|连环追杀/)).toBeNull();
    for (const [name, key] of [["精炼说明版", "concise"], ["详细说明版", "detailed"], ["岗位衔接版", "pivoting"]] as const) {
      fireEvent.click(screen.getByRole("button", { name }));
      expect(screen.getByRole("button", { name }).getAttribute("aria-pressed")).toBe("true");
      expect(screen.getByRole("region", { name: "当前话术原文" }).textContent).toBe(`“${result.scripts[key].script}”`);
      fireEvent.click(screen.getByRole("button", { name: /一键复制此话术/ }));
      await waitFor(() => expect(clipboard).toHaveBeenLastCalledWith(result.scripts[key].script));
      await screen.findByRole("button", { name: /已复制整段话术/ });
    }
    fireEvent.click(screen.getByRole("button", { name: "复制" }));
    await waitFor(() => expect(clipboard).toHaveBeenLastCalledWith(result.drills[0]!.bestResponse));
    expect(screen.getByText(result.forbiddenList[0]!)).toBeTruthy();
    expect(screen.getByText(result.closingTips[0]!)).toBeTruthy();
    expect(jsonFetch).toHaveBeenCalledOnce();
    expect(result).toEqual(before);
  });

  it("没有具体禁忌时显示中性说明，不补造批评", async () => {
    const result = report();
    result.forbiddenList = [];
    vi.mocked(jsonFetch).mockResolvedValueOnce(saved(result));
    render(<Page />);
    expect(await screen.findByText("本次输出未列出需特别避免的表达。")).toBeTruthy();
    expect(screen.queryByText("切忌在面试中发泄对前司或前领导的负面情绪")).toBeNull();
  });

  it("复制失败有反馈，不沿用上次成功状态；重试成功后清除错误", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce(saved(report()));
    render(<Page />);
    fireEvent.click(await screen.findByRole("button", { name: /一键复制此话术/ }));
    const copied = await screen.findByRole("button", { name: /已复制整段话术/ });
    clipboard.mockRejectedValueOnce(new Error("denied"));
    fireEvent.click(copied);
    expect((await screen.findByRole("alert")).textContent).toContain("复制失败");
    expect(screen.queryByRole("button", { name: /已复制整段话术/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /一键复制此话术/ }));
    await screen.findByRole("button", { name: /已复制整段话术/ });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(clipboard).toHaveBeenCalledTimes(3);
  });

  it("损坏报告仍保留原始经历与恢复入口，不造一份默认话术", async () => {
    const record = saved(null);
    vi.mocked(jsonFetch).mockResolvedValueOnce(record);
    render(<Page />);
    await screen.findByText(/该报告内容无法解析/);
    fireEvent.click(screen.getByText("查看您输入的原始经历与痛点"));
    expect(screen.getByText(record.raw_story)).toBeTruthy();
    expect(screen.getByRole("link", { name: "返回重试" }).getAttribute("href")).toBe("/tools/gap");
    expect(screen.queryByRole("button", { name: /一键复制此话术/ })).toBeNull();
    expect(jsonFetch).toHaveBeenCalledOnce();
  });
});

describe("空窗详情的身份、删除核对与旧响应隔离", () => {
  it.each(["exists", "missing", "unreadable", "mismatched"])("408 删除超时后只读核对 %s，不能凭超时认定未删除", async mode => {
    const read = Promise.withResolvers<unknown>();
    vi.mocked(jsonFetch).mockResolvedValueOnce(saved(report())).mockRejectedValueOnce(new HttpError("等待删除超时", 408)).mockReturnValueOnce(read.promise);
    render(<Page />); fireEvent.click(await screen.findByRole("button", { name: "删除报告" }));
    await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(3));
    for (const name of ["删除报告", "删除本份报告"]) expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    expect(navigation.push).not.toHaveBeenCalled();
    expect(jsonFetch).toHaveBeenLastCalledWith("/api/tools/career-gap-remedies/1", expect.objectContaining({ cache: "no-store" }));
    await act(async () => {
      if (mode === "missing") read.reject(new HttpError("已不存在", 404));
      else if (mode === "unreadable") read.reject(new Error("状态读取失败"));
      else read.resolve({ ...saved(report()), id: mode === "mismatched" ? 2 : 1 });
    });
    if (mode === "missing") expect(navigation.push).toHaveBeenCalledExactlyOnceWith("/tools/gap");
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

  it("未知历史场景与风格保留原值，不被默认成综合场景和稳健人设", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ...saved(report()), scenario_type: "旧自定义场景", persona_style: "旧自定义表达" });
    render(<Page />); await screen.findByText("报告 #1");
    expect(screen.getByText("旧自定义场景")).toBeTruthy(); expect(screen.getByText("旧自定义表达")).toBeTruthy();
    expect(screen.queryByText("离职原因与空窗期结合")).toBeNull(); expect(screen.queryByText("务实稳健型")).toBeNull();
  });

  it.each([null, [], { ...saved(null), result: {} }].map(value => [value]))("拒绝根结构或报告损坏 %j，不在渲染时崩溃", async value => {
    vi.mocked(jsonFetch).mockResolvedValueOnce(value); render(<Page />);
    expect((await screen.findByRole("alert")).textContent).toContain("报告响应不完整或记录不符");
    expect(screen.queryByText("报告 #1")).toBeNull();
  });

  it.each(["success", "failure"])("旧初始读取 %s 迟到不能覆盖新报告", async (mode) => {
    const pending = Promise.withResolvers<unknown>();
    vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ ...saved(null), id: 2 });
    const view = render(<Page />); const signal = vi.mocked(jsonFetch).mock.calls[0]![1]!.signal;
    navigation.id = "2"; view.rerender(<Page />); await screen.findByText("报告 #2");
    await act(async () => { if (mode === "success") pending.resolve(saved(report())); else pending.reject(new Error("旧读取失败")); });
    expect(signal?.aborted).toBe(true); expect(screen.queryByText("报告 #1")).toBeNull(); expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each(["success", "failure"])("旧删除核对 %s 迟到不能导航或把旧正文写回新报告", async mode => {
    const pending = Promise.withResolvers<unknown>();
    vi.mocked(jsonFetch).mockResolvedValueOnce(saved(report())).mockResolvedValueOnce({ ok: false }).mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ ...saved(null), id: 2 });
    const view = render(<Page />); fireEvent.click(await screen.findByRole("button", { name: "删除报告" }));
    await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(3)); const signal = vi.mocked(jsonFetch).mock.calls[2]![1]!.signal;
    navigation.id = "2"; view.rerender(<Page />); await screen.findByText("报告 #2");
    await act(async () => { if (mode === "success") pending.resolve(saved(report())); else pending.reject(new HttpError("旧记录不存在", 404)); });
    expect(signal?.aborted).toBe(true); expect(navigation.push).not.toHaveBeenCalled(); expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("报告 #1")).toBeNull(); expect(jsonFetch).toHaveBeenCalledTimes(4);
  });

  it("重新核对同一事件也只读一次，期间两个删除入口继续锁定", async () => {
    const pending = Promise.withResolvers<unknown>();
    vi.mocked(jsonFetch).mockResolvedValueOnce(saved(report())).mockResolvedValueOnce({ ok: false })
      .mockRejectedValueOnce(new Error("初次核对失败")).mockReturnValueOnce(pending.promise);
    render(<Page />); fireEvent.click(await screen.findByRole("button", { name: "删除报告" }));
    const retry = await screen.findByRole("button", { name: "重新读取删除状态" });
    act(() => { fireEvent.click(retry); fireEvent.click(retry); fireEvent.click(screen.getByRole("button", { name: "删除本份报告" })); });
    expect(jsonFetch).toHaveBeenCalledTimes(4);
    await act(async () => { pending.resolve(saved(null)); });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("记录目前仍存在"));
    expect((screen.getByRole("button", { name: "删除报告" }) as HTMLButtonElement).disabled).toBe(false);
    expect(confirmDialog).toHaveBeenCalledOnce(); expect(navigation.push).not.toHaveBeenCalled();
  });

  it("切换记录立即移除旧报告，新读取失败只能重试当前记录", async () => {
    const next = Promise.withResolvers<unknown>();
    vi.mocked(jsonFetch).mockResolvedValueOnce(saved(report())).mockReturnValueOnce(next.promise).mockResolvedValueOnce({ ...saved(null), id: 2 });
    const view = render(<Page />); await screen.findByText("报告 #1");
    navigation.id = "2"; view.rerender(<Page />);
    expect(screen.queryByText("报告 #1")).toBeNull(); expect(screen.queryByRole("button", { name: "删除报告" })).toBeNull();
    await act(async () => { next.reject(new Error("第二份读取失败")); });
    expect(screen.getByRole("alert").textContent).toContain("第二份读取失败");
    fireEvent.click(screen.getByRole("button", { name: "重试加载" })); await screen.findByText("报告 #2");
    expect(jsonFetch).toHaveBeenLastCalledWith("/api/tools/career-gap-remedies/2", expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) }));
  });

  it.each([{ id: 2 }, { id: 1.5 }, { raw_story: null }, { target_role: null }, { scenario_type: null }, { persona_style: null }, { created_at: null }])("拒绝串记录或损坏的身份材料 %#，不开放删除或展示原稿", async (changes) => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ...saved(null), ...changes }); render(<Page />);
    expect((await screen.findByRole("alert")).textContent).toContain("报告响应不完整或记录不符");
    expect(screen.queryByRole("button", { name: "删除报告" })).toBeNull(); expect(screen.queryByText("查看您输入的原始经历与痛点")).toBeNull();
  });

  it("两个删除入口从确认开始共享同步锁，取消不发请求", async () => {
    const pending = Promise.withResolvers<boolean>(); vi.mocked(confirmDialog).mockReturnValueOnce(pending.promise);
    vi.mocked(jsonFetch).mockResolvedValueOnce(saved(report())); render(<Page />); await screen.findByText("报告 #1");
    act(() => { fireEvent.click(screen.getByRole("button", { name: "删除报告" })); fireEvent.click(screen.getByRole("button", { name: "删除本份报告" })); });
    expect(confirmDialog).toHaveBeenCalledOnce();
    expect(vi.mocked(confirmDialog).mock.calls[0]![0].message).toContain("#1");
    // 确认期间保留触发焦点；同步命令锁拦截两个入口的重复点击。
    for (const name of ["删除报告", "删除本份报告"]) fireEvent.click(screen.getByRole("button", { name }));
    expect(confirmDialog).toHaveBeenCalledOnce(); expect(jsonFetch).toHaveBeenCalledOnce();
    await act(async () => { pending.resolve(false); });
    expect(jsonFetch).toHaveBeenCalledOnce(); expect(navigation.push).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "删除报告" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("删除坏响应先只读核对，连续失败和串记录保留锁；404 确认后仅导航一次", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce(saved(report())).mockResolvedValueOnce({ ok: false })
      .mockRejectedValueOnce(new HttpError("暂不可用", 503)).mockResolvedValueOnce({ ...saved(null), id: 2 })
      .mockRejectedValueOnce(new HttpError("不存在", 404));
    render(<Page />); fireEvent.click(await screen.findByRole("button", { name: "删除报告" }));
    expect((await screen.findByRole("alert")).textContent).toContain("删除结果尚未确认");
    expect(navigation.push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "重新读取删除状态" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("记录不符"));
    expect((screen.getByRole("button", { name: "删除报告" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "重新读取删除状态" }));
    await waitFor(() => expect(navigation.push).toHaveBeenCalledExactlyOnceWith("/tools/gap"));
    fireEvent.click(screen.getByRole("button", { name: "删除报告" })); expect(navigation.push).toHaveBeenCalledOnce();
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "DELETE")).toHaveLength(1);
    for (const [, init] of vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method !== "DELETE")) expect(init?.cache).toBe("no-store");
  });

  it("核对仍存在时展示新原稿并保留错误，用户重新确认才再次 DELETE", async () => {
    const updated = { ...saved(report()), raw_story: "核对时读到的新原稿 <T> &amp;" };
    vi.mocked(jsonFetch).mockResolvedValueOnce(saved(report())).mockRejectedValueOnce(new Error("删除响应丢失"))
      .mockResolvedValueOnce(updated).mockResolvedValueOnce({ ok: true });
    render(<Page />); fireEvent.click(await screen.findByRole("button", { name: "删除报告" }));
    expect((await screen.findByRole("alert")).textContent).toContain("记录目前仍存在");
    expect(screen.getByRole("region", { name: "原始经历", hidden: true }).textContent).toBe(updated.raw_story);
    expect(navigation.push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "删除本份报告" }));
    await waitFor(() => expect(navigation.push).toHaveBeenCalledExactlyOnceWith("/tools/gap")); expect(confirmDialog).toHaveBeenCalledTimes(2);
  });

  it("旧报告的确认框晚到不能操作新报告", async () => {
    const confirmation = Promise.withResolvers<boolean>(); vi.mocked(confirmDialog).mockReturnValueOnce(confirmation.promise);
    vi.mocked(jsonFetch).mockResolvedValueOnce(saved(report())).mockResolvedValueOnce({ ...saved(null), id: 2 });
    const view = render(<Page />); fireEvent.click(await screen.findByRole("button", { name: "删除报告" }));
    navigation.id = "2"; view.rerender(<Page />); await screen.findByText("报告 #2");
    await act(async () => { confirmation.resolve(true); });
    expect(jsonFetch).toHaveBeenCalledTimes(2); expect(navigation.push).not.toHaveBeenCalled();
  });

  it.each(["success", "failure"])("旧删除 %s 晚到不能导航或影响新报告", async (mode) => {
    const pending = Promise.withResolvers<unknown>();
    vi.mocked(jsonFetch).mockResolvedValueOnce(saved(report())).mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ ...saved(null), id: 2 });
    const view = render(<Page />); fireEvent.click(await screen.findByRole("button", { name: "删除报告" }));
    await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(2));
    const signal = vi.mocked(jsonFetch).mock.calls[1]![1]!.signal;
    navigation.id = "2"; view.rerender(<Page />); await screen.findByText("报告 #2");
    await act(async () => { if (mode === "success") pending.resolve({ ok: true }); else pending.reject(new Error("旧删除失败")); });
    expect(signal?.aborted).toBe(true); expect(navigation.push).not.toHaveBeenCalled(); expect(screen.queryByRole("alert")).toBeNull();
    expect(jsonFetch).toHaveBeenCalledTimes(3);
  });

  it.each(["success", "failure"])("同文话术的旧复制 %s 不显示在新报告", async (mode) => {
    const pending = Promise.withResolvers<void>(); clipboard.mockReturnValueOnce(pending.promise);
    vi.mocked(jsonFetch).mockResolvedValueOnce(saved(report())).mockResolvedValueOnce({ ...saved(report()), id: 2 });
    const view = render(<Page />); fireEvent.click(await screen.findByRole("button", { name: /一键复制此话术/ }));
    navigation.id = "2"; view.rerender(<Page />); await screen.findByText("报告 #2");
    await act(async () => { if (mode === "success") pending.resolve(); else pending.reject(new Error("denied")); });
    expect(screen.queryByRole("button", { name: /已复制整段话术/ })).toBeNull(); expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("button", { name: /一键复制此话术/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});
