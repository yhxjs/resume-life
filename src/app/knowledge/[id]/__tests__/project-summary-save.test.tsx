// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptySummary } from "@/lib/summary";
import { compareProjectSummaries } from "@/lib/project-summary-diff";
import { HttpError } from "@/lib/fetcher";
import { useProjectDetail } from "../use-project-detail";

const calls = vi.hoisted(() => ({ json: vi.fn() }));
vi.mock("@/lib/fetcher", async importOriginal => ({ ...await importOriginal<object>(), jsonFetch: calls.json }));
vi.mock("@/lib/fetch-sse", () => ({ fetchSse: vi.fn() }));
const project = { id: 1, name: "保存核对", summary: emptySummary(), summary_updated_at: "", summary_revision_id: 0, materials: [] };
const generated = { ...emptySummary(), overview: "本人核实的项目定位 <T> &amp;", achievements: ["合成成果，未统计收益"] };
const saved = { ...project, summary: generated, summary_revision_id: 7, summary_updated_at: "2026-11-02T12:00:00Z" };
const writes = () => calls.json.mock.calls.filter(([, init]) => init?.method === "PATCH");
beforeEach(() => calls.json.mockReset().mockResolvedValue(project));
afterEach(cleanup);
async function setup() {
  const hook = renderHook(() => useProjectDetail("1"));
  await waitFor(() => expect(hook.result.current.data?.id).toBe(1));
  act(() => hook.result.current.summary.applyDraft({ summary: generated, comparison: compareProjectSummaries(project.summary, generated, {}),
    materialChanges: [], materialFingerprint: "a".repeat(64), revisionId: 0, source: "ai" }));
  return hook;
}
describe("项目总结写入确认", () => {
  it.each([
    ["空响应", {}],
    ["旧版本", { revisionId: 0, summary: generated }],
    ["不匹配正文", { revisionId: 1, summary: emptySummary() }],
    ["缺少正文", { revisionId: 1 }],
    ["残缺正文", { revisionId: 1, summary: { overview: generated.overview } }],
    ["字符串版本", { revisionId: "1", summary: generated }],
    ["小数版本", { revisionId: 1.5, summary: generated }],
    ["不安全版本", { revisionId: Number.MAX_SAFE_INTEGER + 1, summary: generated }],
    ["明确非成功", { ok: false, revisionId: 1, summary: generated }],
    ["损坏时间", { revisionId: 1, summary: generated, summary_updated_at: {} }],
  ])("%s 不能报告保存成功或清除草稿，回读失败时保留采纳选择", async (_name, response) => {
    const hook = await setup();
    const before = hook.result.current.summary;
    calls.json.mockResolvedValueOnce(response).mockRejectedValueOnce(new Error("合成核对失败"));
    await act(async () => { await hook.result.current.summary.saveSummary(); });
    expect(hook.result.current.summary.pendingDraft).toBe(true);
    expect(hook.result.current.summary.summaryDraft).toEqual(before.summaryDraft);
    expect(hook.result.current.summary.selectedKeys).toEqual(before.selectedKeys);
    expect(hook.result.current.summary.sumStatus?.kind).not.toBe("ok");
    expect(calls.json).toHaveBeenCalledWith("/api/projects/1", expect.objectContaining({ cache: "no-store" }));
    expect(writes()).toHaveLength(1);
    expect(hook.result.current.summary.saveRecovery).toMatchObject({ retry: true, checking: false });
    await act(async () => { await hook.result.current.summary.saveSummary(); });
    expect(writes()).toHaveLength(1);
  });

  it.each(["bad-response", "network", "408"])("%s 后读取完整新档案确认相同正文，只提交一次并推进保存基准", async outcome => {
    const hook = await setup();
    if (outcome === "bad-response") calls.json.mockResolvedValueOnce({});
    else calls.json.mockRejectedValueOnce(outcome === "408" ? new HttpError("合成响应超时", 408) : new Error("合成断线"));
    calls.json.mockResolvedValueOnce(saved);
    await act(async () => { await hook.result.current.summary.saveSummary(); });
    expect(hook.result.current.data?.summary_revision_id).toBe(7);
    expect(hook.result.current.summary.pendingDraft).toBe(false);
    expect(hook.result.current.summary.proposal).toBeNull();
    expect(hook.result.current.summary.saveRecovery).toBeNull();
    expect(hook.result.current.summary.sumStatus?.text).toBe("已核对项目档案包含本次提交的总结内容");
    expect(writes()).toHaveLength(1);
    act(() => hook.result.current.summary.updateSummaryField("brief", "核对后补充的介绍"));
    const next = { ...generated, brief: "核对后补充的介绍" };
    calls.json.mockResolvedValueOnce({ revisionId: 9, summary: next }).mockResolvedValueOnce({ ...saved, summary: next, summary_revision_id: 9 });
    await act(async () => { await hook.result.current.summary.saveSummary(); });
    expect(JSON.parse(writes()[1]![1].body).expectedRevisionId).toBe(7);
    expect(hook.result.current.summary.summaryDraft).toEqual(next);
  });

  it.each(["different-project", "missing-version", "broken-summary"])("首次核对 %s 后锁住重复写入，显式重读保留等待期间的新编辑", async kind => {
    const hook = await setup();
    const broken = kind === "different-project" ? { ...saved, id: 2 } : kind === "missing-version" ? { ...saved, summary_revision_id: undefined } : { ...saved, summary: { overview: "残缺" } };
    calls.json.mockResolvedValueOnce({}).mockResolvedValueOnce(broken);
    await act(async () => { await hook.result.current.summary.saveSummary(); });
    expect(hook.result.current.summary.saveRecovery?.retry).toBe(true);
    expect(hook.result.current.data?.summary_revision_id).toBe(0);
    const waiting = Promise.withResolvers<unknown>();
    calls.json.mockReturnValueOnce(waiting.promise);
    let reading!: Promise<void> | undefined;
    act(() => {
      reading = hook.result.current.summary.retrySaveCheck();
      void hook.result.current.summary.retrySaveCheck();
      void hook.result.current.summary.saveSummary();
    });
    expect(hook.result.current.summary.saveRecovery?.checking).toBe(true);
    act(() => {
      hook.result.current.summary.updateSummaryField("brief", "核对期间的新编辑");
      hook.result.current.summary.toggleAdoption("overview");
    });
    const before = hook.result.current.summary;
    await act(async () => { waiting.resolve(saved); await reading; });
    expect(hook.result.current.summary.summaryDraft).toEqual(before.summaryDraft);
    expect(hook.result.current.summary.selectedKeys).toEqual(before.selectedKeys);
    expect(hook.result.current.summary.pendingDraft).toBe(true);
    expect(hook.result.current.summary.saveRecovery).toBeNull();
    expect(hook.result.current.data?.summary).toEqual(generated);
    expect(writes()).toHaveLength(1);
    expect(calls.json.mock.calls.filter(([, init]) => init?.cache === "no-store")).toHaveLength(2);
    const next = { ...generated, overview: "", brief: "核对期间的新编辑" };
    calls.json.mockResolvedValueOnce({ revisionId: 8, summary: next }).mockResolvedValueOnce({ ...saved, summary: next, summary_revision_id: 8 });
    await act(async () => { await hook.result.current.summary.saveSummary(); });
    expect(writes()).toHaveLength(2);
    expect(JSON.parse(writes()[1]![1].body).expectedRevisionId).toBe(7);
    expect(hook.result.current.summary.summaryDraft).toEqual(next);
  });

  it.each(["unchanged", "another-save"])("核对到 %s 保留草稿，下一次显式保存继续绑定原版本", async kind => {
    const hook = await setup();
    const detail = kind === "unchanged" ? project : { ...saved, summary: { ...generated, overview: "其他页面保存的概述" } };
    calls.json.mockResolvedValueOnce({}).mockResolvedValueOnce(detail);
    await act(async () => { await hook.result.current.summary.saveSummary(); });
    expect(hook.result.current.summary.pendingDraft).toBe(true);
    expect(hook.result.current.summary.summaryDraft).toEqual(generated);
    expect(hook.result.current.summary.saveRecovery).toMatchObject({ retry: false, checking: false });
    calls.json.mockRejectedValueOnce(new HttpError("合成版本冲突", 409));
    await act(async () => { await hook.result.current.summary.saveSummary(); });
    expect(JSON.parse(writes()[1]![1].body).expectedRevisionId).toBe(0);
    expect(hook.result.current.summary.sumStatus?.text).toBe("保存失败：合成版本冲突");
  });

  it("明确的 400 不额外回读，原稿及采纳选择仍可显式修改", async () => {
    const hook = await setup();
    calls.json.mockRejectedValueOnce(new HttpError("合成输入无效", 400));
    await act(async () => { await hook.result.current.summary.saveSummary(); });
    expect(calls.json).toHaveBeenCalledTimes(2);
    expect(hook.result.current.summary.saveRecovery).toBeNull();
    expect(hook.result.current.summary.pendingDraft).toBe(true);
    expect(hook.result.current.summary.sumStatus?.text).toBe("保存失败：合成输入无效");
  });

  it("离页中止在途核对，迟到回复不继续刷新或提交", async () => {
    const hook = await setup();
    const waiting = Promise.withResolvers<unknown>();
    calls.json.mockResolvedValueOnce({}).mockReturnValueOnce(waiting.promise);
    let saving!: Promise<void>;
    act(() => { saving = hook.result.current.summary.saveSummary(); });
    await waitFor(() => expect(calls.json).toHaveBeenCalledTimes(3));
    const signal = calls.json.mock.calls[2]![1].signal as AbortSignal;
    hook.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => { waiting.resolve(saved); await saving; });
    expect(calls.json).toHaveBeenCalledTimes(3);
    expect(writes()).toHaveLength(1);
  });
});
