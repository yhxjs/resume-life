// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptySummary } from "@/lib/summary";
import { compareProjectSummaries } from "@/lib/project-summary-diff";
import type { SseOptions } from "@/lib/fetch-sse";
import { useProjectDetail } from "../use-project-detail";
import ProjectDetailPage from "../page";

const requests = vi.hoisted(() => ({ json: vi.fn(), stream: vi.fn(), id: "1" }));
vi.mock("@/lib/fetcher", async importOriginal => ({ ...await importOriginal<object>(), jsonFetch: requests.json }));
vi.mock("@/lib/fetch-sse", () => ({ fetchSse: requests.stream }));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: requests.id }) }));
vi.mock("../project-summary-history", () => ({ ProjectSummaryHistory: () => null }));
vi.mock("../directory-picker-dialog", () => ({ DirectoryPickerDialog: () => null }));

const first = { id: 1, name: "甲项目", summary: emptySummary(), summary_updated_at: "", summary_revision_id: 0, materials: [] };
const second = { ...first, id: 2, name: "乙项目", summary: { ...emptySummary(), overview: "乙项目原档案" } };
const draft = (text: string) => {
  const summary = { ...emptySummary(), overview: text, brief: `${text}介绍` };
  return { summary, comparison: compareProjectSummaries(emptySummary(), summary, {}), materialChanges: [], materialFingerprint: "a".repeat(64), revisionId: 0 };
};

beforeEach(() => {
  requests.id = "1";
  requests.json.mockReset().mockResolvedValue(first);
  requests.stream.mockReset();
});
afterEach(cleanup);

describe("项目页面会话隔离", () => {
  it.each(["pending", "finished"])("甲项目草稿%s，切换项目时立即隐藏旧内容，不向乙提交甲草稿", async phase => {
    const view = render(<ProjectDetailPage />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "项目概述" })).toBeTruthy());
    const completion = Promise.withResolvers<void>();
    requests.stream.mockImplementationOnce(async (_url, options) => {
      if (phase === "pending") await completion.promise;
      await options.onDone(draft("甲项目 AI 草稿"));
    });
    fireEvent.click(screen.getByRole("button", { name: /生成 AI STAR 总结/ }));
    if (phase === "finished") await waitFor(() => expect(screen.getByText("AI 草稿待确认：")).toBeTruthy());
    const loading = Promise.withResolvers<typeof second>();
    requests.json.mockReturnValueOnce(loading.promise);
    requests.id = "2";
    view.rerender(<ProjectDetailPage />);
    // 新项目未读完时不能继续提供旧草稿的保存／生成入口。
    expect(screen.queryByRole("textbox", { name: "项目概述" })).toBeNull();
    expect(screen.queryByText("AI 草稿待确认：")).toBeNull();
    expect(screen.queryByRole("button", { name: "确认采用入库" })).toBeNull();
    await act(async () => { loading.resolve(second); completion.resolve(); });
    await waitFor(() => expect(screen.getByRole("heading", { name: "乙项目" })).toBeTruthy());
    expect((screen.getByRole("textbox", { name: "项目概述" }) as HTMLTextAreaElement).value).toBe(second.summary.overview);
    expect(screen.queryByText("AI 草稿待确认：")).toBeNull();
    expect(requests.json.mock.calls.some(([, options]) => options?.method === "PATCH")).toBe(false);
  });

  it("甲项目手动清空记录和扫描弹窗不能使乙项目跳过首次预选或自动打开扫描", async () => {
    const view = render(<ProjectDetailPage />);
    await waitFor(() => expect(screen.getByRole("textbox", { name: "项目概述" })).toBeTruthy());
    fireEvent.change(screen.getByRole("textbox", { name: "项目概述" }), { target: { value: "甲项目手动内容" } });
    fireEvent.change(screen.getByRole("textbox", { name: "项目概述" }), { target: { value: "" } });
    requests.json.mockResolvedValueOnce({ codex: { available: true }, claude: { available: false }, recommended: "codex" });
    fireEvent.click(screen.getByRole("button", { name: /扫描本地代码仓库/ }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    requests.id = "2";
    requests.json.mockResolvedValue(second);
    view.rerender(<ProjectDetailPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "乙项目" })).toBeTruthy());
    expect(screen.queryByRole("dialog")).toBeNull();
    requests.stream.mockImplementationOnce(async (_url, options) => { await options.onDone(draft("乙项目 AI 草稿")); });
    fireEvent.click(screen.getByRole("button", { name: /生成 AI STAR 总结/ }));
    await waitFor(() => expect((screen.getByRole("textbox", { name: "项目概述" }) as HTMLTextAreaElement).value).toBe("乙项目 AI 草稿"));
  });

  it.each(["success", "failure"] as const)("甲项目保存%s晚到，不刷新甲项目或解除乙项目正在保存的锁", async outcome => {
    const writes: { url: string; body: { summary: ReturnType<typeof emptySummary> } }[] = [];
    const oldSave = Promise.withResolvers<unknown>();
    const newSave = Promise.withResolvers<unknown>();
    let currentSecond = second;
    requests.json.mockImplementation((url, options) => {
      if (options?.method === "PATCH") {
        writes.push({ url, body: JSON.parse(options.body) });
        return url === "/api/projects/1" ? oldSave.promise : newSave.promise;
      }
      return Promise.resolve(url === "/api/projects/1" ? first : currentSecond);
    });
    const view = render(<ProjectDetailPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "甲项目" })).toBeTruthy());
    fireEvent.change(screen.getByRole("textbox", { name: "项目概述" }), { target: { value: "甲项目提交稿" } });
    fireEvent.click(screen.getByRole("button", { name: "保存总结修改" }));
    expect(writes).toHaveLength(1);
    requests.id = "2";
    view.rerender(<ProjectDetailPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "乙项目" })).toBeTruthy());
    fireEvent.change(screen.getByRole("textbox", { name: "项目概述" }), { target: { value: "乙项目提交稿" } });
    fireEvent.click(screen.getByRole("button", { name: "保存总结修改" }));
    expect(writes.map(write => write.url)).toEqual(["/api/projects/1", "/api/projects/2"]);
    expect(writes.map(write => write.body.summary.overview)).toEqual(["甲项目提交稿", "乙项目提交稿"]);
    const callsBefore = requests.json.mock.calls.length;
    await act(async () => {
      if (outcome === "success") oldSave.resolve({ ok: true, revisionId: 1, summary: writes[0]!.body.summary });
      else oldSave.reject(new Error("甲项目旧保存失败"));
    });
    expect(requests.json).toHaveBeenCalledTimes(callsBefore);
    expect((screen.getByRole("button", { name: "保存总结修改" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(/甲项目旧保存失败/)).toBeNull();
    currentSecond = { ...second, summary: writes[1]!.body.summary, summary_revision_id: 2 };
    await act(async () => { newSave.resolve({ ok: true, revisionId: 2, summary: currentSecond.summary }); });
    await waitFor(() => expect(screen.getByText("总结已保存")).toBeTruthy());
    expect((screen.getByRole("button", { name: "保存总结修改" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("textbox", { name: "项目概述" }) as HTMLTextAreaElement).value).toBe("乙项目提交稿");
  });

  it("乙项目读取失败时不展示甲草稿，重试及返回甲项目均创建独立会话", async () => {
    const view = render(<ProjectDetailPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "甲项目" })).toBeTruthy());
    requests.stream.mockImplementationOnce(async (_url, options) => { await options.onDone(draft("甲项目未保存稿")); });
    fireEvent.click(screen.getByRole("button", { name: /生成 AI STAR 总结/ }));
    await waitFor(() => expect(screen.getByText("AI 草稿待确认：")).toBeTruthy());
    requests.id = "2";
    requests.json.mockRejectedValueOnce(new Error("乙项目暂不可读"));
    view.rerender(<ProjectDetailPage />);
    await waitFor(() => expect(screen.getByText("乙项目暂不可读")).toBeTruthy());
    expect(screen.queryByRole("textbox", { name: "项目概述" })).toBeNull();
    requests.json.mockResolvedValue(second);
    fireEvent.click(screen.getByRole("button", { name: /重试/ }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "乙项目" })).toBeTruthy());
    requests.id = "1";
    requests.json.mockResolvedValue(first);
    view.rerender(<ProjectDetailPage />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "甲项目" })).toBeTruthy());
    expect((screen.getByRole("textbox", { name: "项目概述" }) as HTMLTextAreaElement).value).toBe("");
    expect(screen.queryByText("AI 草稿待确认：")).toBeNull();
    expect(screen.queryByText("乙项目暂不可读")).toBeNull();
  });
});

describe("材料总结回调归属", () => {
  it.each(["done", "error", "delta"] as const)("新生成开始后忽略旧生成的%s回调并保留新一轮状态", async event => {
    const hook = renderHook(() => useProjectDetail("1"));
    await waitFor(() => expect(hook.result.current.data?.id).toBe(1));
    const completions = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const callbacks: SseOptions<unknown>[] = [];
    requests.stream.mockImplementation((_url, options) => { callbacks.push(options); return completions[callbacks.length - 1]!.promise; });
    let old!: Promise<void>;
    let current!: Promise<void>;
    act(() => { old = hook.result.current.summary.summarize(); });
    act(() => { current = hook.result.current.summary.summarize("resume-only"); });
    const status = hook.result.current.summary.sumStatus;
    await act(async () => {
      if (event === "done") await callbacks[0]!.onDone?.(draft("旧草稿"));
      else if (event === "error") callbacks[0]!.onError?.(new Error("旧生成错误"));
      else { callbacks[0]!.onDelta?.("旧生成正文"); hook.result.current.summary.typewriter.flush(); }
      completions[0]!.resolve();
      await old;
    });
    expect(callbacks[0]!.signal?.aborted).toBe(true);
    expect(hook.result.current.summary.sumStatus).toEqual(status);
    expect(hook.result.current.summary.proposal).toBeNull();
    expect(hook.result.current.summary.pendingDraft).toBe(false);
    expect(hook.result.current.summary.typewriter.displayedText).toBe("");
    expect(hook.result.current.summary.summarizing).toBe(true);
    await act(async () => { await callbacks[1]!.onDone?.(draft("当前草稿")); completions[1]!.resolve(); await current; });
    expect(hook.result.current.summary.proposal?.summary.overview).toBe("当前草稿");
    expect(hook.result.current.summary.summarizing).toBe(false);
  });

  it("卸载后保留的生成、保存和扫描回调不会发起请求或校验旧坏回包", async () => {
    const hook = renderHook(() => useProjectDetail("1"));
    await waitFor(() => expect(hook.result.current.data?.id).toBe(1));
    const completion = Promise.withResolvers<void>();
    let callback!: SseOptions<unknown>;
    requests.stream.mockImplementationOnce((_url, options) => { callback = options; return completion.promise; });
    let pending!: Promise<void>;
    act(() => { pending = hook.result.current.summary.summarize(); });
    const savedActions = hook.result.current.summary;
    hook.unmount();
    expect(callback.signal?.aborted).toBe(true);
    await act(async () => {
      expect(() => callback.onDone?.(null)).not.toThrow();
      await savedActions.summarize();
      await savedActions.saveSummary();
      savedActions.applyDraft({ ...draft("旧扫描"), source: "repo" });
      completion.resolve();
      await pending;
    });
    expect(requests.stream).toHaveBeenCalledOnce();
    expect(requests.json).toHaveBeenCalledOnce();
  });
});
