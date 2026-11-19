// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptySummary } from "@/lib/summary";
import { useProjectDetail } from "../use-project-detail";

const calls = vi.hoisted(() => ({ json: vi.fn() }));
vi.mock("@/lib/fetcher", async importOriginal => ({ ...await importOriginal<object>(), jsonFetch: calls.json }));
vi.mock("@/lib/fetch-sse", () => ({ fetchSse: vi.fn() }));
const material = { id: 11, title: "首页材料", source: "text", filename: "", created_at: "" };
const original = { ...emptySummary(), responsibilities: "参与校验，尚未上线" };
const revised = { ...original, brief: "已核实并保存的项目介绍" };
const first = { id: 1, name: "乱序项目", summary: original, summary_updated_at: "2026-10-01", summary_revision_id: 5,
  summary_corrupt: false, materials: [material], materials_next_cursor: "11", materials_total: 2 };
const confirmed = { ...first, summary: revised, summary_updated_at: "2026-11-02T12:00:00Z", summary_revision_id: 6 };
const late = { ...first, name: "读取到的项目名称", materials: [{ ...material, id: 10, title: "晚到材料" }], materials_next_cursor: null, materials_total: 2 };
beforeEach(() => calls.json.mockReset().mockResolvedValue(first));
afterEach(cleanup);

describe("总结确认后的详情乱序", () => {
  it("正常保存后的重读也不能回退确认版本，材料和名称仍按重读更新", async () => {
    const hook = renderHook(() => useProjectDetail("1"));
    await waitFor(() => expect(hook.result.current.data?.summary_revision_id).toBe(5));
    act(() => hook.result.current.summary.updateSummaryField("brief", revised.brief));
    calls.json.mockResolvedValueOnce({ revisionId: 6, summary: revised, summary_updated_at: confirmed.summary_updated_at }).mockResolvedValueOnce(late);
    await act(async () => { await hook.result.current.summary.saveSummary(); });
    expect(hook.result.current.data).toMatchObject({ summary: revised, summary_revision_id: 6,
      summary_updated_at: confirmed.summary_updated_at, materials: late.materials, name: late.name });
    expect(hook.result.current.summary.sumStatus?.kind).toBe("ok");
    expect(hook.result.current.summary.refreshError).toBe("");
  });

  it.each(["append", "summary-refresh", "material-refresh"] as const)("%s 的旧详情仍更新材料，但不回退确认正文、时间与放弃草稿的基准", async action => {
    const hook = renderHook(() => useProjectDetail("1"));
    await waitFor(() => expect(hook.result.current.data?.summary_revision_id).toBe(5));
    const read = Promise.withResolvers<unknown>();
    calls.json.mockReturnValueOnce(read.promise);
    let reading: Promise<void> | undefined;
    act(() => {
      if (action === "append") hook.result.current.material.loadMoreMaterials();
      else if (action === "summary-refresh") reading = hook.result.current.summary.refreshSummary();
      else reading = hook.result.current.material.refreshMaterials();
    });
    act(() => hook.result.current.summary.updateSummaryField("brief", revised.brief));
    calls.json.mockResolvedValueOnce({}).mockResolvedValueOnce(confirmed);
    await act(async () => { await hook.result.current.summary.saveSummary(); });
    expect(hook.result.current.data?.summary_revision_id).toBe(6);
    await act(async () => { read.resolve(late); await reading; });
    await waitFor(() => expect(hook.result.current.data?.materials.some(item => item.id === 10)).toBe(true));
    expect(hook.result.current.data).toMatchObject({ summary: revised, summary_revision_id: 6,
      summary_updated_at: confirmed.summary_updated_at, summary_corrupt: false, materials_next_cursor: null, name: late.name });
    expect(hook.result.current.data?.materials.map(item => item.id)).toEqual(action === "append" ? [11, 10] : [10]);
    act(() => hook.result.current.summary.discardDraft());
    expect(hook.result.current.summary.summaryDraft).toEqual(revised);
    act(() => hook.result.current.summary.updateSummaryField("techStack", "TypeScript"));
    const next = { ...revised, techStack: "TypeScript" };
    calls.json.mockResolvedValueOnce({ revisionId: 7, summary: next }).mockResolvedValueOnce({ ...confirmed, summary: next, summary_revision_id: 7 });
    await act(async () => { await hook.result.current.summary.saveSummary(); });
    const writes = calls.json.mock.calls.filter(([, init]) => init?.method === "PATCH");
    expect(writes).toHaveLength(2);
    expect(JSON.parse(writes[1]![1].body)).toMatchObject({ summary: next, expectedRevisionId: 6 });
  });

  it.each([6, 7])("版本 %i 的详情正常更新缓存，仍不替换未保存正文及其版本", async revision => {
    const hook = renderHook(() => useProjectDetail("1"));
    await waitFor(() => expect(hook.result.current.data?.summary_revision_id).toBe(5));
    act(() => hook.result.current.summary.updateSummaryField("brief", revised.brief));
    calls.json.mockResolvedValueOnce({}).mockResolvedValueOnce(confirmed);
    await act(async () => { await hook.result.current.summary.saveSummary(); });
    act(() => hook.result.current.summary.updateSummaryField("techStack", "未保存的手动编辑"));
    const summary = revision === 6 ? revised : { ...revised, responsibilities: "他人保存的更正" };
    calls.json.mockResolvedValueOnce({ ...late, summary, summary_revision_id: revision, summary_updated_at: confirmed.summary_updated_at });
    await act(async () => { await hook.result.current.summary.refreshSummary(); });
    expect(hook.result.current.data).toMatchObject({ summary, summary_revision_id: revision, materials: late.materials });
    expect(hook.result.current.summary.summaryDraft).toEqual({ ...revised, techStack: "未保存的手动编辑" });
    calls.json.mockRejectedValueOnce(new Error("合成断线")).mockResolvedValueOnce({ ...confirmed, summary, summary_revision_id: revision });
    await act(async () => { await hook.result.current.summary.saveSummary(); });
    const writes = calls.json.mock.calls.filter(([, init]) => init?.method === "PATCH");
    expect(JSON.parse(writes[1]![1].body).expectedRevisionId).toBe(6);
  });
});
