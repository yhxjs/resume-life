// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import { fetchSse, type SseOptions } from "@/lib/fetch-sse";
import { normalizeSummary } from "@/lib/summary";
import { compareProjectSummaries } from "@/lib/project-summary-diff";
import { ProjectMaterialsPanel } from "../project-materials-panel";
import { ProjectSummaryWorkbench } from "../project-summary-workbench";
import { ProjectSummaryReview } from "../project-summary-review";
import { useProjectDetail, type Material, type SummaryProposal } from "../use-project-detail";

vi.mock("@/lib/fetcher", async importOriginal => ({ ...await importOriginal<object>(), jsonFetch: vi.fn() }));
vi.mock("@/lib/fetch-sse", () => ({ fetchSse: vi.fn() }));
vi.mock("../directory-picker-dialog", () => ({ DirectoryPickerDialog: () => null }));
vi.mock("@/components/common/confirm-dialog", () => ({ alertDialog: vi.fn().mockResolvedValue(undefined), confirmDialog: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const a: Material = { id: 11, title: "材料 A", source: "text", filename: "", created_at: "" };
const b: Material = { ...a, id: 22, title: "材料 B" };
const loadedA: Material = { ...a, content: "A 正文", revision: "a".repeat(64) };
const loadedB: Material = { ...b, content: "B 正文", revision: "b".repeat(64) };
const project = { id: 1, name: "项目", summary: normalizeSummary({}), summary_updated_at: "", materials: [a, b] };

beforeEach(() => {
  vi.mocked(jsonFetch).mockReset().mockResolvedValue(project);
  vi.mocked(fetchSse).mockReset();
});
afterEach(cleanup);

async function setup() {
  const hook = renderHook(() => useProjectDetail("1"));
  await waitFor(() => expect(hook.result.current.data?.id).toBe(1));
  return hook;
}

describe("项目首次生成的手动内容保护", () => {
  it.each([
    { mode: "full" as const, moment: "before" }, { mode: "full" as const, moment: "during" },
    { mode: "resume-only" as const, moment: "before" }, { mode: "resume-only" as const, moment: "during" },
  ])("$mode 生成 $moment 手动补充后只预选未编辑字段，可单独采纳和撤销", async ({ mode, moment }) => {
    const hook = await setup();
    const generated = { ...project.summary, overview: mode === "full" ? "AI 概述" : "", techStack: "TypeScript", brief: "AI 项目介绍", achievements: ["AI 整理的成果"] };
    function edit() {
      hook.result.current.summary.updateSummaryField("overview", "本人确认的职责边界，尚未上线");
      hook.result.current.summary.updateSummaryField("brief", "本人补充的项目介绍");
      hook.result.current.summary.updateSummaryField("achievements", ["本人核实的成果，未统计收益"]);
    }
    if (moment === "before") act(edit);
    const streaming = deferred<void>();
    let callbacks!: SseOptions<Partial<SummaryProposal>>;
    vi.mocked(fetchSse).mockImplementation((_url, options) => {
      callbacks = options as SseOptions<Partial<SummaryProposal>>;
      return streaming.promise;
    });
    let generating!: Promise<void>;
    act(() => { generating = hook.result.current.summary.summarize(mode); });
    if (moment === "during") act(edit);
    await act(async () => {
      await callbacks.onDone?.({
        summary: generated, comparison: compareProjectSummaries(project.summary, generated, {}),
        materialChanges: [], materialFingerprint: "d".repeat(64), revisionId: 0,
      });
      streaming.resolve();
      await generating;
    });
    const expected = { ...project.summary, overview: "本人确认的职责边界，尚未上线", brief: "本人补充的项目介绍", techStack: "TypeScript", achievements: ["本人核实的成果，未统计收益"] };
    expect(hook.result.current.summary.summaryDraft).toEqual(expected);
    expect(hook.result.current.summary.selectedKeys).toEqual(["techStack"]);
    expect(hook.result.current.summary.proposal).toMatchObject({ summary: generated, materialFingerprint: "d".repeat(64), revisionId: 0 });
    expect(hook.result.current.summary.proposal?.comparison).toContainEqual(expect.objectContaining({ key: "brief", previous: expected.brief, next: generated.brief, status: "conflict" }));
    expect(jsonFetch).toHaveBeenCalledTimes(1);
    act(() => hook.result.current.summary.toggleAdoption("brief"));
    expect(hook.result.current.summary.summaryDraft?.brief).toBe(generated.brief);
    act(() => hook.result.current.summary.toggleAdoption("brief"));
    expect(hook.result.current.summary.summaryDraft?.brief).toBe(expected.brief);
    await act(async () => { await hook.result.current.summary.saveSummary(); });
    const patch = vi.mocked(jsonFetch).mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(JSON.parse(patch![1]!.body as string)).toMatchObject({
      summary: expected, expectedRevisionId: 0,
      proposal: { generated, acceptedKeys: ["techStack"], materialFingerprint: "d".repeat(64) },
    });
  });

  it("手动清空的文本和成果不会被首次生成自动填回", async () => {
    const hook = await setup();
    act(() => {
      hook.result.current.summary.updateSummaryField("brief", "待删除的介绍");
      hook.result.current.summary.updateSummaryField("achievements", ["待删除的成果"]);
    });
    act(() => {
      hook.result.current.summary.updateSummaryField("brief", "");
      hook.result.current.summary.removeAchievementItem(0);
    });
    const generated = { ...project.summary, techStack: "TypeScript", brief: "模型想填回的介绍", achievements: ["模型想填回的成果"] };
    act(() => hook.result.current.summary.applyDraft({
      summary: generated, comparison: compareProjectSummaries(project.summary, generated, {}),
      materialChanges: [], materialFingerprint: "e".repeat(64), revisionId: 0, source: "ai",
    }));
    expect(hook.result.current.summary.summaryDraft).toEqual({ ...project.summary, techStack: "TypeScript" });
    expect(hook.result.current.summary.selectedKeys).toEqual(["techStack"]);
  });

  it.each(["edit", "add", "remove"] as const)("首次扫描回调晚到时，保留手动 %s 后的整份成果列表", async (action) => {
    const hook = await setup();
    const receive = hook.result.current.summary.applyDraft;
    act(() => hook.result.current.summary.updateSummaryField("achievements", ["个人确认的成果一", "个人确认的成果二"]));
    act(() => {
      if (action === "edit") hook.result.current.summary.updateAchievementItem(0, "校正后的成果一，尚未上线");
      else if (action === "add") hook.result.current.summary.addAchievementItem();
      else hook.result.current.summary.removeAchievementItem(0);
    });
    const expected = hook.result.current.summary.summaryDraft?.achievements;
    const generated = { ...project.summary, techStack: "TypeScript", achievements: ["扫描草稿成果一", "扫描草稿成果二", "扫描草稿成果三"] };
    act(() => receive({
      summary: generated, comparison: compareProjectSummaries(project.summary, generated, {}),
      materialChanges: [], materialFingerprint: "f".repeat(64), revisionId: 0, source: "repo",
    }, "扫描草稿待核对"));
    expect(hook.result.current.summary.summaryDraft?.achievements).toEqual(expected);
    expect(hook.result.current.summary.selectedKeys).toEqual(["techStack"]);
    expect(hook.result.current.summary.pendingDraft).toBe(true);
  });

  it("没有手动编辑时首次生成继续预选全部差异", async () => {
    const hook = await setup();
    const generated = { ...project.summary, overview: "项目概述", brief: "项目介绍", achievements: ["有依据的成果"] };
    const comparison = compareProjectSummaries(project.summary, generated, {});
    act(() => hook.result.current.summary.applyDraft({
      summary: generated, comparison, materialChanges: [], materialFingerprint: "a".repeat(64), revisionId: 0, source: "ai",
    }));
    expect(hook.result.current.summary.summaryDraft).toEqual(generated);
    expect(hook.result.current.summary.selectedKeys).toEqual(comparison.map((change) => change.key));
    expect(hook.result.current.summary.pendingDraft).toBe(true);
  });
});

describe("项目总结保存结果的归属", () => {
  it("页面显示已保存与刷新失败，重试按钮只读取详情且不覆盖新编辑", async () => {
    function SummarySaveView() {
      const { summary } = useProjectDetail("1");
      return <ProjectSummaryWorkbench {...summary} materialCount={1}
        onSummarize={summary.summarize} onDiscardDraft={summary.discardDraft} onSaveSummary={summary.saveSummary}
        onChange={summary.updateSummaryField} onUpdateAchievement={summary.updateAchievementItem}
        onAddAchievement={summary.addAchievementItem} onRemoveAchievement={summary.removeAchievementItem}
        onToggleAdoption={summary.toggleAdoption} onRefreshSummary={summary.refreshSummary} />;
    }
    render(<SummarySaveView />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "项目概述" })).toBeTruthy());
    fireEvent.change(screen.getByRole("textbox", { name: "项目概述" }), { target: { value: "已核实的项目概述" } });
    const confirmed = { ...project.summary, overview: "已核实的项目概述" };
    const reading = deferred<typeof project>();
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ok: true, revisionId: 21, summary: confirmed, summary_updated_at: "2026-10-25" })
      .mockRejectedValueOnce(new Error("详情读取失败")).mockReturnValueOnce(reading.promise);
    fireEvent.click(screen.getByRole("button", { name: "保存总结修改" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("总结已保存，详情刷新失败：详情读取失败"));
    expect(screen.getByText("总结已保存")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试刷新" }));
    expect((screen.getByRole("button", { name: "正在刷新…" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: /技术栈（核心语言/ }), { target: { value: "刷新期间补充的技术栈" } });
    await act(async () => { reading.resolve({ ...project, summary: confirmed, summary_updated_at: "2026-10-25" }); });
    expect(screen.queryByRole("alert")).toBeNull();
    expect((screen.getByRole("textbox", { name: /技术栈（核心语言/ }) as HTMLInputElement).value).toBe("刷新期间补充的技术栈");
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
    expect(jsonFetch).toHaveBeenCalledTimes(4);
  });

  it("新保存刷新优先于旧重试读取，旧错误不清除新刷新状态", async () => {
    const hook = await setup();
    const confirmed = { ...project.summary, overview: "第一次保存内容" };
    act(() => hook.result.current.summary.updateSummaryField("overview", confirmed.overview));
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ok: true, revisionId: 21, summary: confirmed, summary_updated_at: "2026-10-25" })
      .mockRejectedValueOnce(new Error("第一次刷新失败"));
    await act(async () => { await hook.result.current.summary.saveSummary(); });
    const oldRead = deferred<typeof project>();
    vi.mocked(jsonFetch).mockReturnValueOnce(oldRead.promise);
    let retrying!: Promise<void>;
    act(() => { retrying = hook.result.current.summary.refreshSummary(); });
    act(() => hook.result.current.summary.updateSummaryField("brief", "第二次编辑的介绍"));
    const next = { ...confirmed, brief: "第二次编辑的介绍" };
    const newRead = deferred<typeof project>();
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ok: true, revisionId: 22, summary: next, summary_updated_at: "2026-10-25" })
      .mockReturnValueOnce(newRead.promise);
    let saving!: Promise<void>;
    act(() => { saving = hook.result.current.summary.saveSummary(); });
    await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(6));
    await act(async () => { oldRead.reject(new Error("旧重试读取失败")); await retrying; });
    expect(hook.result.current.summary.refreshingSummary).toBe(true);
    expect(hook.result.current.summary.refreshError).toBe("");
    expect(hook.result.current.data?.summary_revision_id).toBe(22);
    await act(async () => { newRead.resolve({ ...project, summary: next, summary_updated_at: "2026-10-25" }); await saving; });
    expect(hook.result.current.summary.refreshingSummary).toBe(false);
    expect(hook.result.current.summary.refreshError).toBe("");
    expect(hook.result.current.summary.summaryDraft).toEqual(next);
    expect(hook.result.current.summary.sumStatus?.kind).toBe("ok");
  });

  it("保存成功但详情刷新失败时保留确认内容与新版本，不报保存失败，后续保存使用新版本", async () => {
    const hook = await setup();
    const draft = { ...project.summary, overview: "已核实的项目概述", achievements: ["  已核实的成果  ", " "] };
    act(() => {
      hook.result.current.summary.updateSummaryField("overview", draft.overview);
      hook.result.current.summary.updateSummaryField("achievements", draft.achievements);
    });
    const confirmed = normalizeSummary(draft);
    const updatedAt = "2026-10-25T00:00:00.000Z";
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ok: true, revisionId: 21, summary: confirmed, summary_updated_at: updatedAt })
      .mockRejectedValueOnce(new Error("详情暂不可用"));
    await act(async () => { await hook.result.current.summary.saveSummary(); });
    expect(hook.result.current.summary.sumStatus).toEqual({ kind: "ok", text: "总结已保存" });
    expect(hook.result.current.summary.summaryDraft).toEqual(confirmed);
    expect(hook.result.current.summary.pendingDraft).toBe(false);
    expect(hook.result.current.data).toMatchObject({ summary: confirmed, summary_revision_id: 21, summary_updated_at: updatedAt, materials: project.materials });
    expect(hook.result.current.summary.refreshError).toBe("详情暂不可用");
    act(() => hook.result.current.summary.updateSummaryField("brief", "确认后的新编辑"));
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ok: true, revisionId: 22, summary: { ...confirmed, brief: "确认后的新编辑" }, summary_updated_at: updatedAt })
      .mockRejectedValueOnce(new Error("详情仍不可用"));
    await act(async () => { await hook.result.current.summary.saveSummary(); });
    const writes = vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "PATCH");
    expect(JSON.parse(writes[1]![1]!.body as string).expectedRevisionId).toBe(21);
    expect(hook.result.current.data?.summary_revision_id).toBe(22);
  });

  it("只重试详情读取，保留刷新期间的新草稿与采纳选择，不再次写入", async () => {
    const hook = await setup();
    const confirmed = { ...project.summary, overview: "已保存的总结" };
    act(() => hook.result.current.summary.updateSummaryField("overview", confirmed.overview));
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ok: true, revisionId: 21, summary: confirmed, summary_updated_at: "2026-10-25" })
      .mockRejectedValueOnce(new Error("详情读取失败"));
    await act(async () => { await hook.result.current.summary.saveSummary(); });
    const generated = { ...confirmed, brief: "新的 AI 草稿" };
    act(() => hook.result.current.summary.applyDraft({
      summary: generated, comparison: compareProjectSummaries(confirmed, generated, {}),
      materialChanges: [], materialFingerprint: "f".repeat(64), revisionId: 21, source: "repo",
    }, "新草稿仍待确认"));
    act(() => hook.result.current.summary.toggleAdoption("brief"));
    const reading = deferred<typeof project>();
    vi.mocked(jsonFetch).mockReturnValueOnce(reading.promise);
    let refreshing!: Promise<void>;
    act(() => {
      refreshing = hook.result.current.summary.refreshSummary();
      void hook.result.current.summary.refreshSummary();
    });
    expect(hook.result.current.summary.refreshingSummary).toBe(true);
    act(() => hook.result.current.summary.updateSummaryField("techStack", "手动补充的技术栈"));
    await act(async () => {
      reading.resolve({ ...project, summary: confirmed, summary_updated_at: "2026-10-25" });
      await refreshing;
    });
    expect(hook.result.current.summary.refreshError).toBe("");
    expect(hook.result.current.summary.refreshingSummary).toBe(false);
    expect(hook.result.current.summary.summaryDraft).toEqual({ ...generated, techStack: "手动补充的技术栈" });
    expect(hook.result.current.summary.proposal?.revisionId).toBe(21);
    expect(hook.result.current.summary.selectedKeys).toEqual(["brief"]);
    expect(hook.result.current.summary.sumStatus).toEqual({ kind: "warn", text: "新草稿仍待确认" });
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
    expect(jsonFetch).toHaveBeenCalledTimes(4);
  });

  it("保存后的读取失败不覆盖等待期间交付的新草稿或改变其生成依据", async () => {
    const hook = await setup();
    const reading = deferred<typeof project>();
    const confirmed = { ...project.summary, overview: "已确认写入的总结" };
    act(() => hook.result.current.summary.updateSummaryField("overview", confirmed.overview));
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ok: true, revisionId: 21, summary: confirmed, summary_updated_at: "2026-10-25" })
      .mockReturnValueOnce(reading.promise);
    let saving!: Promise<void>;
    act(() => { saving = hook.result.current.summary.saveSummary(); });
    await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(3));
    const generated = { ...project.summary, brief: "等待刷新时交付的新草稿" };
    act(() => hook.result.current.summary.applyDraft({
      summary: generated, comparison: compareProjectSummaries(project.summary, generated, {}),
      materialChanges: [], materialFingerprint: "f".repeat(64), revisionId: 0, source: "repo",
    }, "新扫描草稿待确认"));
    await act(async () => { reading.reject(new Error("读取失败")); await saving; });
    expect(hook.result.current.summary.proposal).toMatchObject({ summary: generated, revisionId: 0, materialFingerprint: "f".repeat(64) });
    expect(hook.result.current.summary.pendingDraft).toBe(true);
    expect(hook.result.current.summary.sumStatus).toEqual({ kind: "warn", text: "新扫描草稿待确认" });
    expect(hook.result.current.summary.refreshError).toBe("读取失败");
  });

  it.each(["edit", "add", "remove", "discard"] as const)("旧保存完成后保留等待期间的 %s 操作", async (action) => {
    const hook = await setup();
    const generated = { ...project.summary, overview: "AI 项目概述", achievements: ["成果一", "成果二"] };
    act(() => hook.result.current.summary.applyDraft({
      summary: generated, comparison: compareProjectSummaries(project.summary, generated, {}),
      materialChanges: [], materialFingerprint: "a".repeat(64), revisionId: 0, source: "ai",
    }));
    const request = deferred<unknown>();
    vi.mocked(jsonFetch).mockReturnValueOnce(request.promise).mockResolvedValueOnce({ ...project, summary: generated, summary_revision_id: 1 });
    let saving!: Promise<void>;
    act(() => { saving = hook.result.current.summary.saveSummary(); });
    act(() => {
      if (action === "edit") hook.result.current.summary.updateAchievementItem(1, "手动核实的成果，尚未上线");
      else if (action === "add") hook.result.current.summary.addAchievementItem();
      else if (action === "remove") hook.result.current.summary.removeAchievementItem(0);
      else hook.result.current.summary.discardDraft();
    });
    const expected = hook.result.current.summary;
    await act(async () => { request.resolve({ revisionId: 1, summary: generated }); await saving; });
    expect(hook.result.current.summary.summaryDraft).toEqual(expected.summaryDraft);
    expect(hook.result.current.summary.proposal).toEqual(expected.proposal ? { ...expected.proposal, revisionId: 1 } : null);
    expect(hook.result.current.summary.selectedKeys).toEqual(expected.selectedKeys);
    expect(hook.result.current.summary.pendingDraft).toBe(expected.pendingDraft);
    expect(hook.result.current.summary.sumStatus).toEqual(expected.sumStatus);
    expect(hook.result.current.data?.summary).toEqual(generated);
  });

  it.each(["success", "failure"] as const)("没有后续操作时保存 %s 正常反馈，完成后可以再次保存", async (outcome) => {
    const hook = await setup();
    const generated = { ...project.summary, overview: "待确认的项目概述" };
    act(() => hook.result.current.summary.applyDraft({
      summary: generated, comparison: compareProjectSummaries(project.summary, generated, {}),
      materialChanges: [], materialFingerprint: "a".repeat(64), revisionId: 0, source: "ai",
    }));
    if (outcome === "success") vi.mocked(jsonFetch).mockResolvedValueOnce({ revisionId: 1, summary: generated })
      .mockResolvedValueOnce({ ...project, summary: generated, summary_revision_id: 1 });
    else vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("保存失败后可重试", 400));
    await act(async () => { await hook.result.current.summary.saveSummary(); });
    expect(hook.result.current.summary.savingSummary).toBe(false);
    expect(hook.result.current.summary.summaryDraft).toEqual(generated);
    expect(hook.result.current.summary.pendingDraft).toBe(outcome === "failure");
    expect(hook.result.current.summary.sumStatus).toEqual(outcome === "success"
      ? { kind: "ok", text: "草稿已确认，总结已写入项目档案" }
      : { kind: "err", text: "保存失败：保存失败后可重试" });
    vi.mocked(jsonFetch).mockResolvedValueOnce({ revisionId: 2, summary: generated })
      .mockResolvedValueOnce({ ...project, summary: generated, summary_revision_id: 2 });
    await act(async () => { await hook.result.current.summary.saveSummary(); });
    expect(hook.result.current.summary.savingSummary).toBe(false);
    expect(hook.result.current.summary.pendingDraft).toBe(false);
    expect(hook.result.current.summary.sumStatus?.kind).toBe("ok");
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(2);
  });

  it.each(["success", "failure"] as const)("旧保存 %s 后保留新草稿的待确认状态、采纳选择和提示", async (outcome) => {
    const hook = await setup();
    const first = { ...project.summary, overview: "本次保存的旧草稿" };
    act(() => hook.result.current.summary.applyDraft({
      summary: first, comparison: compareProjectSummaries(project.summary, first, {}),
      materialChanges: [], materialFingerprint: "a".repeat(64), revisionId: 0, source: "ai",
    }));
    const request = deferred<unknown>();
    vi.mocked(jsonFetch).mockReturnValueOnce(request.promise).mockResolvedValueOnce({ ...project, summary: first, summary_revision_id: 1 });
    let saving!: Promise<void>;
    act(() => { saving = hook.result.current.summary.saveSummary(); });
    const next = { ...project.summary, overview: "后续扫描交付的新草稿，尚未确认" };
    act(() => hook.result.current.summary.applyDraft({
      summary: next, comparison: compareProjectSummaries(project.summary, next, {}),
      materialChanges: [], materialFingerprint: "b".repeat(64), revisionId: 0, source: "repo",
    }, "新的扫描草稿待核对"));
    await act(async () => {
      if (outcome === "success") request.resolve({ revisionId: 1, summary: first });
      else request.reject(new Error("旧保存失败"));
      await saving;
    });
    expect(hook.result.current.summary.summaryDraft).toEqual(next);
    expect(hook.result.current.summary.proposal).toMatchObject({ summary: next, source: "repo", materialFingerprint: "b".repeat(64) });
    expect(hook.result.current.summary.pendingDraft).toBe(true);
    expect(hook.result.current.summary.selectedKeys).toEqual(["overview"]);
    expect(hook.result.current.summary.sumStatus).toEqual({ kind: "warn", text: "新的扫描草稿待核对" });
    expect(hook.result.current.summary.savingSummary).toBe(false);
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
  });

  it.each(["success", "failure"] as const)("旧保存 %s 不替换新一轮生成中的提示，生成结束后正常交付草稿", async (outcome) => {
    const hook = await setup();
    act(() => hook.result.current.summary.updateSummaryField("overview", "已提交保存的手动内容"));
    const request = deferred<unknown>();
    vi.mocked(jsonFetch).mockReturnValueOnce(request.promise).mockResolvedValueOnce(project);
    let saving!: Promise<void>;
    act(() => { saving = hook.result.current.summary.saveSummary(); });
    const streaming = deferred<void>();
    let callbacks!: SseOptions<Partial<SummaryProposal>>;
    vi.mocked(fetchSse).mockImplementation((_url, options) => {
      callbacks = options as SseOptions<Partial<SummaryProposal>>;
      return streaming.promise;
    });
    let generating!: Promise<void>;
    act(() => { generating = hook.result.current.summary.summarize(); });
    const status = hook.result.current.summary.sumStatus;
    await act(async () => {
      if (outcome === "success") request.resolve({ revisionId: 1, summary: { ...project.summary, overview: "已提交保存的手动内容" } });
      else request.reject(new Error("旧保存失败"));
      await saving;
    });
    expect(hook.result.current.summary.summarizing).toBe(true);
    expect(hook.result.current.summary.sumStatus).toEqual(status);
    const generated = { ...project.summary, overview: "新一轮生成的内容" };
    await act(async () => {
      await callbacks.onDone?.({
        summary: generated, comparison: compareProjectSummaries(project.summary, generated, {}),
        materialChanges: [], materialFingerprint: "c".repeat(64), revisionId: 1,
      });
      streaming.resolve();
      await generating;
    });
    expect(hook.result.current.summary.pendingDraft).toBe(true);
    expect(hook.result.current.summary.proposal?.summary).toEqual(generated);
    expect(hook.result.current.summary.sumStatus?.kind).toBe("warn");
  });

  it("保存等待期间手动修改和撤销采纳后，不清除仍未保存的选择", async () => {
    const hook = await setup();
    const generated = { ...project.summary, overview: "AI 项目概述", brief: "AI 项目介绍" };
    act(() => hook.result.current.summary.applyDraft({
      summary: generated, comparison: compareProjectSummaries(project.summary, generated, {}),
      materialChanges: [], materialFingerprint: "a".repeat(64), revisionId: 0, source: "ai",
    }));
    const request = deferred<unknown>();
    vi.mocked(jsonFetch).mockReturnValueOnce(request.promise).mockResolvedValueOnce({ ...project, summary: generated, summary_revision_id: 1 });
    let saving!: Promise<void>;
    act(() => { saving = hook.result.current.summary.saveSummary(); });
    act(() => {
      hook.result.current.summary.toggleAdoption("overview");
      hook.result.current.summary.updateSummaryField("techStack", "手动核实后的技术栈");
    });
    await act(async () => { request.resolve({ revisionId: 1, summary: generated }); await saving; });
    expect(hook.result.current.summary.summaryDraft).toMatchObject({ overview: "", brief: "AI 项目介绍", techStack: "手动核实后的技术栈" });
    expect(hook.result.current.summary.selectedKeys).toEqual(["brief"]);
    expect(hook.result.current.summary.pendingDraft).toBe(true);
    expect(hook.result.current.summary.proposal?.summary).toEqual(generated);
  });

  it("同一轮保存的连续点击只提交一次", async () => {
    const hook = await setup();
    const request = deferred<unknown>();
    vi.mocked(jsonFetch).mockReturnValueOnce(request.promise).mockReturnValueOnce(request.promise).mockResolvedValue(project);
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = hook.result.current.summary.saveSummary();
      second = hook.result.current.summary.saveSummary();
    });
    await act(async () => { request.resolve({}); await Promise.all([first, second]); });
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
  });
});

describe("项目草稿成果编辑", () => {
  it("草稿已与部分生成内容一致时，只统计仍展示的采纳项", async () => {
    const hook = await setup();
    const generated = { ...project.summary, overview: "手动填写且与 AI 一致的项目概述", brief: "新的项目介绍" };
    act(() => hook.result.current.summary.updateSummaryField("overview", generated.overview));
    act(() => hook.result.current.summary.applyDraft({
      summary: generated, comparison: compareProjectSummaries(project.summary, generated, {}),
      materialChanges: [], materialFingerprint: "f".repeat(64), revisionId: 0, source: "ai",
    }));
    const { proposal, selectedKeys, toggleAdoption } = hook.result.current.summary;
    render(<ProjectSummaryReview proposal={proposal!} selectedKeys={selectedKeys} onToggleAdoption={toggleAdoption} />);
    expect(screen.getByText("已采纳 1 / 1 段")).toBeTruthy();
    expect(screen.queryByRole("group", { name: "项目概述" })).toBeNull();
  });

  it("差异面板展示手动编辑后的真实条目，再次采纳删除只移除该条目，撤销后可恢复", async () => {
    const original = { ...project.summary, achievements: ["原成果一", "原成果二", "原成果三", "原成果四"] };
    const generated = { ...original, achievements: ["新成果一", "新成果二"] };
    const proposal: SummaryProposal = {
      summary: generated, comparison: compareProjectSummaries(original, generated, {}),
      materialChanges: [], materialFingerprint: "f".repeat(64), revisionId: 8, source: "ai",
    };
    vi.mocked(jsonFetch).mockResolvedValue({ ...project, summary: original, summary_updated_at: "2026-10-25", summary_revision_id: 8 });
    function SummaryView() {
      const { summary } = useProjectDetail("1");
      return <>
        <button onClick={() => summary.applyDraft(proposal)}>载入 AI 草稿</button>
        <ProjectSummaryWorkbench {...summary} materialCount={1}
          onSummarize={summary.summarize} onDiscardDraft={summary.discardDraft} onSaveSummary={summary.saveSummary}
          onChange={summary.updateSummaryField} onUpdateAchievement={summary.updateAchievementItem}
          onAddAchievement={summary.addAchievementItem} onRemoveAchievement={summary.removeAchievementItem}
          onToggleAdoption={summary.toggleAdoption} />
      </>;
    }
    render(<SummaryView />);
    await waitFor(() => expect((screen.getByRole("textbox", { name: "项目成果4" }) as HTMLTextAreaElement).value).toBe("原成果四"));
    fireEvent.click(screen.getByRole("button", { name: "载入 AI 草稿" }));
    fireEvent.click(within(screen.getByRole("group", { name: "项目描述与成果 3" })).getByRole("button", { name: "采纳本段" }));
    fireEvent.change(screen.getByRole("textbox", { name: "项目成果2" }), { target: { value: "人工核实后的成果，尚未上线" } });
    const deletion = within(screen.getByRole("group", { name: "项目描述与成果 3" }));
    expect(deletion.getByText("当前草稿")).toBeTruthy();
    expect(deletion.getByText("原成果四")).toBeTruthy();
    expect(deletion.queryByText("原成果三")).toBeNull();
    expect(screen.queryByRole("group", { name: "项目描述与成果 4" })).toBeNull();
    fireEvent.click(deletion.getByRole("button", { name: "采纳本段" }));
    expect(screen.queryByRole("textbox", { name: "项目成果3" })).toBeNull();
    expect((screen.getByRole("textbox", { name: "项目成果2" }) as HTMLTextAreaElement).value).toBe("人工核实后的成果，尚未上线");
    fireEvent.click(deletion.getByRole("button", { name: "撤销采纳" }));
    expect((screen.getByRole("textbox", { name: "项目成果3" }) as HTMLTextAreaElement).value).toBe("原成果四");
  });

  it.each(["edit", "remove", "add"] as const)("手动 %s 后差异按当前草稿展示，再次采纳和撤销对应可见内容", async (action) => {
    const original = { ...project.summary, overview: "已人工校正的项目概述", achievements: ["原成果一", "原成果二", "原成果三", "原成果四"] };
    const generated = { ...original, overview: "新项目概述", achievements: ["新成果一", "新成果二"] };
    vi.mocked(jsonFetch).mockResolvedValue({ ...project, summary: original, summary_updated_at: "2026-10-25", summary_revision_id: 8 });
    const hook = await setup();
    act(() => hook.result.current.summary.applyDraft({
      summary: generated,
      comparison: compareProjectSummaries(original, generated, { overview: "旧 AI 项目概述" }),
      materialChanges: [{ id: 11, title: "更新材料", status: "changed" }],
      materialFingerprint: "f".repeat(64), revisionId: 8, source: "ai",
    }));
    act(() => {
      hook.result.current.summary.toggleAdoption("overview");
      hook.result.current.summary.toggleAdoption("achievement:0");
      hook.result.current.summary.toggleAdoption("achievement:2");
    });
    if (action === "edit") {
      act(() => hook.result.current.summary.updateAchievementItem(1, "人工校正的成果二，尚未上线"));
    } else if (action === "remove") {
      act(() => hook.result.current.summary.removeAchievementItem(0));
    } else {
      act(() => hook.result.current.summary.addAchievementItem());
      act(() => hook.result.current.summary.updateAchievementItem(3, "人工补充的成果，未统计收益"));
    }
    const before = hook.result.current.summary.summaryDraft!;
    const comparison = hook.result.current.summary.proposal!.comparison;
    expect(comparison).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "overview", status: "conflict", previous: original.overview }),
      expect.objectContaining({ key: "achievement:1", previous: before.achievements[1], next: "新成果二", status: action === "add" ? "changed" : "conflict" }),
    ]));
    expect(comparison.filter((change) => change.key.startsWith("achievement:")).map(({ key, previous, next, status }) => [key, previous, next, status])).toEqual({
      edit: [["achievement:1", "人工校正的成果二，尚未上线", "新成果二", "conflict"], ["achievement:2", "原成果四", "", "conflict"]],
      remove: [["achievement:0", "原成果二", "新成果一", "conflict"], ["achievement:1", "原成果四", "新成果二", "conflict"]],
      add: [["achievement:1", "原成果二", "新成果二", "changed"], ["achievement:2", "原成果四", "", "conflict"], ["achievement:3", "人工补充的成果，未统计收益", "", "conflict"]],
    }[action]);
    act(() => hook.result.current.summary.toggleAdoption("achievement:1"));
    expect(hook.result.current.summary.summaryDraft?.achievements).toEqual(before.achievements.map((text, index) => index === 1 ? "新成果二" : text));
    act(() => hook.result.current.summary.toggleAdoption("achievement:1"));
    expect(hook.result.current.summary.summaryDraft?.achievements).toEqual(before.achievements);
    act(() => hook.result.current.summary.toggleAdoption("achievement:1"));
    await act(async () => { await hook.result.current.summary.saveSummary(); });
    const patch = vi.mocked(jsonFetch).mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(JSON.parse(patch![1]!.body as string)).toMatchObject({
      summary: { ...before, achievements: before.achievements.map((text, index) => index === 1 ? "新成果二" : text) },
      expectedRevisionId: 8,
      proposal: { generated, acceptedKeys: ["overview", "achievement:1"], materialFingerprint: "f".repeat(64) },
    });
  });

  it.each([0, 1, 2])("采纳删除后编辑可见第 %i 项，不重复删除其他成果，保存与预览一致", async (index) => {
    const original = { ...project.summary, overview: "原项目概述", achievements: ["原成果一", "原成果二", "原成果三", "原成果四"] };
    const generated = { ...original, overview: "新项目概述", achievements: ["新成果一", "新成果二"] };
    const stored = { ...project, summary: original, summary_updated_at: "2026-10-25", summary_revision_id: 8 };
    vi.mocked(jsonFetch).mockResolvedValue(stored);
    const hook = await setup();
    act(() => hook.result.current.summary.applyDraft({
      summary: generated, comparison: compareProjectSummaries(original, generated, {}),
      materialChanges: [], materialFingerprint: "f".repeat(64), revisionId: 8, source: "ai",
    }));
    act(() => {
      hook.result.current.summary.toggleAdoption("overview");
      hook.result.current.summary.toggleAdoption("achievement:0");
      hook.result.current.summary.toggleAdoption("achievement:2");
    });
    expect(hook.result.current.summary.summaryDraft?.achievements).toEqual(["新成果一", "原成果二", "原成果四"]);
    const expected = ["新成果一", "原成果二", "原成果四"];
    expected[index] = "手动核实后的成果，尚未上线";
    act(() => hook.result.current.summary.updateAchievementItem(index, expected[index]!));
    expect(hook.result.current.summary.summaryDraft?.achievements).toEqual(expected);
    expect(hook.result.current.summary.summaryDraft?.overview).toBe("新项目概述");
    act(() => hook.result.current.summary.updateAchievementItem(index, expected[index]! + "，未统计收益"));
    expected[index] += "，未统计收益";
    expect(hook.result.current.summary.summaryDraft?.achievements).toEqual(expected);
    expect(hook.result.current.data?.summary).toEqual(original);
    await act(async () => { await hook.result.current.summary.saveSummary(); });
    const patch = vi.mocked(jsonFetch).mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(JSON.parse(patch![1]!.body as string)).toMatchObject({
      summary: { ...original, overview: generated.overview, achievements: expected },
      expectedRevisionId: 8,
      proposal: { acceptedKeys: ["overview"], generated, materialFingerprint: "f".repeat(64) },
    });
  });

  it("没有 AI 草稿时编辑成果仍保留空白输入和其他条目", async () => {
    const summary = { ...project.summary, achievements: ["成果一", "成果二"] };
    vi.mocked(jsonFetch).mockResolvedValue({ ...project, summary });
    const hook = await setup();
    act(() => hook.result.current.summary.updateAchievementItem(0, ""));
    expect(hook.result.current.summary.summaryDraft?.achievements).toEqual(["", "成果二"]);
    act(() => hook.result.current.summary.updateAchievementItem(0, "修改后的成果一"));
    expect(hook.result.current.summary.summaryDraft?.achievements).toEqual(["修改后的成果一", "成果二"]);
  });
});

describe("材料分页请求归属", () => {
  it("旧项目删除晚到后不能发起刷新并抢占新项目的读取", async () => {
    const { confirmDialog } = await import("@/components/common/confirm-dialog");
    vi.mocked(confirmDialog).mockResolvedValueOnce(true);
    const hook = renderHook(({ id }) => useProjectDetail(id), { initialProps: { id: "1" } });
    await waitFor(() => expect(hook.result.current.data?.id).toBe(1));
    const deletion = deferred<unknown>();
    const projectB = deferred<typeof project>();
    vi.mocked(jsonFetch).mockReturnValueOnce(deletion.promise).mockReturnValueOnce(projectB.promise).mockResolvedValueOnce(project);
    let removing!: Promise<void>;
    act(() => { removing = hook.result.current.material.removeMaterial(a.id, a.title); });
    await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(2));
    hook.rerender({ id: "2" });
    await waitFor(() => expect(jsonFetch).toHaveBeenCalledTimes(3));
    await act(async () => { deletion.resolve({}); await removing; });
    expect(jsonFetch).toHaveBeenCalledTimes(3);
    await act(async () => { projectB.resolve({ ...project, id: 2, materials: [] }); });
    expect(hook.result.current.data?.id).toBe(2);
  });
  it("同一 tick 双击只发送一次请求且按 ID 去重", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ...project, materials_next_cursor: "next" });
    const hook = await setup();
    const page = deferred<typeof project>();
    vi.mocked(jsonFetch).mockReturnValueOnce(page.promise);
    act(() => { hook.result.current.material.loadMoreMaterials(); hook.result.current.material.loadMoreMaterials(); });
    expect(jsonFetch).toHaveBeenCalledTimes(2);
    expect(hook.result.current.material.loadingMoreMaterials).toBe(true);
    await act(async () => { page.resolve({ ...project, materials: [b, { ...b, id: 33 }] }); });
    expect(hook.result.current.data?.materials.map((m) => m.id)).toEqual([11, 22, 33]);
    expect(hook.result.current.material.loadingMoreMaterials).toBe(false);
  });
  it("刷新后不追加迟到的旧分页响应", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ...project, materials_next_cursor: "next" });
    const hook = await setup();
    const page = deferred<typeof project>();
    vi.mocked(jsonFetch).mockReturnValueOnce(page.promise).mockResolvedValueOnce({ ...project, materials: [a] });
    act(() => hook.result.current.material.loadMoreMaterials());
    act(() => hook.result.current.retryLoad());
    await waitFor(() => expect(hook.result.current.data?.materials).toEqual([a]));
    await act(async () => { page.resolve({ ...project, materials: [b] }); });
    expect(hook.result.current.data?.materials).toEqual([a]);
  });
  it("切项目后不提交上个项目的分页", async () => {
    vi.mocked(jsonFetch).mockResolvedValueOnce({ ...project, materials_next_cursor: "next" });
    const hook = renderHook(({ id }) => useProjectDetail(id), { initialProps: { id: "1" } });
    await waitFor(() => expect(hook.result.current.data?.id).toBe(1));
    const page = deferred<typeof project>();
    vi.mocked(jsonFetch).mockReturnValueOnce(page.promise).mockResolvedValueOnce({ ...project, id: 2, materials: [] });
    act(() => hook.result.current.material.loadMoreMaterials());
    hook.rerender({ id: "2" });
    await waitFor(() => expect(hook.result.current.data?.id).toBe(2));
    await act(async () => { page.resolve({ ...project, materials: [b] }); });
    expect(hook.result.current.data?.id).toBe(2);
    expect(hook.result.current.data?.materials).toEqual([]);
  });
});

describe("材料编辑请求的会话归属", () => {
  it("旧列表编辑加载新详情后，保存正文不会覆盖另一标签的新标题", async () => {
    const hook = await setup();
    const current = { ...loadedA, title: "另一标签的新标题" };
    vi.mocked(jsonFetch).mockResolvedValueOnce(current);
    act(() => hook.result.current.material.startEdit(a));
    await waitFor(() => expect(hook.result.current.material.loadingEdit).toBe(false));
    act(() => hook.result.current.material.setEditContent("只修改正文"));
    await act(async () => { await hook.result.current.material.saveEdit(a.id); });
    const patch = vi.mocked(jsonFetch).mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(JSON.parse(patch![1]!.body as string)).toEqual({
      title: current.title, content: "只修改正文", expectedRevision: current.revision,
    });
  });

  it("A 的晚到详情不覆盖正在编辑的 B", async () => {
    const hook = await setup();
    const requestA = deferred<Material>();
    const requestB = deferred<Material>();
    vi.mocked(jsonFetch).mockReturnValueOnce(requestA.promise).mockReturnValueOnce(requestB.promise);
    act(() => { hook.result.current.material.startEdit(a); hook.result.current.material.startEdit(b); });
    await act(async () => { requestB.resolve(loadedB); await requestB.promise; });
    act(() => hook.result.current.material.setEditContent("B 未保存的新输入"));
    await act(async () => { requestA.resolve(loadedA); await requestA.promise; });
    expect(hook.result.current.material.editingId).toBe(b.id);
    expect(hook.result.current.material.editContent).toBe("B 未保存的新输入");
    expect(hook.result.current.material.editRevision).toBe(loadedB.revision);
  });

  it("同材料详情不会覆盖加载期间产生的草稿", async () => {
    const hook = await setup();
    const request = deferred<Material>();
    vi.mocked(jsonFetch).mockReturnValueOnce(request.promise);
    act(() => hook.result.current.material.startEdit(a));
    act(() => hook.result.current.material.setEditTitle("尚未保存的标题"));
    act(() => hook.result.current.material.setEditContent("尚未保存的正文"));
    await act(async () => { request.resolve(loadedA); await request.promise; });
    expect(hook.result.current.material.editContent).toBe("尚未保存的正文");
    expect(hook.result.current.material.editTitle).toBe("尚未保存的标题");
    expect(hook.result.current.material.editRevision).toBe(loadedA.revision);
  });

  it("取消后重新编辑同一材料只接收新会话的详情", async () => {
    const hook = await setup();
    const previous = deferred<Material>();
    const current = deferred<Material>();
    vi.mocked(jsonFetch).mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise);
    act(() => hook.result.current.material.startEdit(a));
    act(() => hook.result.current.material.setEditingId(null));
    act(() => hook.result.current.material.startEdit(a));
    await act(async () => { current.resolve({ ...loadedA, content: "新会话正文" }); await current.promise; });
    await act(async () => { previous.resolve(loadedA); await previous.promise; });
    expect(hook.result.current.material.editContent).toBe("新会话正文");
  });

  it("没有加载 revision 时不能提交保存", async () => {
    const hook = await setup();
    const request = deferred<Material>();
    vi.mocked(jsonFetch).mockReturnValueOnce(request.promise);
    act(() => hook.result.current.material.startEdit(a));
    await act(async () => { await hook.result.current.material.saveEdit(a.id); });
    expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(0);
    await act(async () => { request.resolve(loadedA); await request.promise; });
  });
});

function MaterialsView() {
  const view = useProjectDetail("1");
  return <ProjectMaterialsPanel {...view.material} materials={view.data?.materials ?? []} error={view.error}
    projectId={1} repoPaths={[]} onAddRepoPath={() => {}} onRemoveRepoPath={() => {}}
    onClearRepoPaths={() => {}} onOpenScanModal={() => {}} />;
}

it("详情加载时锁定输入，失败可见且能重试，成功后可以编辑", async () => {
  const request = deferred<Material>();
  vi.mocked(jsonFetch).mockResolvedValueOnce(project).mockReturnValueOnce(request.promise);
  render(<MaterialsView />);
  await waitFor(() => expect(screen.getAllByRole("button", { name: "编辑" })).toHaveLength(2));
  fireEvent.click(screen.getAllByRole("button", { name: "编辑" })[0]!);
  const content = screen.getByRole("textbox", { name: "编辑「材料 A」材料正文" }) as HTMLTextAreaElement;
  expect(content.disabled).toBe(true);
  expect(screen.getByRole("status").textContent).toContain("加载");
  await act(async () => { request.reject(new Error("详情请求失败")); await request.promise.catch(() => {}); });
  expect(screen.getByRole("alert").textContent).toContain("详情请求失败");
  expect(content.disabled).toBe(true);
  vi.mocked(jsonFetch).mockResolvedValueOnce(loadedA);
  fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
  await waitFor(() => expect(content.disabled).toBe(false));
  expect(content.value).toBe("A 正文");
  expect(screen.queryByRole("alert")).toBeNull();
});
