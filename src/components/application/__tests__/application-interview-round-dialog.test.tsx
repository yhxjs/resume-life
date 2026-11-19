// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ApplicationInterviewRoundDialog } from "../application-interview-round-dialog";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import { confirmDialog } from "@/components/common/confirm-dialog";
import type { Application, ApplicationInterview } from "@/lib/applications-types";

vi.mock("@/lib/fetcher", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
vi.mock("@/components/common/confirm-dialog", () => ({ confirmDialog: vi.fn() }));

const app = { id: 8, company: "甲公司", role: "前端工程师", stage: "applied" } as Application;
const round: ApplicationInterview = {
  id: 3, application_id: 8, round_name: "技术一面", status: "scheduled",
  interview_time: "2026-10-29T02:30:00.000Z", interviewer: "甲面试官", location: "电话面试",
  meeting_url: "https://example.com/first", reminder_minutes: 30, notes: "原轮次手记", created_at: "", updated_at: "",
};
const nextRound: ApplicationInterview = {
  ...round, id: 4, round_name: "主管二面", status: "passed", interviewer: "乙面试官",
  location: "公司现场", meeting_url: "https://example.com/second", reminder_minutes: 0, notes: "新轮次手记",
};
const props = { application: app, initialInterview: round, open: true, onClose: vi.fn(), onSuccess: vi.fn() };

beforeEach(() => { vi.mocked(jsonFetch).mockReset(); vi.mocked(confirmDialog).mockReset(); props.onClose.mockReset(); props.onSuccess.mockReset(); });
afterEach(() => { cleanup(); });

function submit() { fireEvent.submit(document.querySelector("form")!); }
function roundName() { return screen.getByRole("textbox", { name: "轮次名称 *" }) as HTMLInputElement; }

it("切换轮次后立即使用新记录，不把旧草稿写到新轮次", async () => {
  vi.mocked(jsonFetch).mockResolvedValue({});
  const view = render(<ApplicationInterviewRoundDialog {...props} />);
  fireEvent.change(roundName(), { target: { value: "本地旧轮次草稿" } });
  view.rerender(<ApplicationInterviewRoundDialog {...props} initialInterview={nextRound} />);
  expect(roundName().value).toBe("主管二面");
  expect(screen.queryByDisplayValue("原轮次手记")).toBeNull();
  await act(async () => submit());
  expect(vi.mocked(jsonFetch).mock.calls[0]?.[0]).toBe("/api/applications/8/interviews/4");
  expect(JSON.parse(String(vi.mocked(jsonFetch).mock.calls[0]?.[1]?.body))).toMatchObject({
    round_name: "主管二面", status: "passed", interviewer: "乙面试官", location: "公司现场",
    meeting_url: "https://example.com/second", reminder_minutes: 0, notes: "新轮次手记",
  });
});

it("关闭后重开同一轮次重新初始化草稿，不保留上次未保存内容", () => {
  const view = render(<ApplicationInterviewRoundDialog {...props} />);
  fireEvent.change(roundName(), { target: { value: "未保存的旧标题" } });
  view.rerender(<ApplicationInterviewRoundDialog {...props} open={false} />);
  expect(document.querySelector("form")).toBeNull();
  view.rerender(<ApplicationInterviewRoundDialog {...props} />);
  expect(roundName().value).toBe(round.round_name);
});

it("保存中连续提交只发起一次请求，成功回调也只触发一次", async () => {
  const pending = Promise.withResolvers<unknown>();
  vi.mocked(jsonFetch).mockReturnValue(pending.promise);
  render(<ApplicationInterviewRoundDialog {...props} initialInterview={null} />);
  act(() => { submit(); submit(); });
  expect(jsonFetch).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve({}));
  expect(props.onSuccess).toHaveBeenCalledTimes(1);
  expect(props.onClose).toHaveBeenCalledTimes(1);
});

it("删除确认等待期间卸载，晚到的确认不能再删除记录", async () => {
  const confirmation = Promise.withResolvers<boolean>();
  vi.mocked(confirmDialog).mockReturnValue(confirmation.promise);
  vi.mocked(jsonFetch).mockResolvedValue({});
  const view = render(<ApplicationInterviewRoundDialog {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "删除本轮面试" }));
  view.unmount();
  await act(async () => confirmation.resolve(true));
  expect(jsonFetch).not.toHaveBeenCalled();
  expect(props.onSuccess).not.toHaveBeenCalled();
  expect(props.onClose).not.toHaveBeenCalled();
});

it("切换轮次使旧保存失效，旧成功响应不能关闭当前弹窗", async () => {
  const pending = Promise.withResolvers<unknown>();
  vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
  const view = render(<ApplicationInterviewRoundDialog {...props} />);
  submit();
  const signal = vi.mocked(jsonFetch).mock.calls[0]![1]?.signal;
  view.rerender(<ApplicationInterviewRoundDialog {...props} initialInterview={nextRound} />);
  expect(signal?.aborted).toBe(true);
  await act(async () => pending.resolve({}));
  expect(props.onSuccess).not.toHaveBeenCalled();
  expect(props.onClose).not.toHaveBeenCalled();
  expect(roundName().value).toBe(nextRound.round_name);
});

it("切换投递和新建/编辑模式时重建状态，同一记录的后台刷新保留本地草稿", async () => {
  vi.mocked(jsonFetch).mockResolvedValue({});
  const view = render(<ApplicationInterviewRoundDialog {...props} />);
  fireEvent.change(roundName(), { target: { value: "本地编辑" } });
  view.rerender(<ApplicationInterviewRoundDialog {...props} initialInterview={{ ...round, notes: "后台更新" }} />);
  expect(roundName().value).toBe("本地编辑");
  view.rerender(<ApplicationInterviewRoundDialog {...props} initialInterview={null} />);
  expect(roundName().value).toBe("一面");
  expect((screen.getByLabelText("轮次备忘 / 面试要点手记") as HTMLTextAreaElement).value).toBe("");
  fireEvent.change(roundName(), { target: { value: "甲公司草稿" } });
  view.rerender(<ApplicationInterviewRoundDialog {...props} application={{ ...app, id: 9, company: "乙公司", stage: "offer" }} initialInterview={null} />);
  expect(roundName().value).toBe("一面");
  expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
  await act(async () => submit());
  expect(vi.mocked(jsonFetch).mock.calls[0]?.[0]).toBe("/api/applications/9/interviews");
  expect(JSON.parse(String(vi.mocked(jsonFetch).mock.calls[0]?.[1]?.body))).toMatchObject({ round_name: "一面", notes: "", advance_stage: false });
});

it.each(["POST", "PATCH", "DELETE"] as const)("%s 失败保留草稿并释放互斥，用户可以继续修改和重试", async (method) => {
  vi.mocked(jsonFetch).mockRejectedValueOnce(method === "DELETE" ? new HttpError("保存或删除失败", 400) : new Error("保存或删除失败")).mockResolvedValueOnce({ ok: true });
  vi.mocked(confirmDialog).mockResolvedValue(true);
  render(<ApplicationInterviewRoundDialog {...props} initialInterview={method === "POST" ? null : round} />);
  fireEvent.change(roundName(), { target: { value: "  手动编辑后的轮次  " } });
  fireEvent.change(screen.getByLabelText("轮次备忘 / 面试要点手记"), { target: { value: "本地草稿 Array<T> &amp;" } });
  await act(async () => {
    if (method === "DELETE") fireEvent.click(screen.getByRole("button", { name: "删除本轮面试" }));
    else submit();
  });
  expect(screen.getByRole("alert").textContent).toContain("保存或删除失败");
  expect(document.activeElement).toBe(screen.getByRole("alert"));
  expect(roundName().value).toBe("  手动编辑后的轮次  ");
  expect(roundName().matches(":disabled")).toBe(false);
  expect(props.onClose).not.toHaveBeenCalled();
  expect(props.onSuccess).not.toHaveBeenCalled();
  fireEvent.change(roundName(), { target: { value: "继续修改后的轮次" } });
  await act(async () => {
    if (method === "DELETE") fireEvent.click(screen.getByRole("button", { name: "删除本轮面试" }));
    else submit();
  });
  expect(jsonFetch).toHaveBeenCalledTimes(2);
  expect(vi.mocked(jsonFetch).mock.calls.map(([, init]) => init?.method)).toEqual([method, method]);
  if (method !== "DELETE") expect(JSON.parse(String(vi.mocked(jsonFetch).mock.calls[1]?.[1]?.body))).toMatchObject({
    round_name: "继续修改后的轮次", notes: "本地草稿 Array<T> &amp;",
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(props.onSuccess).toHaveBeenCalledTimes(1);
  expect(props.onClose).toHaveBeenCalledTimes(1);
});

it("删除确认与保存共用同步互斥，取消确认后可正常保存", async () => {
  const confirmation = Promise.withResolvers<boolean>();
  vi.mocked(confirmDialog).mockReturnValueOnce(confirmation.promise);
  vi.mocked(jsonFetch).mockResolvedValue({});
  render(<ApplicationInterviewRoundDialog {...props} />);
  const deleteButton = screen.getByRole("button", { name: "删除本轮面试" });
  const closeButton = screen.getByRole("button", { name: "关闭弹窗" });
  act(() => { fireEvent.click(deleteButton); fireEvent.click(deleteButton); submit(); fireEvent.click(closeButton); });
  expect(confirmDialog).toHaveBeenCalledTimes(1);
  expect(jsonFetch).not.toHaveBeenCalled();
  expect(props.onClose).not.toHaveBeenCalled();
  expect(roundName().matches(":disabled")).toBe(true);
  await act(async () => confirmation.resolve(false));
  expect(roundName().matches(":disabled")).toBe(false);
  expect(props.onClose).not.toHaveBeenCalled();
  await act(async () => submit());
  expect(jsonFetch).toHaveBeenCalledTimes(1);
  expect(vi.mocked(jsonFetch).mock.calls[0]?.[1]?.method).toBe("PATCH");
  expect(props.onSuccess).toHaveBeenCalledTimes(1);
});

it("保存中不再打开删除确认，关闭按钮与 Escape 均不丢弃等待状态", async () => {
  const pending = Promise.withResolvers<unknown>();
  vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
  render(<ApplicationInterviewRoundDialog {...props} />);
  const deleteButton = screen.getByRole("button", { name: "删除本轮面试" });
  const closeButton = screen.getByRole("button", { name: "关闭弹窗" });
  act(() => { submit(); fireEvent.click(deleteButton); fireEvent.click(closeButton); });
  fireEvent.keyDown(document, { key: "Escape" });
  expect(confirmDialog).not.toHaveBeenCalled();
  expect(props.onClose).not.toHaveBeenCalled();
  expect(roundName().matches(":disabled")).toBe(true);
  await act(async () => pending.resolve({}));
  expect(props.onSuccess).toHaveBeenCalledTimes(1);
  expect(props.onClose).toHaveBeenCalledTimes(1);
});

it.each(["成功", "失败"])("隐藏后重开会取消旧请求，晚到%s不影响新弹窗", async (outcome) => {
  const pending = Promise.withResolvers<unknown>();
  vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise).mockResolvedValueOnce({});
  const view = render(<ApplicationInterviewRoundDialog {...props} />);
  submit();
  const signal = vi.mocked(jsonFetch).mock.calls[0]![1]?.signal;
  view.rerender(<ApplicationInterviewRoundDialog {...props} open={false} />);
  expect(signal?.aborted).toBe(true);
  view.rerender(<ApplicationInterviewRoundDialog {...props} />);
  await act(async () => {
    if (outcome === "成功") pending.resolve({});
    else pending.reject(new Error("旧保存失败"));
  });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(props.onSuccess).not.toHaveBeenCalled();
  expect(props.onClose).not.toHaveBeenCalled();
  await act(async () => submit());
  expect(props.onSuccess).toHaveBeenCalledTimes(1);
});

it.each(["保存", "删除"].flatMap((action) => ["成功", "失败"].map((outcome) => ({ action, outcome }))))(
  "切换记录后旧$action 晚到$outcome，不能解除新请求忙碌状态或触发回调", async ({ action, outcome }) => {
    const old = Promise.withResolvers<unknown>();
    const current = Promise.withResolvers<unknown>();
    vi.mocked(jsonFetch).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    vi.mocked(confirmDialog).mockResolvedValue(true);
    const view = render(<ApplicationInterviewRoundDialog {...props} />);
    await act(async () => {
      if (action === "删除") fireEvent.click(screen.getByRole("button", { name: "删除本轮面试" }));
      else submit();
    });
    const signal = vi.mocked(jsonFetch).mock.calls[0]![1]?.signal;
    view.rerender(<ApplicationInterviewRoundDialog {...props} initialInterview={nextRound} />);
    submit();
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      if (outcome === "成功") old.resolve({});
      else old.reject(new Error("旧请求失败"));
    });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "保存中..." }).matches(":disabled")).toBe(true);
    expect(props.onSuccess).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
    await act(async () => current.resolve({}));
    expect(props.onSuccess).toHaveBeenCalledTimes(1);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  }
);

it.each(["切换轮次", "切换投递", "隐藏"])("删除确认期间%s，确认旧记录后不会发送 DELETE", async (change) => {
  const confirmation = Promise.withResolvers<boolean>();
  vi.mocked(confirmDialog).mockReturnValueOnce(confirmation.promise);
  const view = render(<ApplicationInterviewRoundDialog {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "删除本轮面试" }));
  view.rerender(<ApplicationInterviewRoundDialog {...props}
    initialInterview={change === "切换轮次" ? nextRound : round}
    application={change === "切换投递" ? { ...app, id: 9 } : app}
    open={change !== "隐藏"} />);
  await act(async () => confirmation.resolve(true));
  expect(jsonFetch).not.toHaveBeenCalled();
  expect(props.onSuccess).not.toHaveBeenCalled();
  expect(props.onClose).not.toHaveBeenCalled();
});

it("空轮次名称校验不占用互斥，补齐后仍能保存", async () => {
  vi.mocked(jsonFetch).mockResolvedValue({});
  render(<ApplicationInterviewRoundDialog {...props} />);
  fireEvent.change(roundName(), { target: { value: "  " } });
  submit();
  expect(screen.getByRole("alert").textContent).toContain("轮次名称不能为空");
  expect(document.activeElement).toBe(screen.getByRole("alert"));
  expect(jsonFetch).not.toHaveBeenCalled();
  fireEvent.change(roundName(), { target: { value: "  新轮次  " } });
  await act(async () => submit());
  expect(JSON.parse(String(vi.mocked(jsonFetch).mock.calls[0]?.[1]?.body)).round_name).toBe("新轮次");
  expect(props.onSuccess).toHaveBeenCalledTimes(1);
});
