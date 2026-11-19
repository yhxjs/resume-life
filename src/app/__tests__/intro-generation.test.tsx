// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SseServerError, type SseOptions } from "@/lib/fetch-sse";
import { HttpError } from "@/lib/fetcher";

const state = vi.hoisted(() => ({
  stream: vi.fn(), push: vi.fn(), reload: vi.fn(),
  resumes: [{ id: 1, title: "参考简历", updated_at: "", versions: [{ id: 11, version: 1, name: "发布版" }] },
    { id: 2, title: "第二简历", updated_at: "", versions: [{ id: 22, version: 1, name: "第二版" }] }],
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock("@/lib/fetch-sse", async original => ({ ...await original<typeof import("@/lib/fetch-sse")>(), fetchSse: state.stream }));
vi.mock("@/hooks/use-resume-options", () => ({ useResumeOptions: () => ({ resumes: state.resumes, resumesError: "", reloadResumes: vi.fn() }) }));
vi.mock("@/hooks/use-cursor-list", () => ({ useCursorList: () => ({ items: [], total: 0, nextCursor: null, loadingMore: false, listError: "", failedCursor: null, loadMore: vi.fn(), reload: state.reload }) }));
import IntrosPage from "@/app/intros/page";

beforeEach(() => { state.stream.mockReset(); state.push.mockReset(); state.reload.mockReset(); });
afterEach(cleanup);

async function prepare() {
  render(<IntrosPage />);
  const jd = screen.getByRole("textbox", { name: "目标岗位要求（JD / 职位描述）" });
  fireEvent.change(jd, { target: { value: "  只参与参数校验 <T> &amp;\n尚未上线  " } });
  const button = screen.getByRole("button", { name: "立即生成两版自我介绍" });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  return button;
}

it("生成说明与实际依据一致，重复触发只发起一次且不展示未校验片段", async () => {
  const button = await prepare();
  const pending = Promise.withResolvers<void>();
  state.stream.mockImplementationOnce(async (_url: string, options: SseOptions<unknown>) => {
    options.onDelta?.('{"versions":[{"text":"未经校验的模型片段"');
    await pending.promise;
    await options.onDone?.({ id: 17 });
  });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(state.stream).toHaveBeenCalledTimes(1);
  expect(state.stream.mock.calls[0]![1].body).toEqual({ resume_id: 1, resume_version_id: 11, jd: "只参与参数校验 <T> &amp;\n尚未上线" });
  expect(screen.getByRole("status").textContent).toContain("完整校验并保存后进入演练页");
  expect(screen.queryByText(/未经校验的模型片段/)).toBeNull();
  expect(screen.queryByText(/架构亮点，主动引导/)).toBeNull();
  expect(screen.getByText(/没有量化结果时保留定性描述/)).toBeTruthy();
  expect(screen.getByText(/遮罩会模糊整句/)).toBeTruthy();
  await act(async () => pending.resolve());
  expect(state.push).toHaveBeenCalledExactlyOnceWith("/intros/17");
  fireEvent.click(screen.getByRole("button", { name: "AI 正在构思双版自我介绍…" }));
  expect(state.stream).toHaveBeenCalledTimes(1);
});

it.each([null, {}, { id: 0 }, { id: -1 }, { id: "17" }, { id: 1.5 }])("无效完成响应不导航，刷新历史并保留输入（%j）", async (result) => {
  const button = await prepare();
  state.stream.mockImplementationOnce(async (_url: string, options: SseOptions<unknown>) => { await options.onDone?.(result); });
  fireEvent.click(button);
  await screen.findByRole("alert");
  expect(state.push).not.toHaveBeenCalled();
  expect(state.reload).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("alert").textContent).toContain("请先核对历史再重新生成");
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("  只参与参数校验 <T> &amp;\n尚未上线  ");
  expect((screen.getByRole("button", { name: "立即生成两版自我介绍" }) as HTMLButtonElement).disabled).toBe(false);
});

it("生成失败后可显式重试，离开页面后旧完成不导航或刷新", async () => {
  const button = await prepare();
  state.stream.mockRejectedValueOnce(new Error("合成生成失败"));
  fireEvent.click(button);
  await screen.findByText("合成生成失败");
  const pending = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined;
  state.stream.mockImplementationOnce(async (_url: string, options: SseOptions<unknown>) => {
    signal = options.signal;
    await pending.promise;
    await options.onDone?.({ id: 18 });
  });
  fireEvent.click(screen.getByRole("button", { name: "立即生成两版自我介绍" }));
  expect(state.stream).toHaveBeenCalledTimes(2);
  cleanup();
  expect(signal?.aborted).toBe(true);
  await act(async () => pending.resolve());
  expect(state.push).not.toHaveBeenCalled();
  expect(state.reload).toHaveBeenCalledTimes(1);
});

it.each([
  ...[400, 404, 409, 413, 415, 422, 429].map(status => ({ label: `HTTP ${status}`, failure: new HttpError("请重新核对所选材料", status) })),
  { label: "服务端 SSE 失败", failure: new SseServerError("请重新核对所选材料") },
])("明确 $label 拒绝保留原因与草稿，不混用响应丢失说明", async ({ failure }) => {
  const button = await prepare();
  state.stream.mockRejectedValueOnce(failure);
  fireEvent.click(button);
  const error = await screen.findByRole("alert");
  expect(error.textContent).toContain("请重新核对所选材料");
  expect(error.textContent).not.toContain("仍可能已保存");
  expect(error.textContent).toContain("请按上方提示处理后再生成");
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("  只参与参数校验 <T> &amp;\n尚未上线  ");
  expect(state.reload).toHaveBeenCalledTimes(1);
  expect(state.stream).toHaveBeenCalledTimes(1);
  expect(state.push).not.toHaveBeenCalled();
});

it("新请求清除旧失败提示，不把上次明确拒绝沿用到本次未知结果", async () => {
  const button = await prepare();
  state.stream.mockRejectedValueOnce(new SseServerError("材料已变化"));
  fireEvent.click(button);
  expect((await screen.findByRole("alert")).textContent).not.toContain("仍可能已保存");
  const pending = Promise.withResolvers<void>();
  state.stream.mockReturnValueOnce(pending.promise);
  fireEvent.click(screen.getByRole("button", { name: "立即生成两版自我介绍" }));
  expect(screen.queryByRole("alert")).toBeNull();
  await act(async () => pending.reject(new Error("流式响应中断")));
  expect(screen.getByRole("alert").textContent).toContain("仍可能已保存");
  expect(state.stream).toHaveBeenCalledTimes(2);
});

it.each([new HttpError("等待超时", 408), new HttpError("服务不可用", 503), new Error("网络断开"), new Error("流式响应事件格式无效")])("未知失败仍提示核对历史，保留原因且不自动重发 %#", async failure => {
  const button = await prepare();
  state.stream.mockRejectedValueOnce(failure);
  fireEvent.click(button);
  const error = await screen.findByRole("alert");
  expect(error.textContent).toContain(failure.message);
  expect(error.textContent).toContain("仍可能已保存");
  expect(state.stream).toHaveBeenCalledTimes(1);
  expect(state.push).not.toHaveBeenCalled();
});

it("列表刷新保留仍存在的简历选择及绑定发布版", async () => {
  const { rerender } = render(<IntrosPage />);
  const select = screen.getByRole("combobox", { name: "选择参考简历" });
  fireEvent.change(select, { target: { value: "2" } });
  state.resumes = [...state.resumes];
  rerender(<IntrosPage />);
  await waitFor(() => expect((select as HTMLSelectElement).value).toBe("2"));
});
