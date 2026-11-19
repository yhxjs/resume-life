// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptySummary, type ProjectSummary } from "@/lib/summary";
import { HttpError } from "@/lib/fetcher";
import { compareProjectSummaries } from "@/lib/project-summary-diff";
import ProjectDetailPage from "../page";

const requests = vi.hoisted(() => ({ json: vi.fn(), stream: vi.fn() }));
vi.mock("@/lib/fetcher", async importOriginal => ({ ...await importOriginal<object>(), jsonFetch: requests.json }));
vi.mock("@/lib/fetch-sse", () => ({ fetchSse: requests.stream }));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: "1" }) }));
vi.mock("../project-summary-history", () => ({ ProjectSummaryHistory: () => null }));
vi.mock("../directory-picker-dialog", () => ({ DirectoryPickerDialog: () => null }));

const first = { id: 1, name: "仅档案项目", summary: emptySummary(), summary_updated_at: "", summary_revision_id: 0, materials: [], materials_total: 0 };
const button = () => screen.getByRole<HTMLButtonElement>("button", { name: "✨ 单独提炼简历三项" });

beforeEach(() => {
  requests.json.mockReset().mockResolvedValue(first);
  requests.stream.mockReset();
});
afterEach(cleanup);

async function setup(summary = emptySummary(), materialsTotal = 0) {
  requests.json.mockResolvedValue({ ...first, summary, materials_total: materialsTotal });
  render(<ProjectDetailPage />);
  await waitFor(() => expect(button()).toBeTruthy());
}

describe("仅已保存档案的简历提炼入口", () => {
  it.each(Object.keys(emptySummary()) as (keyof ProjectSummary)[])("仅 %s 字段有保存内容也能提炼", async key => {
    await setup({ ...emptySummary(), [key]: key === "achievements" ? ["", "  已确认成果  "] : "  已确认文字  " });
    expect(button().disabled).toBe(false);
    fireEvent.click(button());
    await waitFor(() => expect(requests.stream).toHaveBeenCalledWith("/api/projects/1/summarize?mode=resume-only", expect.any(Object)));
  });

  it.each([emptySummary(), { ...emptySummary(), responsibilities: " \t\n", achievements: ["", "\uFEFF \n"] }])("空或纯空白档案仍不可提炼", async summary => {
    await setup(summary);
    expect(button().disabled).toBe(true);
    fireEvent.click(button());
    expect(requests.stream).not.toHaveBeenCalled();
  });

  it("材料总数有值时无需已加载材料正文或非空档案", async () => {
    await setup(emptySummary(), 2);
    expect(button().disabled).toBe(false);
  });

  it("手动编辑和保存失败不构成来源，保存确认后刷新失败仍使用已确认档案", async () => {
    await setup();
    fireEvent.change(screen.getByRole("textbox", { name: "主要职责" }), { target: { value: "已核实的联调职责" } });
    expect(button().disabled).toBe(true);
    requests.json.mockRejectedValueOnce(new HttpError("写入失败", 400));
    fireEvent.click(screen.getByRole("button", { name: "保存总结修改" }));
    await waitFor(() => expect(screen.getByText("保存失败：写入失败")).toBeTruthy());
    expect(button().disabled).toBe(true);
    const confirmed = { ...emptySummary(), responsibilities: "已核实的联调职责" };
    const saving = Promise.withResolvers<unknown>();
    requests.json.mockReturnValueOnce(saving.promise).mockRejectedValueOnce(new Error("刷新失败"));
    fireEvent.click(screen.getByRole("button", { name: "保存总结修改" }));
    expect(button().disabled).toBe(true);
    await act(async () => { saving.resolve({ revisionId: 1, summary: confirmed }); });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("详情刷新失败"));
    expect(button().disabled).toBe(false);
  });

  it("本地清空不会抹掉已保存来源，清空保存成功后才禁用", async () => {
    await setup({ ...emptySummary(), responsibilities: "已保存职责" });
    fireEvent.change(screen.getByRole("textbox", { name: "主要职责" }), { target: { value: "" } });
    expect(button().disabled).toBe(false);
    requests.json.mockResolvedValueOnce({ revisionId: 2, summary: emptySummary() }).mockResolvedValueOnce({ ...first, summary_revision_id: 2 });
    fireEvent.click(screen.getByRole("button", { name: "保存总结修改" }));
    await waitFor(() => expect(screen.getByText("总结已保存")).toBeTruthy());
    expect(button().disabled).toBe(true);
  });

  it("未采纳的 AI 提案即使显示非空内容也不能成为来源", async () => {
    await setup();
    const generated = { ...emptySummary(), brief: "未保存 AI 草稿" };
    requests.stream.mockImplementationOnce(async (_url, options) => {
      await options.onDone({ summary: generated, comparison: compareProjectSummaries(emptySummary(), generated, {}),
        materialChanges: [], materialFingerprint: "a".repeat(64), revisionId: 0 });
    });
    fireEvent.click(screen.getByRole("button", { name: /生成 AI STAR 总结/ }));
    await waitFor(() => expect(screen.getByText("AI 草稿待确认：")).toBeTruthy());
    expect((screen.getByRole("textbox", { name: "项目简要概述（针对简历的一两句精炼介绍）" }) as HTMLTextAreaElement).value).toBe(generated.brief);
    expect(button().disabled).toBe(true);
  });

  it("有已保存档案时生成与保存期间仍禁用按钮，结束后恢复", async () => {
    const archive = { ...emptySummary(), responsibilities: "联调职责" };
    await setup(archive);
    const streaming = Promise.withResolvers<void>();
    requests.stream.mockReturnValueOnce(streaming.promise);
    fireEvent.click(button());
    expect(button().disabled).toBe(true);
    await act(async () => { streaming.resolve(); });
    expect(button().disabled).toBe(false);
    const saving = Promise.withResolvers<unknown>();
    requests.json.mockReturnValueOnce(saving.promise);
    fireEvent.click(screen.getByRole("button", { name: "保存总结修改" }));
    expect(button().disabled).toBe(true);
    await act(async () => { saving.resolve({ revisionId: 1, summary: archive }); });
    await waitFor(() => expect(button().disabled).toBe(false));
  });
});
