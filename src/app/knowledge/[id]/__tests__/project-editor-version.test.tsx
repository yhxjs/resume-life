// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptySummary } from "@/lib/summary";
import { compareProjectSummaries } from "@/lib/project-summary-diff";
import { useProjectDetail } from "../use-project-detail";

const requests = vi.hoisted(() => ({ json: vi.fn(), stream: vi.fn() }));
vi.mock("@/lib/fetcher", async importOriginal => ({ ...await importOriginal<object>(), jsonFetch: requests.json }));
vi.mock("@/lib/fetch-sse", () => ({ fetchSse: requests.stream }));
const original = { ...emptySummary(), responsibilities: "参与联调，尚未上线" };
const revised = { ...original, responsibilities: "更正：仅做校验，联调由同事完成" };
const first = { id: 1, name: "版本项目", summary: original, summary_updated_at: "2026-10-01", summary_revision_id: 5,
  materials: [{ id: 11, title: "材料", source: "text", filename: "", created_at: "" }], materials_next_cursor: "11" };
const latest = { ...first, summary: revised, summary_revision_id: 6, materials_next_cursor: null };
beforeEach(() => { requests.json.mockReset().mockResolvedValue(first); requests.stream.mockReset(); });
afterEach(cleanup);

async function setup() {
  const hook = renderHook(() => useProjectDetail("1"));
  await waitFor(() => expect(hook.result.current.data?.summary_revision_id).toBe(5));
  return hook;
}
const writes = () => requests.json.mock.calls.filter(([, options]) => options?.method === "PATCH");

describe("编辑正文与保存版本归属", () => {
  it.each(["refresh", "append"])("%s 读取了新档案，保留的旧编辑仍用原版本保存并收到冲突", async action => {
    const hook = await setup();
    act(() => hook.result.current.summary.updateSummaryField("brief", "本地未保存介绍"));
    requests.json.mockResolvedValueOnce(latest);
    if (action === "refresh") await act(async () => { await hook.result.current.summary.refreshSummary(); });
    else {
      act(() => hook.result.current.material.loadMoreMaterials());
      await waitFor(() => expect(hook.result.current.data?.summary_revision_id).toBe(6));
    }
    expect(hook.result.current.summary.summaryDraft?.responsibilities).toBe(original.responsibilities);
    requests.json.mockImplementationOnce((_url, options) => {
      const body = JSON.parse(options.body);
      return body.expectedRevisionId === 6 ? Promise.resolve({ revisionId: 7, summary: body.summary }) : Promise.reject(new Error("项目总结已更新，请刷新后重新核对草稿"));
    });
    await act(async () => { await hook.result.current.summary.saveSummary(); });
    expect(JSON.parse(writes()[0]![1].body).expectedRevisionId).toBe(5);
    expect(hook.result.current.summary.sumStatus?.kind).toBe("err");
    expect(hook.result.current.summary.summaryDraft?.brief).toBe("本地未保存介绍");
  });

  it("自己的保存成功后又读到他人的新版本，下一次保存仍绑定本次确认的版本", async () => {
    const hook = await setup();
    act(() => hook.result.current.summary.updateSummaryField("brief", "本人提交的介绍"));
    const confirmed = { ...original, brief: "本人提交的介绍" };
    requests.json.mockResolvedValueOnce({ revisionId: 6, summary: confirmed }).mockResolvedValueOnce({ ...latest, summary_revision_id: 7 });
    await act(async () => { await hook.result.current.summary.saveSummary(); });
    expect(hook.result.current.data?.summary_revision_id).toBe(7);
    act(() => hook.result.current.summary.updateSummaryField("techStack", "TypeScript"));
    requests.json.mockRejectedValueOnce(new Error("项目总结已更新"));
    await act(async () => { await hook.result.current.summary.saveSummary(); });
    expect(JSON.parse(writes()[1]![1].body).expectedRevisionId).toBe(6);
    expect(hook.result.current.summary.summaryDraft?.responsibilities).toBe(original.responsibilities);
  });

  it.each(["ai", "repo"] as const)("新版本的 %s 草稿不能让旧编辑绕过冲突检查", async source => {
    const hook = await setup();
    requests.json.mockResolvedValueOnce(latest);
    await act(async () => { await hook.result.current.summary.refreshSummary(); });
    const generated = { ...revised, brief: "新版本生成的介绍" };
    act(() => hook.result.current.summary.applyDraft({ summary: generated, comparison: compareProjectSummaries(revised, generated, {}),
      revisionId: 6, materialChanges: [], materialFingerprint: "a".repeat(64), source }));
    act(() => hook.result.current.summary.toggleAdoption("brief"));
    await act(async () => { await hook.result.current.summary.saveSummary(); });
    expect(writes()).toHaveLength(0);
    expect(hook.result.current.summary.sumStatus?.kind).toBe("err");
    expect(hook.result.current.summary.summaryDraft?.responsibilities).toBe(original.responsibilities);
    expect(hook.result.current.summary.pendingDraft).toBe(true);
  });

  it("显式放弃草稿后，正文与基准一起切换到已读取档案，后续保存可继续", async () => {
    const hook = await setup();
    requests.json.mockResolvedValueOnce(latest);
    await act(async () => { await hook.result.current.summary.refreshSummary(); });
    act(() => hook.result.current.summary.discardDraft());
    expect(hook.result.current.summary.summaryDraft).toEqual(revised);
    act(() => hook.result.current.summary.updateSummaryField("brief", "基于更正后的编辑"));
    requests.json.mockResolvedValueOnce({ revisionId: 7, summary: { ...revised, brief: "基于更正后的编辑" } }).mockResolvedValueOnce({ ...latest, summary_revision_id: 7 });
    await act(async () => { await hook.result.current.summary.saveSummary(); });
    expect(JSON.parse(writes()[0]![1].body).expectedRevisionId).toBe(6);
    expect(hook.result.current.summary.sumStatus?.kind).toBe("ok");
  });

  it("保存等待期间放弃到旧档案，晚到确认不能给旧正文换上已提交版本", async () => {
    const hook = await setup();
    act(() => hook.result.current.summary.updateSummaryField("brief", "等待保存的介绍"));
    const saving = Promise.withResolvers<unknown>();
    requests.json.mockReturnValueOnce(saving.promise).mockResolvedValueOnce(latest);
    let pending!: Promise<void>;
    act(() => { pending = hook.result.current.summary.saveSummary(); });
    act(() => hook.result.current.summary.discardDraft());
    await act(async () => { saving.resolve({ revisionId: 6, summary: { ...original, brief: "等待保存的介绍" } }); await pending; });
    expect(hook.result.current.summary.summaryDraft).toEqual(original);
    requests.json.mockRejectedValueOnce(new Error("项目总结已更新"));
    await act(async () => { await hook.result.current.summary.saveSummary(); });
    expect(JSON.parse(writes()[1]![1].body).expectedRevisionId).toBe(5);
  });
});
