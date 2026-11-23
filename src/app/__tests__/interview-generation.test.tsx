// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { SseServerError, type SseOptions } from "@/lib/fetch-sse";
import { HttpError } from "@/lib/fetcher";
import { INTERVIEW_QUESTION_GRAPH_DRAFT_KEY } from "@/lib/interview-question-graph-draft";
import type { InterviewStartForm } from "@/components/interviews/interview-start-form";

type FormProps = ComponentProps<typeof InterviewStartForm>;
const state = vi.hoisted(() => ({
  stream: vi.fn(), push: vi.fn(), reload: vi.fn(), append: vi.fn(), flush: vi.fn(), reset: vi.fn(),
  form: null as FormProps | null,
  canDelete: true,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: state.push }), useSearchParams: () => new URLSearchParams({ jd: "  仅做接口联调 <T> &amp;\n尚未上线  " }) }));
vi.mock("@/lib/fetch-sse", async original => ({ ...await original<typeof import("@/lib/fetch-sse")>(), fetchSse: state.stream }));
vi.mock("@/hooks/use-typewriter", () => ({ useTypewriter: () => ({ displayedText: "", isTyping: false, appendDelta: state.append, flush: state.flush, reset: state.reset }) }));
vi.mock("@/hooks/use-interviews-page", () => ({ useInterviewsPage: () => ({
  resumes: [{ id: 1, title: "参考简历", updated_at: "", versions: [{ id: 11, version: 1, name: "发布版" }] }],
  resumesError: "", reloadResumes: vi.fn(), items: [], seriesItems: [], totalCount: 0,
  loadError: "", retryLoad: vi.fn(), reloadHistory: state.reload, resumeId: 1, resumeVersionId: 11,
  setResumeId: vi.fn(), setResumeVersionId: vi.fn(), keyword: "", setKeyword: vi.fn(), remove: vi.fn(), removeSeries: vi.fn(),
  deletion: { busy: !state.canDelete, canStart: () => state.canDelete },
}) }));
vi.mock("@/components/interviews/interview-history", () => ({ InterviewHistory: () => null }));
vi.mock("@/components/interviews/interview-start-form", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/interviews/interview-start-form")>();
  return { ...actual, InterviewStartForm: (props: FormProps) => { state.form = props; return <actual.InterviewStartForm {...props} />; } };
});
import InterviewsPage from "@/app/interviews/page";

beforeEach(() => {
  for (const mock of [state.stream, state.push, state.reload, state.append, state.flush, state.reset]) mock.mockReset();
  state.form = null;
  state.canDelete = true;
});
afterEach(() => {
  cleanup();
  window.sessionStorage.removeItem(INTERVIEW_QUESTION_GRAPH_DRAFT_KEY);
});

it("删除从确认开始持锁时，旧开始回调也不能创建面试，配置原稿保留", async () => {
  const page = render(<InterviewsPage />); const oldStart = state.form!.onStart;
  state.canDelete = false; page.rerender(<InterviewsPage />);
  await act(async () => { oldStart(); state.form!.onStart(); }); expect(state.stream).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "立即开启模拟实战" }).closest("fieldset")?.disabled).toBe(true);
  expect((screen.getByLabelText("目标岗位要求（JD / 职位描述）") as HTMLTextAreaElement).value).toContain("尚未上线");
});

it("切换面试官视角进入独立图谱页并带入当前配置", () => {
  render(<InterviewsPage />);
  fireEvent.click(screen.getByRole("button", { name: "面试官视角" }));
  expect(state.push).toHaveBeenCalledExactlyOnceWith("/interviews/question-graphs?draft=interview");
  expect(JSON.parse(window.sessionStorage.getItem(INTERVIEW_QUESTION_GRAPH_DRAFT_KEY) ?? "null")).toEqual({
    resumeId: 1,
    resumeVersionId: 11,
    jd: "  仅做接口联调 <T> &amp;\n尚未上线  ",
    style: "gentle",
  });
  expect(screen.queryByRole("region", { name: "模拟面试问题图谱" })).toBeNull();
});

const creationFailures = [
  { reason: new SseServerError("实际材料变化"), uncertain: false },
  ...[400, 401, 404, 409, 413, 422, 429].map(status => ({ reason: new HttpError(`明确拒绝 ${status}`, status), uncertain: false })),
  ...[408, 500, 503].map(status => ({ reason: new HttpError(`响应未知 ${status}`, status), uncertain: true })),
  { reason: new Error("连接中断"), uncertain: true },
  { reason: new Error("流式响应错误事件格式无效"), uncertain: true },
];
it.each(["single", "series"].flatMap(mode => creationFailures.map(failure => ({ mode, ...failure }))))(
  "$mode $reason.message 的提示保留输入并只读取历史", async ({ mode, reason, uncertain }) => {
    state.stream.mockRejectedValueOnce(reason);
    render(<InterviewsPage />);
    if (mode === "series") fireEvent.click(screen.getByRole("button", { name: "进阶三轮连打" }));
    fireEvent.click(screen.getByRole("button", { name: mode === "series" ? "开启进阶三轮连打" : "立即开启模拟实战" }));
    const alert = await screen.findByRole("alert"); expect(alert.textContent).toContain(reason.message);
    if (uncertain) expect(alert.textContent).toContain("仍可能已保存");
    else { expect(alert.textContent).not.toContain("仍可能已保存"); expect(alert.textContent).toContain("核对材料或配置"); }
    expect((screen.getByLabelText("目标岗位要求（JD / 职位描述）") as HTMLTextAreaElement).value).toBe("  仅做接口联调 <T> &amp;\n尚未上线  ");
    expect(state.reload).toHaveBeenCalledOnce(); expect(state.stream).toHaveBeenCalledOnce(); expect(state.push).not.toHaveBeenCalled();
});

it("明确失败后新请求清除旧提示，取消仍提示核对未知结果", async () => {
  state.stream.mockRejectedValueOnce(new SseServerError("旧材料变化")).mockImplementationOnce(() => new Promise<void>(() => {}));
  render(<InterviewsPage />);
  fireEvent.click(screen.getByRole("button", { name: "立即开启模拟实战" }));
  expect((await screen.findByRole("alert")).textContent).not.toContain("仍可能已保存");
  fireEvent.click(screen.getByRole("button", { name: "立即开启模拟实战" }));
  expect(screen.queryByRole("alert")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(screen.getByRole("alert").textContent).toContain("仍可能已保存"); expect(state.reload).toHaveBeenCalledTimes(2);
});

it("同一事件的重复开始只发一次，等待期间锁定所有提交材料", async () => {
  const pending = Promise.withResolvers<void>();
  state.stream.mockImplementationOnce(() => pending.promise);
  render(<InterviewsPage />);
  const start = state.form!.onStart;
  act(() => { start(); start(); });
  expect(state.stream).toHaveBeenCalledTimes(1);
  expect(state.stream.mock.calls[0]![1].body).toMatchObject({ jd: "仅做接口联调 <T> &amp;\n尚未上线", resume_id: 1, resume_version_id: 11 });
  for (const name of ["单轮模考", "进阶三轮连打"]) expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
  for (const element of [screen.getByLabelText("关联简历"), screen.getByLabelText("总题数"), screen.getByLabelText("考官风格"), screen.getByLabelText("目标岗位要求（JD / 职位描述）")]) expect((element as HTMLInputElement).disabled).toBe(true);
  await act(async () => { await state.stream.mock.calls[0]![1].onDone({ id: 19 }); pending.resolve(); });
  expect(state.push).toHaveBeenCalledExactlyOnceWith("/interviews/19");
  act(() => { start(); state.form!.onCancel(); });
  expect(state.stream).toHaveBeenCalledTimes(1);
  expect((screen.getByLabelText("总题数") as HTMLInputElement).disabled).toBe(true);
  expect(screen.queryByRole("button", { name: "取消" })).toBeNull();
});

it.each([null, {}, { id: 0 }, { id: -1 }, { id: "19" }, { id: 1.5 }, { id: Number.MAX_SAFE_INTEGER + 1 }])("无效完成响应 %j 不导航，保留输入并刷新历史", async (value) => {
  state.stream.mockImplementationOnce(async (_url: string, options: SseOptions<unknown>) => { await options.onDone?.(value); });
  render(<InterviewsPage />);
  fireEvent.click(screen.getByRole("button", { name: "立即开启模拟实战" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("核对历史");
  expect(state.push).not.toHaveBeenCalled();
  expect(state.reload).toHaveBeenCalledTimes(1);
  expect((screen.getByLabelText("目标岗位要求（JD / 职位描述）") as HTMLTextAreaElement).value).toBe("  仅做接口联调 <T> &amp;\n尚未上线  ");
  expect((screen.getByRole("button", { name: "立即开启模拟实战" }) as HTMLButtonElement).disabled).toBe(false);
});

it.each(["成功", "回调错误", "抛错"])("取消后重试，旧请求%s不影响新请求", async (outcome) => {
  const old = Promise.withResolvers<void>();
  const current = Promise.withResolvers<void>();
  state.stream.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => current.promise);
  render(<InterviewsPage />);
  fireEvent.click(screen.getByRole("button", { name: "立即开启模拟实战" }));
  const oldOptions = state.stream.mock.calls[0]![1] as SseOptions<unknown>;
  fireEvent.click(screen.getByRole("button", { name: "取消" }));
  expect(oldOptions.signal?.aborted).toBe(true);
  expect(state.reload).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "立即开启模拟实战" }));
  const resets = state.reset.mock.calls.length;
  await act(async () => {
    oldOptions.onDelta?.("旧首题");
    if (outcome === "成功") { await oldOptions.onDone?.({ id: 18 }); old.resolve(); }
    else if (outcome === "回调错误") { oldOptions.onError?.(new Error("旧失败")); old.resolve(); }
    else old.reject(new Error("旧失败"));
  });
  expect(state.push).not.toHaveBeenCalled();
  expect(state.append).not.toHaveBeenCalled();
  expect(state.reset).toHaveBeenCalledTimes(resets);
  expect(state.reload).toHaveBeenCalledTimes(1);
  expect(screen.queryByText("旧失败")).toBeNull();
  expect((screen.getByLabelText("总题数") as HTMLInputElement).disabled).toBe(true);
  await act(async () => { await state.stream.mock.calls[1]![1].onDone({ id: 20 }); current.resolve(); });
  expect(state.push).toHaveBeenCalledExactlyOnceWith("/interviews/20");
});

it.each(["成功", "失败"])("离页后旧请求%s和保留的开始函数均失效", async (outcome) => {
  const pending = Promise.withResolvers<void>();
  state.stream.mockImplementationOnce(() => pending.promise);
  const view = render(<InterviewsPage />);
  const start = state.form!.onStart;
  act(() => { start(); });
  const options = state.stream.mock.calls[0]![1] as SseOptions<unknown>;
  view.unmount();
  expect(options.signal?.aborted).toBe(true);
  const resets = state.reset.mock.calls.length;
  await act(async () => {
    start(); options.onDelta?.("离页旧首题");
    if (outcome === "成功") { await options.onDone?.({ id: 19 }); pending.resolve(); }
    else pending.reject(new Error("离页旧失败"));
  });
  expect(state.stream).toHaveBeenCalledTimes(1);
  expect(state.push).not.toHaveBeenCalled();
  expect(state.reload).not.toHaveBeenCalled();
  expect(state.append).not.toHaveBeenCalled();
  expect(state.reset).toHaveBeenCalledTimes(resets);
});

it("完成只导航一次，迟到错误不撤销已接受导航", async () => {
  state.stream.mockImplementationOnce(async (_url: string, options: SseOptions<unknown>) => {
    await options.onDone?.({ id: 19 });
    await options.onDone?.({ id: 20 });
    options.onError?.(new Error("迟到错误"));
    throw new Error("迟到错误");
  });
  render(<InterviewsPage />);
  fireEvent.click(screen.getByRole("button", { name: "立即开启模拟实战" }));
  await waitFor(() => expect(state.push).toHaveBeenCalledExactlyOnceWith("/interviews/19"));
  expect(state.reload).not.toHaveBeenCalled();
  expect(screen.queryByText("迟到错误")).toBeNull();
});

it.each(["", "0", "-1", "31", "1.5"])("题数输入 %s 阻止按钮及直接处理函数提交，改为合法整数后恢复", (value) => {
  state.stream.mockImplementationOnce(() => new Promise<void>(() => {}));
  render(<InterviewsPage />);
  const input = screen.getByRole("spinbutton", { name: "总题数" });
  fireEvent.change(input, { target: { value } });
  expect((screen.getByRole("button", { name: "立即开启模拟实战" }) as HTMLButtonElement).disabled).toBe(true);
  act(() => { state.form!.onStart(); });
  expect(state.stream).not.toHaveBeenCalled();
  expect(screen.getByText("题数须为 1–30 的整数")).toBeTruthy();
  fireEvent.change(input, { target: { value: "3" } });
  expect((screen.getByRole("button", { name: "立即开启模拟实战" }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "立即开启模拟实战" }));
  expect(state.stream).toHaveBeenCalledExactlyOnceWith("/api/interviews", expect.objectContaining({ body: expect.objectContaining({ rounds: 3 }) }));
});
