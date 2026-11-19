// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApplicationDialog } from "../application-dialog";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import type { Application } from "@/lib/applications-types";

vi.mock("@/lib/fetcher", async original => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
const item: Application = { id: 7, company: "甲公司", role: "接口开发", salary_range: "", stage: "interested", flow_status: "active", batch_name: "", hiring_stage: null, stage_changed_at: "", terminal_stage: null, terminal_reason: "", terminal_at: "", resume_id: null, resume_version_id: null, interview_id: null, interview_series_id: null, next_interview_at: "", jd: "", notes: "尚未上线 <T> &amp;，内部  空格", created_at: "历史时间原文", updated_at: "历史修改时间", interviews: [], stage_history: [], preparation_tasks: [] };
const writes = () => vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method);
const reads = () => vi.mocked(jsonFetch).mock.calls.filter(([url, init]) => url === "/api/applications/7" && !init?.method);
const props = { onClose: vi.fn(), onSuccess: vi.fn() };
const submit = () => fireEvent.submit(document.querySelector("form")!);
beforeEach(() => {
  vi.mocked(jsonFetch).mockReset().mockImplementation(async (url, init) => {
    if (init?.method) return { ...structuredClone(item), ...JSON.parse(String(init.body)), id: init.method === "POST" ? 77 : 7 } as never;
    if (url === "/api/resumes") return [] as never;
    if (url === "/api/applications/7") return structuredClone(item) as never;
    return { items: [], nextCursor: null } as never;
  });
  props.onClose.mockReset(); props.onSuccess.mockReset();
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 100, 20)] as unknown as DOMRectList);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
async function setup(edit = true) {
  const view = render(<ApplicationDialog {...props} initialData={edit ? item : null} />);
  await waitFor(() => expect(vi.mocked(jsonFetch).mock.calls.filter(([, init]) => !init?.method)).toHaveLength(3));
  if (!edit) { fireEvent.change(screen.getByLabelText(/公司名称/), { target: { value: item.company } }); fireEvent.change(screen.getByLabelText(/目标岗位/), { target: { value: item.role } }); }
  return view;
}

it.each([false, true])("基线：编辑 %s 同事件提交两次只写入一次，等待中不能关闭或修改原稿", async edit => {
  await setup(edit); const pending = Promise.withResolvers<unknown>(); vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise as never);
  const original = (screen.getByLabelText(/公司名称/) as HTMLInputElement).value;
  act(() => { submit(); submit(); fireEvent.click(screen.getByRole("button", { name: "关闭弹窗" })); fireEvent.keyDown(document, { key: "Escape" }); fireEvent.click(screen.getByRole("dialog")); fireEvent.change(screen.getByLabelText(/公司名称/), { target: { value: "不能改入等待中的原稿" } }); });
  expect(writes()).toHaveLength(1); expect(props.onClose).not.toHaveBeenCalled(); expect((screen.getByLabelText(/公司名称/) as HTMLInputElement).value).toBe(original);
  await act(async () => pending.resolve({ ...item, ...JSON.parse(String(writes()[0]![1]!.body)), id: edit ? 7 : 77 }));
  expect(props.onSuccess).toHaveBeenCalledTimes(1); submit(); expect(writes()).toHaveLength(1);
});
it.each(["成功", "失败"])("基线：卸载后迟到%s不调用旧成功回调或提示", async outcome => {
  const view = await setup(); const pending = Promise.withResolvers<unknown>(); vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise as never); submit(); const signal = writes()[0]![1]!.signal;
  view.unmount(); expect(signal?.aborted).toBe(true);
  await act(async () => { if (outcome === "成功") pending.resolve(item); else pending.reject(new Error("旧请求失败")); }); expect(props.onSuccess).not.toHaveBeenCalled();
});
it("基线：切换投递重置为新记录，旧保存不关闭新弹窗", async () => {
  const view = await setup(); const pending = Promise.withResolvers<unknown>(); vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise as never); submit();
  view.rerender(<ApplicationDialog {...props} initialData={{ ...item, id: 8, company: "新投递" }} />);
  expect((screen.getByLabelText(/公司名称/) as HTMLInputElement).value).toBe("新投递"); await act(async () => pending.resolve(item)); expect(props.onSuccess).not.toHaveBeenCalled(); expect(screen.queryByRole("alert")).toBeNull();
});

it("确定拒绝后保留草稿，改正后显式重试只提交最新原稿", async () => {
  await setup(); vi.mocked(jsonFetch).mockRejectedValueOnce(new HttpError("请修正字段", 400)); submit();
  expect((await screen.findByRole("alert")).textContent).toContain("请修正字段"); await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("alert")));
  fireEvent.change(screen.getByLabelText(/公司名称/), { target: { value: "修正公司" } }); submit(); await waitFor(() => expect(props.onSuccess).toHaveBeenCalledTimes(1)); expect(writes()).toHaveLength(2); expect(JSON.parse(String(writes()[1]![1]!.body)).company).toBe("修正公司");
});
const bad = [null, {}, { ...item, id: 8 }, { ...item, company: "另一公司" }, { ...item, jd: "串 JD" }, { ...item, resume_id: 9 }, { ...item, notes: "丢失原话" }, { ...item, stage: "applied" }, { ...item, interviews: [null] }, { ...item, hiring_stage: "hr_interview" }, { ...item, flow_status: "passed" }];
it.each(bad)("编辑坏确认 %j 保留原稿并锁住写入，核对只 GET 后确认实际保存", async response => {
  await setup(); vi.mocked(jsonFetch).mockResolvedValueOnce(response); submit();
  await screen.findByRole("button", { name: "重新读取保存状态" }); expect(props.onSuccess).not.toHaveBeenCalled(); expect((screen.getByLabelText(/投递备注/) as HTMLTextAreaElement).value).toBe(item.notes);
  submit(); expect(writes()).toHaveLength(1); expect((screen.getByRole("button", { name: "更新卡片" }) as HTMLButtonElement).disabled).toBe(true);
  act(() => { screen.getByRole("button", { name: "重新读取保存状态" }).click(); screen.getByRole("button", { name: "重新读取保存状态" }).click(); });
  await waitFor(() => expect(props.onSuccess).toHaveBeenCalledTimes(1)); expect(reads()).toHaveLength(1); expect(writes()).toHaveLength(1); expect(props.onSuccess).toHaveBeenCalledWith(item);
});
it.each([new Error("网络中断"), new HttpError("等待超时", 408), new HttpError("暂不可用", 503)])("新建 %s 结果未知不自动查找同名或再次 POST，只保留草稿供核对", async reason => {
  await setup(false); vi.mocked(jsonFetch).mockRejectedValueOnce(reason); submit();
  expect((await screen.findByRole("alert")).textContent).toContain("保存结果尚未确认"); expect(screen.queryByRole("button", { name: "重新读取保存状态" })).toBeNull();
  expect(screen.getByRole("link", { name: "核对投递记录" }).getAttribute("href")).toBe("/applications"); expect(screen.getByRole("link", { name: "核对投递记录" }).getAttribute("target")).toBe("_blank");
  submit(); expect(writes()).toHaveLength(1); expect(reads()).toHaveLength(0); expect(props.onSuccess).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "关闭弹窗" })); expect(props.onClose).toHaveBeenCalledTimes(1);
});
it.each([{}, { ...item, id: 8 }, { ...item, company: "服务端其他修改" }, new HttpError("不存在", 404), new Error("读取失败")])("核对 %j 不能解除未知保护或覆盖原稿", async result => {
  await setup(); vi.mocked(jsonFetch).mockResolvedValueOnce({}); submit(); const retry = await screen.findByRole("button", { name: "重新读取保存状态" });
  if (result instanceof Error) vi.mocked(jsonFetch).mockRejectedValueOnce(result); else vi.mocked(jsonFetch).mockResolvedValueOnce(result);
  fireEvent.click(retry); await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("核对失败")); expect(props.onSuccess).not.toHaveBeenCalled(); expect((screen.getByLabelText(/投递备注/) as HTMLTextAreaElement).value).toBe(item.notes); submit(); expect(writes()).toHaveLength(1);
});
it("核对中的迟到成功随离页取消，不再调用旧回调", async () => {
  const view = await setup(); vi.mocked(jsonFetch).mockResolvedValueOnce({}); submit(); const retry = await screen.findByRole("button", { name: "重新读取保存状态" });
  const pending = Promise.withResolvers<unknown>(); vi.mocked(jsonFetch).mockReturnValueOnce(pending.promise as never); fireEvent.click(retry); const signal = reads()[0]![1]!.signal; view.unmount(); expect(signal?.aborted).toBe(true);
  await act(async () => pending.resolve(item)); expect(props.onSuccess).not.toHaveBeenCalled(); expect(writes()).toHaveLength(1);
});
