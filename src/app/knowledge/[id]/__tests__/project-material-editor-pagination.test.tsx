// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptySummary } from "@/lib/summary";
import { HttpError } from "@/lib/fetcher";
import { useProjectDetail } from "../use-project-detail";
import { ProjectMaterialsPanel } from "../project-materials-panel";

const calls = vi.hoisted(() => ({ json: vi.fn(), alert: vi.fn(), confirm: vi.fn() }));
vi.mock("@/lib/fetcher", async importOriginal => ({ ...await importOriginal<object>(), jsonFetch: calls.json }));
vi.mock("@/lib/fetch-sse", () => ({ fetchSse: vi.fn() }));
vi.mock("../directory-picker-dialog", () => ({ DirectoryPickerDialog: () => null }));
vi.mock("@/components/common/confirm-dialog", () => ({ alertDialog: calls.alert, confirmDialog: calls.confirm }));
const recent = { id: 22, title: "首页材料", source: "text", filename: "", created_at: "" };
const older = { ...recent, id: 11, title: "续页材料" };
const loaded = { ...older, title: "最新材料标题", content: "旧职责", revision: "a".repeat(64) };
const project = { id: 1, name: "分页编辑项目", summary: emptySummary(), summary_updated_at: "", materials: [recent], materials_next_cursor: "22", materials_total: 2 };
beforeEach(() => {
  calls.json.mockReset().mockResolvedValue(project);
  calls.alert.mockReset().mockResolvedValue(undefined);
  calls.confirm.mockReset().mockResolvedValue(true);
});
afterEach(cleanup);
function View() {
  const view = useProjectDetail("1");
  return <>
    <button onClick={() => { void view.material.refreshMaterials(); }}>刷新材料列表</button>
    <ProjectMaterialsPanel {...view.material} materials={view.data?.materials ?? []} materialsTotal={view.data?.materials_total}
      error={view.error} projectId={1} repoPaths={[]} onAddRepoPath={() => {}} onRemoveRepoPath={() => {}}
      onClearRepoPaths={() => {}} onOpenScanModal={() => {}} />
  </>;
}
async function setup() {
  render(<View />);
  await screen.findByText(recent.title, { exact: true });
  calls.json.mockResolvedValueOnce({ ...project, materials: [older], materials_next_cursor: null });
  fireEvent.click(screen.getByRole("button", { name: "加载更多材料" }));
  const row = await screen.findByText(older.title, { exact: true });
  return row.closest(".rounded-xl")! as HTMLElement;
}
const editor = () => screen.getByRole("textbox", { name: `编辑「${loaded.title}」材料正文` }) as HTMLTextAreaElement;
async function refresh() {
  calls.json.mockResolvedValueOnce(project);
  fireEvent.click(screen.getByRole("button", { name: "刷新材料列表" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "加载更多材料" })).toBeTruthy());
}

describe("材料分页刷新不隐藏当前编辑器", () => {
  it("详情已加载且有未保存改动，刷新首页后仍可保存原基准，保存后清理保留行", async () => {
    const row = await setup();
    calls.json.mockResolvedValueOnce(loaded);
    fireEvent.click(within(row).getByRole("button", { name: "编辑" }));
    await waitFor(() => expect(editor().disabled).toBe(false));
    fireEvent.change(editor(), { target: { value: "尚未保存的更正职责" } });
    await refresh();
    expect(editor().value).toBe("尚未保存的更正职责");
    expect(screen.getByText("当前编辑材料（未在本页列表中）")).toBeTruthy();
    expect(screen.getByText("已沉淀技术文档 (2)")).toBeTruthy();
    calls.json.mockResolvedValueOnce({ ok: true, revision: "b".repeat(64) }).mockResolvedValueOnce(project);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: `编辑「${loaded.title}」材料正文` })).toBeNull());
    const patch = calls.json.mock.calls.find(([, options]) => options?.method === "PATCH");
    expect(JSON.parse(patch![1].body)).toEqual({ title: loaded.title, content: "尚未保存的更正职责", expectedRevision: loaded.revision });
    expect(screen.queryByText("当前编辑材料（未在本页列表中）")).toBeNull();
  });

  it("刷新时详情仍在加载，回包后编辑器和最新标题可见", async () => {
    const row = await setup();
    const detail = Promise.withResolvers<typeof loaded>();
    calls.json.mockReturnValueOnce(detail.promise);
    fireEvent.click(within(row).getByRole("button", { name: "编辑" }));
    await refresh();
    expect(screen.getByRole("status").textContent).toContain("正在加载材料正文");
    await act(async () => { detail.resolve(loaded); await detail.promise; });
    await waitFor(() => expect(editor().value).toBe(loaded.content));
    expect(editor().disabled).toBe(false);
  });

  it("刷新后详情失败仍可重试，取消后不再保留脱离分页的编辑行", async () => {
    const row = await setup();
    const detail = Promise.withResolvers<typeof loaded>();
    calls.json.mockReturnValueOnce(detail.promise);
    fireEvent.click(within(row).getByRole("button", { name: "编辑" }));
    await refresh();
    await act(async () => { detail.reject(new Error("详情暂不可用")); await detail.promise.catch(() => {}); });
    expect(screen.getByRole("alert").textContent).toContain("详情暂不可用");
    calls.json.mockResolvedValueOnce(loaded);
    fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
    await waitFor(() => expect(editor().value).toBe(loaded.content));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByText(loaded.title, { exact: true })).toBeNull();
  });

  it("重新分页加载当前材料时只显示一行，草稿和原版本不被新元数据替换", async () => {
    const row = await setup();
    calls.json.mockResolvedValueOnce(loaded);
    fireEvent.click(within(row).getByRole("button", { name: "编辑" }));
    await waitFor(() => expect(editor().disabled).toBe(false));
    fireEvent.change(editor(), { target: { value: "当前未保存的职责" } });
    await refresh();
    calls.json.mockResolvedValueOnce({ ...project, materials: [{ ...older, title: loaded.title }], materials_next_cursor: null });
    fireEvent.click(screen.getByRole("button", { name: "加载更多材料" }));
    await waitFor(() => expect(screen.queryByText("当前编辑材料（未在本页列表中）")).toBeNull());
    expect(screen.getAllByText(loaded.title, { exact: true })).toHaveLength(1);
    expect(editor().value).toBe("当前未保存的职责");
    calls.json.mockRejectedValueOnce(new HttpError("材料已更新，请刷新后重试", 409));
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(calls.alert).toHaveBeenCalledWith({ title: "保存失败", message: "材料已更新，请刷新后重试" }));
    expect(editor().value).toBe("当前未保存的职责");
    const patch = calls.json.mock.calls.find(([, options]) => options?.method === "PATCH");
    expect(JSON.parse(patch![1].body).expectedRevision).toBe(loaded.revision);
  });

  it("临时保留行可正常删除，确认后编辑器消失且不改变首页材料", async () => {
    const row = await setup();
    calls.json.mockResolvedValueOnce(loaded);
    fireEvent.click(within(row).getByRole("button", { name: "编辑" }));
    await waitFor(() => expect(editor().disabled).toBe(false));
    await refresh();
    calls.json.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ...project, materials_total: 1, materials_next_cursor: null });
    const retained = screen.getByText("当前编辑材料（未在本页列表中）").parentElement!;
    fireEvent.click(within(retained).getByRole("button", { name: "删除" }));
    await waitFor(() => expect(screen.queryByText(loaded.title, { exact: true })).toBeNull());
    expect(screen.getByText(recent.title, { exact: true })).toBeTruthy();
    expect(screen.queryByText("当前编辑材料（未在本页列表中）")).toBeNull();
  });

  it("切换去编辑首页材料时不再显示上一份临时行或沿用其正文", async () => {
    const row = await setup();
    calls.json.mockResolvedValueOnce(loaded);
    fireEvent.click(within(row).getByRole("button", { name: "编辑" }));
    await waitFor(() => expect(editor().disabled).toBe(false));
    await refresh();
    const firstRow = screen.getByText(recent.title, { exact: true }).closest(".rounded-xl")! as HTMLElement;
    calls.json.mockResolvedValueOnce({ ...recent, content: "首页材料正文", revision: "c".repeat(64) });
    fireEvent.click(within(firstRow).getByRole("button", { name: "编辑" }));
    await waitFor(() => expect((screen.getByRole("textbox", { name: `编辑「${recent.title}」材料正文` }) as HTMLTextAreaElement).value).toBe("首页材料正文"));
    expect(screen.queryByText(loaded.title, { exact: true })).toBeNull();
    expect(screen.queryByText("当前编辑材料（未在本页列表中）")).toBeNull();
  });
});
