// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptySummary } from "@/lib/summary";
import { compareProjectSummaries } from "@/lib/project-summary-diff";
import { useProjectDetail } from "../use-project-detail";
import { ScanRepoModal } from "../scan-repo-modal";

const requests = vi.hoisted(() => ({ json: vi.fn(), stream: vi.fn() }));
vi.mock("@/lib/fetcher", () => ({ jsonFetch: requests.json }));
vi.mock("@/lib/fetch-sse", () => ({ fetchSse: requests.stream }));
vi.mock("../directory-picker-dialog", () => ({ DirectoryPickerDialog: () => null }));

const project = { id: 1, name: "项目", summary: { ...emptySummary(), overview: "已保存的定位" }, summary_updated_at: "saved", summary_revision_id: 2, materials: [] };
const generated = { ...emptySummary(), overview: "草稿定位 <T> &amp;", brief: "参与接口校验" };
const valid = () => ({ summary: generated, comparison: compareProjectSummaries(project.summary, generated, {}), materialChanges: [], materialFingerprint: "a".repeat(64), revisionId: 2 });
const invalid = [
  ["残缺总结", () => ({ ...valid(), summary: { overview: "残缺内容不能补空" } })],
  ["缺少版本", () => ({ ...valid(), revisionId: undefined })],
  ["错误指纹", () => ({ ...valid(), materialFingerprint: "错误指纹" })],
  ["差异与正文不符", () => ({ ...valid(), comparison: [{ ...valid().comparison[0], next: "与正文不同的预览" }] })],
  ["材料身份错误", () => ({ ...valid(), materialChanges: [{ id: "1", title: "材料", status: "new" }] })],
] as const;

beforeEach(() => {
  requests.json.mockReset().mockImplementation(async (url: string) => url.endsWith("/scan-repo")
    ? { codex: { available: true }, claude: { available: false }, recommended: "codex" } : project);
  requests.stream.mockReset();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe.each(["full", "resume-only"] as const)("%s 草稿回包校验", mode => {
  it.each(invalid)("%s 不替换手动草稿或已有有效提案，可显式重试", async (_label, value) => {
    const hook = renderHook(() => useProjectDetail("1"));
    await waitFor(() => expect(hook.result.current.data?.id).toBe(1));
    act(() => {
      hook.result.current.summary.applyDraft({ ...valid(), source: "ai" });
      hook.result.current.summary.updateSummaryField("responsibilities", "本人更正：未参与上线");
      hook.result.current.summary.toggleAdoption("brief");
    });
    const before = { draft: hook.result.current.summary.summaryDraft, proposal: hook.result.current.summary.proposal, selected: hook.result.current.summary.selectedKeys };
    requests.stream.mockImplementationOnce(async (_url, options) => { await options.onDone(value()); });
    await act(async () => { await hook.result.current.summary.summarize(mode); });
    expect(hook.result.current.summary.sumStatus).toMatchObject({ kind: "err", text: expect.stringContaining("草稿响应") });
    expect(hook.result.current.summary.summaryDraft).toEqual(before.draft);
    expect(hook.result.current.summary.proposal).toEqual(before.proposal);
    expect(hook.result.current.summary.selectedKeys).toEqual(before.selected);
    expect(hook.result.current.summary.pendingDraft).toBe(true);
    expect(requests.json.mock.calls.every(([, options]) => !options?.method || options.method === "GET")).toBe(true);
    requests.stream.mockImplementationOnce(async (_url, options) => { await options.onDone(valid()); });
    await act(async () => { await hook.result.current.summary.summarize(mode); });
    expect(hook.result.current.summary.sumStatus?.kind).toBe("warn");
    expect(hook.result.current.summary.summaryDraft?.responsibilities).toBe("本人更正：未参与上线");
    expect(requests.stream).toHaveBeenCalledTimes(2);
  });
});

describe("源码扫描草稿回包校验", () => {
  it.each(invalid)("%s 不关闭弹窗或回填坏草稿，原路径保留并可重试", async (_label, value) => {
    const onSuccess = vi.fn();
    const onClose = vi.fn();
    render(<ScanRepoModal open projectId={1} projectName="项目" repoPaths={["D:\\synthetic\\repo"]} onSuccess={onSuccess} onClose={onClose} />);
    await waitFor(() => expect(requests.json).toHaveBeenCalledTimes(1));
    vi.useFakeTimers();
    requests.stream.mockImplementationOnce(async (_url, options) => { await options.onDone(value()); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "开始扫描并提炼" })); });
    act(() => vi.advanceTimersByTime(400));
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(/草稿响应/)).toBeTruthy();
    expect(screen.getByText("D:\\synthetic\\repo")).toBeTruthy();
    requests.stream.mockImplementationOnce(async (_url, options) => { await options.onDone(valid()); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "开始扫描并提炼" })); });
    act(() => vi.advanceTimersByTime(400));
    expect(onSuccess).toHaveBeenCalledOnce();
    expect(onSuccess).toHaveBeenCalledWith(valid(), "D:\\synthetic\\repo", []);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
