// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import { getResumeSaveQueue } from "@/lib/resume-save-queue";
import type { ResumeVersion } from "@/lib/resume-version-types";
import { PublishVersionButton } from "../publish-version-button";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/fetcher", async original => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
vi.mock("@/lib/resume-save-queue", () => ({ getResumeSaveQueue: vi.fn() }));

const revision = "a".repeat(64);
const version = { id: 12, resume_id: 7, version: 1, parent_id: null, name: "发布测试", description: "说明", created_at: "2026-11-03", snapshot: {} };
const drain = vi.fn(); const read = vi.fn(); const post = vi.fn();
beforeEach(() => {
  drain.mockResolvedValue(undefined); read.mockResolvedValue({ draft_revision: revision }); post.mockResolvedValue(version);
  vi.mocked(getResumeSaveQueue).mockReturnValue({ drain } as unknown as ReturnType<typeof getResumeSaveQueue>);
  vi.mocked(jsonFetch).mockImplementation((url, options) => options?.method === "POST" ? post(url, options) : read(url, options));
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });
function setup(onPublished?: (value: ResumeVersion) => void) {
  const result = render(<StrictMode><PublishVersionButton resumeId="7" onPublished={onPublished} /></StrictMode>);
  fireEvent.click(screen.getByRole("button", { name: "发布新版本" }));
  fireEvent.change(screen.getByRole("textbox", { name: /版本名称/ }), { target: { value: " 发布测试 " } });
  fireEvent.change(screen.getByRole("textbox", { name: /修改说明/ }), { target: { value: " 说明 " } });
  const form = screen.getByRole("button", { name: "确认发布" }).closest("form")!;
  return { ...result, form };
}

describe("发布版本的命令与页面归属", () => {
  it("同一事件重复提交只排空、读取和发布一次，导航完成前不能重发", async () => {
    const page = setup(); act(() => { fireEvent.submit(page.form); fireEvent.submit(page.form); });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/resumes/7/versions?version=12"));
    expect(drain).toHaveBeenCalledOnce(); expect(read).toHaveBeenCalledOnce(); expect(post).toHaveBeenCalledOnce();
    expect(JSON.parse(post.mock.calls[0]![1].body)).toEqual({ name: "发布测试", description: "说明", draft_revision: revision });
    fireEvent.click(screen.getByRole("button", { name: "发布新版本" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("提交同一事件内取消不能关闭已开始的发布", async () => {
    const pending = Promise.withResolvers<void>(); drain.mockReturnValueOnce(pending.promise);
    const page = setup(); const cancel = screen.getByRole("button", { name: "取消" });
    act(() => { fireEvent.submit(page.form); fireEvent.click(cancel); });
    expect(screen.getByRole("dialog", { name: "发布简历版本" })).toBeTruthy();
    page.unmount(); await act(async () => { pending.resolve(); }); expect(post).not.toHaveBeenCalled();
  });
  it("先取消再在同一事件提交旧表单不发布，重新打开保留输入", async () => {
    const page = setup(); act(() => { fireEvent.click(screen.getByRole("button", { name: "取消" })); fireEvent.submit(page.form); });
    await act(async () => {}); expect(drain).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "发布新版本" }));
    expect((screen.getByRole("textbox", { name: /版本名称/ }) as HTMLInputElement).value).toBe(" 发布测试 ");
  });
  it("排空自动保存期间离页不读取或发布，保存仍可完成", async () => {
    const pending = Promise.withResolvers<void>(); drain.mockReturnValueOnce(pending.promise);
    const page = setup(); fireEvent.submit(page.form); page.unmount();
    await act(async () => { pending.resolve(); });
    expect(read).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled(); expect(push).not.toHaveBeenCalled();
  });
  it("草稿校验读取期间离页，迟到读取不再发布", async () => {
    const pending = Promise.withResolvers<unknown>(); read.mockReturnValueOnce(pending.promise);
    const page = setup(); fireEvent.submit(page.form); await waitFor(() => expect(read).toHaveBeenCalledOnce());
    const signal = read.mock.calls[0]![1]?.signal as AbortSignal | undefined; page.unmount();
    await act(async () => { pending.resolve({ draft_revision: revision }); });
    expect(post).not.toHaveBeenCalled(); expect(signal?.aborted).toBe(true); expect(push).not.toHaveBeenCalled();
  });
  for (const withCallback of [false, true]) it(`已发送后离页，迟到成功不${withCallback ? "调用旧发布回调" : "跳转旧版本树"}`, async () => {
    const pending = Promise.withResolvers<unknown>(); post.mockReturnValueOnce(pending.promise); const published = vi.fn();
    const page = setup(withCallback ? published : undefined); fireEvent.submit(page.form); await waitFor(() => expect(post).toHaveBeenCalledOnce());
    const signal = post.mock.calls[0]![1].signal as AbortSignal | undefined; page.unmount();
    await act(async () => { pending.resolve(version); });
    expect(push).not.toHaveBeenCalled(); expect(published).not.toHaveBeenCalled(); expect(signal?.aborted).toBe(true);
  });
  it("旧发布失败不修改重新进入后的输入，旧命令不能释放新命令", async () => {
    const pending = Promise.withResolvers<unknown>(); post.mockReturnValueOnce(pending.promise);
    const old = setup(); fireEvent.submit(old.form); await waitFor(() => expect(post).toHaveBeenCalledOnce()); old.unmount();
    const currentRead = Promise.withResolvers<unknown>(); read.mockReturnValueOnce(currentRead.promise);
    const next = setup(); fireEvent.change(screen.getByRole("textbox", { name: /版本名称/ }), { target: { value: "新会话原稿" } });
    fireEvent.submit(next.form); await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await act(async () => { pending.reject(new Error("旧发布失败")); });
    expect(screen.queryByText("旧发布失败")).toBeNull();
    expect((screen.getByRole("textbox", { name: /版本名称/ }) as HTMLInputElement).value).toBe("新会话原稿");
    expect((screen.getByRole("button", { name: "正在保存并发布…" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { currentRead.resolve({ draft_revision: revision }); });
    expect(post).toHaveBeenCalledTimes(2); expect(push).toHaveBeenCalledOnce();
  });
  it("保存或校验失败保留输入，用户再次提交才重试；成功回调后可发布下一版", async () => {
    const published = vi.fn(); drain.mockRejectedValueOnce(new Error("自动保存失败")); const page = setup(published);
    fireEvent.submit(page.form); await screen.findByText("自动保存失败"); expect(read).not.toHaveBeenCalled(); expect(post).not.toHaveBeenCalled();
    read.mockRejectedValueOnce(new Error("草稿读取失败")); fireEvent.submit(page.form); await screen.findByText("草稿读取失败");
    expect(post).not.toHaveBeenCalled(); expect((screen.getByRole("textbox", { name: /版本名称/ }) as HTMLInputElement).value).toBe(" 发布测试 ");
    fireEvent.submit(page.form); await waitFor(() => expect(published).toHaveBeenCalledWith(version)); expect(push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "发布新版本" }));
    const dialog = screen.getByRole("dialog", { name: "发布简历版本" });
    expect((within(dialog).getByRole("textbox", { name: /版本名称/ }) as HTMLInputElement).value).toBe("");
    expect((within(dialog).getByRole("textbox", { name: /修改说明/ }) as HTMLTextAreaElement).value).toBe("");
    fireEvent.change(within(dialog).getByRole("textbox", { name: /版本名称/ }), { target: { value: "第二版" } });
    fireEvent.submit(within(dialog).getByRole("button", { name: "确认发布" }).closest("form")!);
    await waitFor(() => expect(published).toHaveBeenCalledTimes(2)); expect(post).toHaveBeenCalledTimes(2);
  });
  it("发布被草稿冲突拒绝后保留原稿，重新确认才读取新基准并提交", async () => {
    const published = vi.fn(); post.mockRejectedValueOnce(new HttpError("简历已在其他页面修改，请刷新后重新操作", 409));
    const page = setup(published); fireEvent.submit(page.form);
    await screen.findByText("简历已在其他页面修改，请刷新后重新操作"); expect(published).not.toHaveBeenCalled(); expect(push).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox", { name: /版本名称/ }) as HTMLInputElement).value).toBe(" 发布测试 ");
    expect((screen.getByRole("textbox", { name: /修改说明/ }) as HTMLTextAreaElement).value).toBe(" 说明 ");
    expect(post).toHaveBeenCalledOnce(); read.mockResolvedValueOnce({ draft_revision: "b".repeat(64) });
    fireEvent.submit(page.form); await waitFor(() => expect(published).toHaveBeenCalledOnce());
    expect(JSON.parse(post.mock.calls[1]![1].body).draft_revision).toBe("b".repeat(64)); expect(post).toHaveBeenCalledTimes(2);
  });
});
