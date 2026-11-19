// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfirmDialogHost, confirmDialog } from "@/components/common/confirm-dialog";
import { jsonFetch } from "@/lib/fetcher";
import { getResumeSaveQueue } from "@/lib/resume-save-queue";
import { ResumeVersionsPage } from "../resume-versions-page";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
vi.mock("@/lib/resume-save-queue", () => ({ getResumeSaveQueue: vi.fn() }));
vi.mock("../doc", () => ({ ResumeDoc: () => <div>预览</div> }));
vi.mock("../doc-data", () => ({ prepare: vi.fn() }));
vi.mock("../resume-version-diff", () => ({ ResumeVersionDiff: () => <div>对照</div> }));
vi.mock("../publish-version-button", () => ({ PublishVersionButton: () => null }));

const versions = [2, 1].map(id => ({ id, resume_id: 7, version: id, parent_id: null, name: `版本${id}`, description: "", created_at: "2026-11-03" }));
const post = vi.fn(); const drain = vi.fn();
beforeEach(() => {
  window.history.replaceState(null, "", "/resumes/7/versions");
  drain.mockResolvedValue(undefined); post.mockResolvedValue({ resume: { id: 7 }, modules: [] });
  vi.mocked(getResumeSaveQueue).mockReturnValue({ drain } as unknown as ReturnType<typeof getResumeSaveQueue>);
  vi.mocked(jsonFetch).mockImplementation(async (url, options) => {
    if (options?.method === "POST") return post(url, options);
    return (url.endsWith("/versions") ? { versions, base_version_id: null, draft_revision: "a".repeat(64) } : { snapshot: { modules: [] } }) as never;
  });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });
async function setup() {
  render(<ConfirmDialogHost />);
  const page = render(<ResumeVersionsPage resumeId="7" />);
  await screen.findByRole("heading", { name: "v2 · 版本2" });
  return page;
}
const start = () => fireEvent.click(screen.getByRole("button", { name: "从此版本开始分支" }));
const accept = () => fireEvent.click(screen.getByRole("button", { name: "替换草稿并开始编辑" }));

describe("版本分支确认归属", () => {
  it("确认阶段离页关闭旧框，不覆盖草稿", async () => {
    const page = await setup(); start(); page.unmount();
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => {}); expect(post).not.toHaveBeenCalled();
  });
  it("移除本页排队确认并保留其他有效操作", async () => {
    const page = await setup();
    act(() => { void confirmDialog({ title: "其他操作", message: "保留此项" }); });
    start(); page.unmount();
    fireEvent.click(screen.getByRole("button", { name: "确定" }));
    expect(screen.queryByRole("dialog")).toBeNull(); expect(post).not.toHaveBeenCalled();
  });
  it("同一事件重复点击只确认一次并提交一次，导航完成前保持互斥", async () => {
    await setup(); act(() => { start(); start(); start(); }); accept();
    await waitFor(() => expect(push).toHaveBeenCalledWith("/resumes/7"));
    expect(screen.queryByRole("dialog")).toBeNull(); expect(post).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "正在准备草稿…" }).hasAttribute("disabled")).toBe(true);
  });
  it("同一事件确认后卸载，不再开始等待或提交", async () => {
    const page = await setup(); drain.mockClear(); start();
    act(() => { accept(); page.unmount(); });
    await act(async () => {}); expect(drain).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
  });
  it("排空共享保存期间离页不提交分支，也不取消保存队列", async () => {
    const page = await setup(); const pending = Promise.withResolvers<void>(); drain.mockReturnValueOnce(pending.promise);
    start(); accept(); await waitFor(() => expect(drain).toHaveBeenCalledTimes(2)); page.unmount();
    await act(async () => { pending.resolve(); });
    expect(post).not.toHaveBeenCalled(); expect(push).not.toHaveBeenCalled();
  });
  for (const failure of [false, true]) it(`已送出分支离页后的迟到${failure ? "失败" : "成功"}不跳转或显示旧错误`, async () => {
    const page = await setup(); const pending = Promise.withResolvers<unknown>(); post.mockReturnValueOnce(pending.promise);
    start(); accept(); await waitFor(() => expect(post).toHaveBeenCalledOnce());
    const signal = post.mock.calls[0]![1].signal as AbortSignal | undefined; page.unmount();
    await act(async () => { if (failure) pending.reject(new Error("旧分支失败")); else pending.resolve({}); });
    expect(push).not.toHaveBeenCalled(); expect(screen.queryByText("旧分支失败")).toBeNull();
    expect(signal?.aborted).toBe(true);
  });
  it("取消和明确失败后可重新确认，提交沿用确认时的版本和草稿基准", async () => {
    await setup(); const trigger = screen.getByRole("button", { name: "从此版本开始分支" }); trigger.focus();
    start(); await act(async () => { fireEvent.click(screen.getByRole("button", { name: "取消" })); });
    expect(document.activeElement).toBe(trigger);
    await act(async () => {}); expect(post).not.toHaveBeenCalled();
    const pending = Promise.withResolvers<void>(); drain.mockReturnValueOnce(pending.promise);
    post.mockRejectedValueOnce(new Error("草稿已更新，请重新读取"));
    start(); accept(); await waitFor(() => expect(drain).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: /v1.*版本1/ }));
    await act(async () => { pending.resolve(); });
    await screen.findByText("草稿已更新，请重新读取");
    expect(post.mock.calls[0]![0]).toBe("/api/resumes/7/versions/2/branch");
    expect(JSON.parse(post.mock.calls[0]![1].body)).toEqual({ draft_revision: "a".repeat(64) });
    start(); expect(screen.getByRole("dialog").textContent).toContain("从 v1 开始分支"); accept();
    await waitFor(() => expect(push).toHaveBeenCalledOnce()); expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1]![0]).toBe("/api/resumes/7/versions/1/branch");
  });
});
