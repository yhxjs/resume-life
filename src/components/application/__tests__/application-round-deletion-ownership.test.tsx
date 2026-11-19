// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApplicationInterviewRoundDialog } from "../application-interview-round-dialog";
import { ConfirmDialogHost, confirmDialog } from "@/components/common/confirm-dialog";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import type { Application, ApplicationInterview } from "@/lib/applications-types";

vi.mock("@/lib/fetcher", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
const app = { id: 8, company: "甲公司 <T> &amp; " + "LongCompany_".repeat(15), role: "前端岗位_".repeat(15), stage: "applied" } as Application;
const round: ApplicationInterview = { id: 3, application_id: 8, round_name: "技术一面 <T> &amp; " + "LongRound_".repeat(15), status: "scheduled",
  interview_time: "2026-11-04T01:02:03.000Z", interviewer: "甲面试官", location: "电话", meeting_url: "https://example.com", reminder_minutes: 30,
  notes: "原轮次手记", created_at: "2026-11-01T01:02:03.000Z", updated_at: "2026-11-02T01:02:03.000Z" };
beforeEach(() => {
  vi.mocked(jsonFetch).mockReset().mockResolvedValue({ ok: true });
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 100, 20)] as unknown as DOMRectList);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const title = "确认删除该轮面试？";
async function setup() {
  render(<ConfirmDialogHost />); const onClose = vi.fn(); const onSuccess = vi.fn();
  const props = { application: app, initialInterview: round, open: true, onClose, onSuccess };
  const view = render(<ApplicationInterviewRoundDialog {...props} />);
  const name = screen.getByRole("textbox", { name: "轮次名称 *" }); const notes = screen.getByRole("textbox", { name: "轮次备忘 / 面试要点手记" });
  const draft = "未保存 <T> &amp;\n内部  空格";
  fireEvent.change(name, { target: { value: "本地改名，尚未保存" } }); fireEvent.change(notes, { target: { value: draft } });
  const trigger = screen.getByRole("button", { name: "删除本轮面试" });
  return { ...view, props, onClose, onSuccess, trigger, name, notes, draft };
}
async function start(trigger: HTMLElement) { trigger.focus(); fireEvent.click(trigger); return screen.findByRole("dialog", { name: title }); }
async function accept(trigger: HTMLElement) { const dialog = await start(trigger); fireEvent.click(within(dialog).getByRole("button", { name: "确认删除" })); await act(async () => {}); }
function submit() { fireEvent.submit(document.querySelector("form")!); }
const methods = () => vi.mocked(jsonFetch).mock.calls.map(([, init]) => init?.method ?? "GET");

it.each(["卸载", "切换投递", "切换轮次", "隐藏"])("%s 移除当前确认，旧入口不能重开", async change => {
  const view = await setup(); await start(view.trigger);
  if (change === "卸载") view.unmount(); else view.rerender(<ApplicationInterviewRoundDialog {...view.props} application={change === "切换投递" ? { ...app, id: 9 } : app} initialInterview={change === "切换轮次" ? { ...round, id: 4 } : round} open={change !== "隐藏"} />);
  expect(screen.queryByRole("dialog", { name: title })).toBeNull(); fireEvent.click(view.trigger); await act(async () => {});
  expect(jsonFetch).not.toHaveBeenCalled(); expect(view.onClose).not.toHaveBeenCalled(); expect(view.onSuccess).not.toHaveBeenCalled();
});
it.each(["卸载", "切换轮次"])("%s 移除排队确认并保留其他操作顺序", async change => {
  const view = await setup(); act(() => { void confirmDialog({ title: "其他当前操作", message: "当前" }); }); fireEvent.click(view.trigger);
  act(() => { void confirmDialog({ title: "其他后续操作", message: "后续" }); });
  if (change === "卸载") view.unmount(); else view.rerender(<ApplicationInterviewRoundDialog {...view.props} initialInterview={{ ...round, id: 4 }} />);
  fireEvent.click(screen.getByRole("button", { name: "确定" })); const next = screen.getByRole("dialog", { name: "其他后续操作" }); expect(next.textContent).toContain("其他后续操作"); fireEvent.click(within(next).getByRole("button", { name: "取消" })); expect(jsonFetch).not.toHaveBeenCalled();
});
it.each(["取消", "Escape"])("重复点击只排一次确认，%s 返回触发焦点并保留原始草稿", async cancel => {
  const view = await setup(); const dialog = await start(view.trigger); fireEvent.click(view.trigger); submit(); fireEvent.click(screen.getByRole("button", { name: "关闭弹窗" }));
  fireEvent.change(view.notes, { target: { value: "确认中改稿" } });
  if (cancel === "Escape") fireEvent.keyDown(document, { key: "Escape" }); else fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(document.activeElement).toBe(view.trigger)); expect(screen.queryByRole("dialog", { name: title })).toBeNull();
  expect((view.notes as HTMLTextAreaElement).value).toBe(view.draft); expect((view.name as HTMLInputElement).value).toBe("本地改名，尚未保存"); expect(jsonFetch).not.toHaveBeenCalled(); expect(view.onClose).not.toHaveBeenCalled();
});
it("确认展示持久记录身份、时间、逐题复盘级联范围和导出保留范围", async () => {
  const view = await setup(); const dialog = await start(view.trigger);
  for (const text of ["投递 #8", app.company, app.role, "轮次 #3", round.round_name, round.interview_time, round.created_at, "逐题记录", "复盘", "错题", "追练", "待办", "保留"]) expect(dialog.textContent).toContain(text);
  expect(dialog.textContent).not.toContain("本地改名，尚未保存"); await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "取消" })); });
  expect(view.name.matches(":disabled")).toBe(false); expect(jsonFetch).not.toHaveBeenCalled();
});
it("接受与离页同事件不发送删除或触发旧回调", async () => {
  const view = await setup(); const dialog = await start(view.trigger); act(() => { within(dialog).getByRole("button", { name: "确认删除" }).click(); view.unmount(); }); await act(async () => {});
  expect(jsonFetch).not.toHaveBeenCalled(); expect(view.onSuccess).not.toHaveBeenCalled(); expect(view.onClose).not.toHaveBeenCalled();
});
it("明确接受只一次 DELETE，严格成功后只调用一次刷新和关闭", async () => {
  const view = await setup(); const dialog = await start(view.trigger); const button = within(dialog).getByRole("button", { name: "确认删除" }); act(() => { button.click(); button.click(); });
  await waitFor(() => expect(view.onSuccess).toHaveBeenCalledOnce()); expect(view.onClose).toHaveBeenCalledOnce(); expect(methods()).toEqual(["DELETE"]);
});
it.each([{}, { ok: false }, { ok: "true" }, []])("不完整 DELETE 回复 %j 只读核对，确认消失才完成", async invalid => {
  const view = await setup(); vi.mocked(jsonFetch).mockResolvedValueOnce(invalid).mockResolvedValueOnce([]); await accept(view.trigger);
  expect(methods()).toEqual(["DELETE", "GET"]); expect(vi.mocked(jsonFetch).mock.calls[1]).toEqual(["/api/applications/8/interviews", expect.objectContaining({ cache: "no-store", signal: expect.any(AbortSignal) })]); expect(view.onSuccess).toHaveBeenCalledOnce(); expect(view.onClose).toHaveBeenCalledOnce();
});
it.each([404, 400, 408])("HTTP %s 按协议区分已不存在、拒绝写入与需要核对", async status => {
  const view = await setup(); vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("接口异常", status)).mockResolvedValueOnce([]); await accept(view.trigger);
  if (status === 400) { expect(methods()).toEqual(["DELETE"]); expect(screen.getByRole("alert").textContent).toContain("接口异常"); expect(view.onSuccess).not.toHaveBeenCalled(); expect(view.name.matches(":disabled")).toBe(false); }
  else { expect(methods()).toEqual(status === 404 ? ["DELETE"] : ["DELETE", "GET"]); expect(view.onSuccess).toHaveBeenCalledOnce(); }
});
const badLists = [
  { label: "缺少列表", value: {} }, { label: "非列表信封", value: { items: [] } },
  { label: "串投递", value: [{ ...round, application_id: 9 }] }, { label: "重复ID", value: [round, round] },
  { label: "非法ID", value: [{ ...round, id: 0 }] }, { label: "非整数ID", value: [{ ...round, id: 1.5 }] },
  { label: "残缺轮次", value: [{ id: 4, application_id: 8 }] }, { label: "非法状态", value: [{ ...round, status: "bad" }] },
];
it.each(badLists)("核对列表 $label 不能证明消失，保留未知锁；显式重读只 GET", async ({ value }) => {
  const view = await setup(); vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("回复丢失")).mockResolvedValueOnce(value); await accept(view.trigger);
  expect(screen.getByRole("alert").textContent).toContain("删除结果尚未确认"); expect(view.name.matches(":disabled")).toBe(true); expect((view.notes as HTMLTextAreaElement).value).toBe(view.draft);
  submit(); fireEvent.click(view.trigger); expect(methods()).toEqual(["DELETE", "GET"]); expect(view.onSuccess).not.toHaveBeenCalled();
  const pending = Promise.withResolvers<unknown>(); vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise);
  const retry = screen.getByRole("button", { name: "重新读取删除状态" }); act(() => { retry.click(); retry.click(); }); expect(methods()).toEqual(["DELETE", "GET", "GET"]);
  await act(async () => pending.resolve([])); expect(view.onSuccess).toHaveBeenCalledOnce(); expect(view.onClose).toHaveBeenCalledOnce();
});
it("列表404不是目标404，不能报删除成功", async () => {
  const view = await setup(); vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("回复丢失")).mockRejectedValueOnce(new HttpError("投递不存在", 404)); await accept(view.trigger);
  expect(screen.getByRole("alert").textContent).toContain("删除结果尚未确认"); expect(view.onSuccess).not.toHaveBeenCalled(); expect(screen.getByRole("button", { name: "重新读取删除状态" })).toBeTruthy();
});
it("核对仍存在解除未知锁并保留草稿，下一次删除需要重新确认", async () => {
  const view = await setup(); vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("回复丢失")).mockResolvedValueOnce([round]); await accept(view.trigger);
  expect(screen.getByRole("alert").textContent).toContain("目前仍存在"); expect(view.name.matches(":disabled")).toBe(false); expect((view.notes as HTMLTextAreaElement).value).toBe(view.draft);
  expect(view.onClose).not.toHaveBeenCalled(); const dialog = await start(view.trigger); expect(methods()).toEqual(["DELETE", "GET"]);
  await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "取消" })); });
  expect(view.name.matches(":disabled")).toBe(false); expect(methods()).toEqual(["DELETE", "GET"]);
});
it.each(["成功", "失败"])("核对期间切换轮次，旧列表晚到%s不触发回调或释放新操作", async outcome => {
  const view = await setup(); const old = Promise.withResolvers<unknown>(); const saving = Promise.withResolvers<unknown>();
  vi.mocked(jsonFetch).mockRejectedValueOnce(new Error("回复丢失")).mockReturnValueOnce(old.promise); await accept(view.trigger);
  const signal = vi.mocked(jsonFetch).mock.calls[1]![1]!.signal!;
  view.rerender(<ApplicationInterviewRoundDialog {...view.props} initialInterview={{ ...round, id: 4 }} />); vi.mocked(jsonFetch).mockReturnValueOnce(saving.promise); submit(); expect(signal.aborted).toBe(true);
  await act(async () => { if (outcome === "成功") old.resolve([]); else old.reject(new Error("旧核对错误")); });
  expect(view.onSuccess).not.toHaveBeenCalled(); expect(view.onClose).not.toHaveBeenCalled(); expect(screen.queryByRole("alert")).toBeNull(); expect(screen.getByRole("button", { name: "保存中..." }).matches(":disabled")).toBe(true);
  await act(async () => saving.resolve({})); expect(view.onSuccess).toHaveBeenCalledOnce();
});
