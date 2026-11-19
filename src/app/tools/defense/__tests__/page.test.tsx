// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Page from "../page";
import { HttpError, jsonFetch } from "@/lib/fetcher";
import { confirmDialog } from "@/components/common/confirm-dialog";
import type { ResumeOption } from "@/hooks/use-resume-options";

const state = vi.hoisted(() => ({
  params: new URLSearchParams(), resumes: null as ResumeOption[] | null, resumesError: "",
  push: vi.fn(), reloadResumes: vi.fn(), create: vi.fn(), history: vi.fn(), destroy: vi.fn(), detail: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: state.push }), useSearchParams: () => state.params }));
vi.mock("@/hooks/use-resume-options", () => ({ useResumeOptions: () => ({
  resumes: state.resumes, resumesError: state.resumesError, reloadResumes: state.reloadResumes,
}) }));
vi.mock("@/lib/fetcher", async (original) => ({ ...await original<typeof import("@/lib/fetcher")>(), jsonFetch: vi.fn() }));
vi.mock("@/components/common/confirm-dialog", () => ({ confirmDialog: vi.fn() }));

const first: ResumeOption = { id: 1, title: "第一份简历", versions: [{ id: 11, version: 1, name: "第一版" }] };
const second: ResumeOption = { id: 2, title: "指定的另一份简历", versions: [
  { id: 21, version: 1, name: "旧发布版" }, { id: 22, version: 2, name: "新发布版" },
] };
const historyItem = { id: 7, resumeId: null, title: "原历史报告", targetRole: "待核实岗位", riskLevel: "critical", itemCount: 1, createdAt: "2026-10-29" };
const otherHistoryItem = { ...historyItem, id: 8, title: "另一份完整报告" };
const source = "  参与校验 <T> &amp;\n尚未上线，不是独立负责。  ";
const start = () => screen.getByRole("button", { name: "开始简历排雷扫描" });
const resumeSelect = () => screen.getByRole("combobox", { name: "选择要体检排雷的简历" }) as HTMLSelectElement;
const versionSelect = () => screen.getByRole("combobox", { name: "已发布版本" }) as HTMLSelectElement;
const sourceInput = () => screen.getByRole("textbox", { name: "粘贴简历内容或项目片段：" }) as HTMLTextAreaElement;
const roleInput = () => screen.getByRole("textbox", { name: "目标应聘岗位 / 级别定位（选填）：" }) as HTMLInputElement;
const submit = (form: HTMLFormElement) => fireEvent.submit(form);
function paste() {
  fireEvent.click(screen.getByRole("button", { name: "自由粘贴文本" }));
  fireEvent.change(sourceInput(), { target: { value: source } });
  fireEvent.change(roleInput(), { target: { value: "  接口工程师 <T>  " } });
  return sourceInput().closest("form")!;
}

beforeEach(() => {
  state.params = new URLSearchParams(); state.resumes = [first, second]; state.resumesError = "";
  state.push.mockReset(); state.reloadResumes.mockReset();
  state.history.mockReset().mockResolvedValue({ items: [] });
  state.create.mockReset().mockResolvedValue({ id: 9 });
  state.destroy.mockReset().mockResolvedValue({ ok: true });
  state.detail.mockReset().mockResolvedValue({ report: { id: 7, title: historyItem.title, sourceContent: source, targetRole: historyItem.targetRole, createdAt: historyItem.createdAt }, drills: [] });
  vi.mocked(confirmDialog).mockReset().mockResolvedValue(true);
  vi.mocked(jsonFetch).mockReset().mockImplementation(async (url, init) => {
    if (/^\/api\/tools\/resume-defenses\/\d+$/.test(url)) return init?.method === "DELETE" ? state.destroy(url, init) : state.detail(url, init);
    if (url !== "/api/tools/resume-defenses") throw new Error(`意外请求 ${url}`);
    return init?.method === "POST" ? state.create(init) : state.history(init);
  });
});
afterEach(cleanup);

it("链接指定旧发布版时扫描仍使用该版，不能默认改成首份简历或最新版本", async () => {
  state.params = new URLSearchParams("resumeId=2&resumeVersionId=21");
  render(<Page />);
  await screen.findByText("暂无简历排雷记录，可以先选择简历或粘贴原文");
  expect(resumeSelect().value).toBe("2"); expect(versionSelect().value).toBe("21");
  submit(start().closest("form")!);
  await waitFor(() => expect(state.push).toHaveBeenCalledExactlyOnceWith("/tools/defense/9"));
  expect(state.create).toHaveBeenCalledOnce();
  expect(JSON.parse(state.create.mock.calls[0]![0].body)).toEqual({ targetRole: "", resumeId: 2, resume_version_id: 21 });
});

it.each(["resume", "paste"])("%s 生成从同步锁开始互斥，全部改写入口禁用，导航接受后仍锁定", async (mode) => {
  const pending = Promise.withResolvers<unknown>();
  state.create.mockReturnValueOnce(pending.promise);
  render(<Page />);
  const form = mode === "paste" ? paste() : start().closest("form")!;
  if (mode === "resume") fireEvent.change(roleInput(), { target: { value: "接口工程师" } });
  act(() => { submit(form); submit(form); });
  expect(state.create).toHaveBeenCalledOnce();
  expect(roleInput().disabled).toBe(true);
  for (const name of ["已有简历", "自由粘贴文本", "填入练习样例"]) {
    const button = screen.getByRole("button", { name }) as HTMLButtonElement;
    expect(button.disabled).toBe(true); fireEvent.click(button);
  }
  if (mode === "paste") {
    expect(sourceInput().disabled).toBe(true); expect(sourceInput().value).toBe(source);
  } else {
    expect(resumeSelect().disabled).toBe(true); expect(versionSelect().disabled).toBe(true);
  }
  expect(JSON.parse(state.create.mock.calls[0]![0].body)).toEqual(mode === "paste"
    ? { targetRole: "接口工程师 <T>", resumeContent: source.trim() }
    : { targetRole: "接口工程师", resumeId: 1, resume_version_id: 11 });
  expect(state.create.mock.calls[0]![0].signal).toBeInstanceOf(AbortSignal);
  await act(async () => pending.resolve({ id: 9 }));
  expect(state.push).toHaveBeenCalledExactlyOnceWith("/tools/defense/9");
  submit(form);
  expect(state.create).toHaveBeenCalledOnce(); expect(roleInput().disabled).toBe(true);
  expect(state.history).toHaveBeenCalledOnce();
});

it.each([null, {}, { id: "9" }, { id: 0 }, { id: -1 }, { id: 1.5 }, { id: Number.MAX_SAFE_INTEGER + 1 }])(
  "生成无效完成响应 %# 不导航，保留原稿并核对历史，允许显式重试", async (response) => {
    state.create.mockResolvedValueOnce(response).mockResolvedValueOnce({ id: 10 });
    state.history.mockResolvedValueOnce({ items: [] }).mockResolvedValueOnce({ items: [historyItem] });
    render(<Page />); const form = paste(); submit(form);
    await screen.findByText("生成响应不完整，请先核对历史记录是否已保存");
    await screen.findByRole("link", { name: /原历史报告/ });
    expect(state.push).not.toHaveBeenCalled(); expect(state.create).toHaveBeenCalledOnce();
    expect(sourceInput().value).toBe(source); expect(roleInput().value).toBe("  接口工程师 <T>  ");
    expect(sourceInput().disabled).toBe(false);
    expect(screen.getByText(/响应异常时仍可能已保存/)).toBeTruthy();
    submit(form);
    await waitFor(() => expect(state.push).toHaveBeenCalledExactlyOnceWith("/tools/defense/10"));
    expect(state.create).toHaveBeenCalledTimes(2);
  },
);

it.each(["成功", "失败"])("离页后旧生成%s不导航、不刷新历史，保留的提交也失效", async (outcome) => {
  const pending = Promise.withResolvers<unknown>(); state.create.mockReturnValueOnce(pending.promise);
  const view = render(<Page />); const form = paste(); submit(form);
  const signal = state.create.mock.calls[0]![0].signal as AbortSignal;
  view.unmount(); expect(signal.aborted).toBe(true);
  await act(async () => {
    submit(form);
    if (outcome === "成功") pending.resolve({ id: 9 }); else pending.reject(new Error("离页旧失败"));
  });
  expect(state.push).not.toHaveBeenCalled(); expect(state.create).toHaveBeenCalledOnce(); expect(state.history).toHaveBeenCalledOnce();
});

it.each(["成功", "失败"])("切换 URL 材料重建会话，旧生成%s不覆盖新表单或导航", async (outcome) => {
  const pending = Promise.withResolvers<unknown>(); state.create.mockReturnValueOnce(pending.promise);
  const view = render(<Page />); submit(start().closest("form")!);
  const signal = state.create.mock.calls[0]![0].signal as AbortSignal;
  state.params = new URLSearchParams("resumeId=2&resumeVersionId=21"); view.rerender(<Page />);
  expect(signal.aborted).toBe(true); expect(resumeSelect().value).toBe("2"); expect(versionSelect().value).toBe("21");
  await act(async () => {
    if (outcome === "成功") pending.resolve({ id: 9 }); else pending.reject(new Error("旧材料失败"));
  });
  expect(state.push).not.toHaveBeenCalled(); expect(screen.queryByText("旧材料失败")).toBeNull();
  expect(state.history).toHaveBeenCalledTimes(2);
  submit(start().closest("form")!);
  await waitFor(() => expect(state.push).toHaveBeenCalledExactlyOnceWith("/tools/defense/9"));
  expect(JSON.parse(state.create.mock.calls[1]![0].body)).toMatchObject({ resumeId: 2, resume_version_id: 21 });
});

it.each(["99", "0", "-1", "bad", "1.5", "", "9007199254740992"])("URL 简历 %s 缺失或无效时不借用首份，按钮及直接提交均阻止", async (id) => {
  state.params = new URLSearchParams({ resumeId: id }); render(<Page />);
  expect(resumeSelect().value).toBe(""); expect((start() as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole("option", { name: "请选择可用简历" })).toBeTruthy();
  expect(screen.getByText("指定或已选的简历不在当前列表中，请重新读取或手动选择。")).toBeTruthy();
  submit(start().closest("form")!); expect(state.create).not.toHaveBeenCalled();
  await screen.findByText("暂无简历排雷记录，可以先选择简历或粘贴原文");
});

it("刷新保留手选简历与旧发布版，暂时缺失不借用其他材料，重新出现可恢复", async () => {
  const view = render(<Page />);
  fireEvent.change(resumeSelect(), { target: { value: "2" } });
  fireEvent.change(versionSelect(), { target: { value: "21" } });
  state.resumes = [{ ...second, versions: [...second.versions, { id: 23, version: 3, name: "后发版" }] }, first];
  view.rerender(<Page />);
  expect(resumeSelect().value).toBe("2"); expect(versionSelect().value).toBe("21");
  state.resumes = [first]; view.rerender(<Page />);
  expect(resumeSelect().value).toBe(""); expect((start() as HTMLButtonElement).disabled).toBe(true);
  submit(start().closest("form")!); expect(state.create).not.toHaveBeenCalled();
  state.resumes = [first, second]; view.rerender(<Page />);
  expect(resumeSelect().value).toBe("2"); expect(versionSelect().value).toBe("21");
  fireEvent.click(screen.getByRole("button", { name: "自由粘贴文本" }));
  state.resumes = [second, first]; view.rerender(<Page />);
  expect(sourceInput()).toBeTruthy(); expect(screen.queryByRole("combobox", { name: "选择要体检排雷的简历" })).toBeNull();
  await screen.findByText("暂无简历排雷记录，可以先选择简历或粘贴原文");
});

it("URL 指定旧发布版缺失时不改成新版，独立重读恢复原版", async () => {
  state.params = new URLSearchParams("resumeId=2&resumeVersionId=21");
  state.resumes = [first, { ...second, versions: [second.versions[1]!] }];
  const view = render(<Page />);
  expect(resumeSelect().value).toBe("2"); expect(versionSelect().value).toBe("");
  expect((start() as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "重新读取简历列表" }));
  expect(state.reloadResumes).toHaveBeenCalledOnce(); expect(state.create).not.toHaveBeenCalled();
  state.resumes = [first, second]; view.rerender(<Page />);
  expect(versionSelect().value).toBe("21"); expect((start() as HTMLButtonElement).disabled).toBe(false);
  await screen.findByText("暂无简历排雷记录，可以先选择简历或粘贴原文");
});

it("仅有版本 URL 不默认搭配第一份简历，手动选定所属简历后恢复", async () => {
  state.params = new URLSearchParams("resumeVersionId=21"); render(<Page />);
  expect(resumeSelect().value).toBe(""); expect((start() as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("请先选择该发布版本所属的简历。")).toBeTruthy();
  fireEvent.change(resumeSelect(), { target: { value: "2" } });
  expect(resumeSelect().value).toBe("2"); expect(versionSelect().value).toBe("22");
  await screen.findByText("暂无简历排雷记录，可以先选择简历或粘贴原文");
});

it("初始没有简历不强制切换粘贴，后续首次有效列表默认首份，空白粘贴不能提交", async () => {
  state.resumes = []; const view = render(<Page />);
  expect(screen.getByText(/暂无已保存的简历/)).toBeTruthy();
  state.resumes = [second, first]; view.rerender(<Page />);
  expect(resumeSelect().value).toBe("2");
  fireEvent.click(screen.getByRole("button", { name: "自由粘贴文本" }));
  fireEvent.change(sourceInput(), { target: { value: " \n " } });
  expect((start() as HTMLButtonElement).disabled).toBe(true);
  submit(start().closest("form")!); expect(state.create).not.toHaveBeenCalled();
  await screen.findByText("暂无简历排雷记录，可以先选择简历或粘贴原文");
});

it("生成失败只刷新历史，保留手选版本，历史异常保留原记录，重试不重复生成", async () => {
  state.history.mockResolvedValueOnce({ items: [historyItem] }).mockResolvedValueOnce({ items: [historyItem, historyItem] }).mockResolvedValueOnce({ items: [] });
  state.create.mockRejectedValueOnce(new Error("上游暂不可用"));
  render(<Page />); await screen.findByRole("link", { name: /原历史报告/ });
  fireEvent.change(resumeSelect(), { target: { value: "2" } });
  fireEvent.change(versionSelect(), { target: { value: "21" } }); submit(start().closest("form")!);
  await screen.findByText(/排雷历史加载失败：排雷历史响应不完整或存在重复记录/);
  expect(screen.getByRole("link", { name: /原历史报告/ })).toBeTruthy();
  expect(resumeSelect().value).toBe("2"); expect(versionSelect().value).toBe("21");
  fireEvent.click(screen.getByRole("button", { name: "点击重试" }));
  await screen.findByText("暂无简历排雷记录，可以先选择简历或粘贴原文");
  expect(state.create).toHaveBeenCalledOnce(); expect(state.reloadResumes).not.toHaveBeenCalled();
  expect(resumeSelect().value).toBe("2"); expect(versionSelect().value).toBe("21");
});

it.each([null, {}, { items: {} }, { items: [null] }, { items: [{ ...historyItem, id: "7" }] },
  { items: [{ ...historyItem, resumeId: 0 }] }, { items: [{ ...historyItem, title: null }] },
  { items: [{ ...historyItem, riskLevel: {} }] }, { items: [{ ...historyItem, itemCount: -1 }] },
])("历史异常响应 %# 不崩溃或伪装成空列表，可独立重试", async (response) => {
  state.history.mockResolvedValueOnce(response); render(<Page />);
  await screen.findByText(/排雷历史加载失败：排雷历史响应不完整/);
  expect(screen.queryByText("暂无简历排雷记录，可以先选择简历或粘贴原文")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "点击重试" }));
  await screen.findByText("暂无简历排雷记录，可以先选择简历或粘贴原文");
  expect(state.create).not.toHaveBeenCalled();
});

it.each([null, undefined, "legacy-unknown"])("历史未知评级 %s 保留原报告，不将它认定为低风险", async (riskLevel) => {
  const title = "历史长标题_".repeat(150);
  state.history.mockResolvedValueOnce({ items: [{ ...historyItem, title, riskLevel, resumeId: undefined }] });
  render(<Page />); await screen.findByRole("link", { name: new RegExp(title) });
  expect(screen.getByText("未提供有效风险评级")).toBeTruthy();
  expect(screen.queryByText("本次未发现明确问题")).toBeNull();
  expect(screen.queryByText(/排雷历史加载失败/)).toBeNull();
});

it("StrictMode 重挂载后旧历史失败不覆盖当前结果", async () => {
  const old = Promise.withResolvers<unknown>();
  state.history.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ items: [historyItem] });
  render(<Page />, { reactStrictMode: true });
  await screen.findByRole("link", { name: /原历史报告/ });
  expect(state.history).toHaveBeenCalledTimes(2);
  expect(state.history.mock.calls[0]![0].signal.aborted).toBe(true);
  await act(async () => old.reject(new Error("旧历史失败")));
  expect(screen.queryByText(/旧历史失败/)).toBeNull();
  submit(start().closest("form")!);
  await waitFor(() => expect(state.push).toHaveBeenCalledExactlyOnceWith("/tools/defense/9"));
});

it("生成失败刷新同步作废旧历史读取，迟到旧结果不能覆盖新存档", async () => {
  const old = Promise.withResolvers<unknown>(); const next = Promise.withResolvers<unknown>();
  state.history.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
  state.create.mockRejectedValueOnce(new Error("上游失败")); render(<Page />);
  const signal = state.history.mock.calls[0]![0].signal as AbortSignal;
  submit(start().closest("form")!);
  await waitFor(() => expect(state.history).toHaveBeenCalledTimes(2)); expect(signal.aborted).toBe(true);
  await act(async () => next.resolve({ items: [historyItem] }));
  await act(async () => old.resolve({ items: [{ ...historyItem, id: 8, title: "旧请求的过期历史" }] }));
  expect(screen.getByRole("link", { name: /原历史报告/ })).toBeTruthy();
  expect(screen.queryByText("旧请求的过期历史")).toBeNull();
  expect(state.history.mock.calls[1]![0].cache).toBe("no-store");
});

async function historyPage() {
  state.history.mockResolvedValue({ items: [historyItem, otherHistoryItem] });
  const view = render(<Page />);
  await screen.findByRole("link", { name: /原历史报告/ });
  return view;
}

it("历史删除从确认起串行，取消零写入，不排队删除其他报告，保留输入草稿", async () => {
  const confirmation = Promise.withResolvers<boolean>();
  vi.mocked(confirmDialog).mockReturnValueOnce(confirmation.promise);
  await historyPage(); paste();
  const buttons = screen.getAllByRole("button", { name: "删除" });
  act(() => { fireEvent.click(buttons[0]!); fireEvent.click(buttons[1]!); });
  expect(confirmDialog).toHaveBeenCalledOnce();
  expect(vi.mocked(confirmDialog).mock.calls[0]![0].message).toContain("#7「原历史报告」");
  expect(vi.mocked(confirmDialog).mock.calls[0]![0].message).toContain("防御演练记录将一并清除");
  expect(screen.getByText("操作对象：#7「原历史报告」")).toBeTruthy();
  for (const button of buttons) expect((button as HTMLButtonElement).disabled).toBe(true);
  await act(async () => confirmation.resolve(false));
  expect(state.destroy).not.toHaveBeenCalled(); expect(state.detail).not.toHaveBeenCalled();
  for (const button of buttons) expect((button as HTMLButtonElement).disabled).toBe(false);
  expect(sourceInput().value).toBe(source); expect(roleInput().value).toBe("  接口工程师 <T>  ");
});

it("确认删除后过滤已删 ID，列表失败或旧列表残留都不复活，重试只读且不丢草稿", async () => {
  await historyPage(); paste();
  state.history.mockRejectedValueOnce(new Error("列表刷新失败"));
  fireEvent.click(screen.getAllByRole("button", { name: "删除" })[0]!);
  await screen.findByText(/排雷历史加载失败：列表刷新失败/);
  expect(screen.getByText("已确认记录 #7 不存在，已请求刷新历史列表。")).toBeTruthy();
  expect(screen.queryByRole("link", { name: /原历史报告/ })).toBeNull();
  expect(screen.getByRole("link", { name: /另一份完整报告/ })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "点击重试" }));
  await waitFor(() => expect(screen.queryByText(/排雷历史加载失败/)).toBeNull());
  expect(screen.queryByRole("link", { name: /原历史报告/ })).toBeNull();
  expect(screen.getAllByRole("button", { name: "删除" })).toHaveLength(1);
  expect(state.destroy).toHaveBeenCalledOnce(); expect(state.detail).not.toHaveBeenCalled();
  expect(state.reloadResumes).not.toHaveBeenCalled(); expect(state.create).not.toHaveBeenCalled();
  expect(sourceInput().value).toBe(source); expect(roleInput().value).toBe("  接口工程师 <T>  ");
});

it("删除待核对状态不因生成失败和历史刷新丢失，只读恢复后移除旧列表残留", async () => {
  await historyPage(); const form = paste();
  state.destroy.mockResolvedValueOnce({ ok: false });
  state.detail.mockRejectedValueOnce(new Error("状态读取失败")).mockRejectedValueOnce(new HttpError("已删除", 404));
  fireEvent.click(screen.getAllByRole("button", { name: "删除" })[0]!);
  await screen.findByText(/删除结果尚未确认/);
  state.create.mockRejectedValueOnce(new Error("生成失败")); submit(form);
  await screen.findByText("生成失败");
  await waitFor(() => expect(state.history).toHaveBeenCalledTimes(2));
  expect(screen.getByText(/删除结果尚未确认/)).toBeTruthy();
  for (const button of screen.getAllByRole("button", { name: "删除" })) expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "重新读取删除状态" }));
  await screen.findByText("已确认记录 #7 不存在，已请求刷新历史列表。");
  expect(screen.queryByRole("link", { name: /原历史报告/ })).toBeNull();
  expect(state.destroy).toHaveBeenCalledOnce(); expect(state.detail).toHaveBeenCalledTimes(2);
  expect(state.create).toHaveBeenCalledOnce(); expect(sourceInput().value).toBe(source);
});

it("核对报告仍存在时保留错误与记录，只有显式再次确认才重试删除", async () => {
  await historyPage(); state.destroy.mockRejectedValueOnce(new Error("写入响应丢失"));
  fireEvent.click(screen.getAllByRole("button", { name: "删除" })[0]!);
  await screen.findByText(/记录 #7 目前仍存在/);
  expect(state.destroy).toHaveBeenCalledOnce(); expect(state.history).toHaveBeenCalledOnce();
  const button = screen.getAllByRole("button", { name: "删除" })[0]!;
  expect((button as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(button);
  await screen.findByText("已确认记录 #7 不存在，已请求刷新历史列表。");
  expect(confirmDialog).toHaveBeenCalledTimes(2); expect(state.destroy).toHaveBeenCalledTimes(2);
  expect(state.detail).toHaveBeenCalledOnce(); expect(screen.queryByRole("link", { name: /原历史报告/ })).toBeNull();
});

it.each(["confirm", "delete", "check"])("切换材料后旧 %s 不删除或刷新新会话", async (phase) => {
  const pending = Promise.withResolvers<unknown>();
  const view = await historyPage();
  if (phase === "confirm") vi.mocked(confirmDialog).mockReturnValueOnce(pending.promise as Promise<boolean>);
  else if (phase === "delete") state.destroy.mockReturnValueOnce(pending.promise);
  else { state.destroy.mockRejectedValueOnce(new Error("响应损坏")); state.detail.mockReturnValueOnce(pending.promise); }
  fireEvent.click(screen.getAllByRole("button", { name: "删除" })[0]!);
  if (phase !== "confirm") await waitFor(() => expect(phase === "check" ? state.detail : state.destroy).toHaveBeenCalledOnce());
  const signal = phase === "confirm" ? null : (phase === "check" ? state.detail : state.destroy).mock.calls[0]![1].signal as AbortSignal;
  state.params = new URLSearchParams("resumeId=2&resumeVersionId=21"); view.rerender(<Page />);
  await waitFor(() => expect(state.history).toHaveBeenCalledTimes(2));
  expect(signal?.aborted ?? true).toBe(true);
  fireEvent.change(roleInput(), { target: { value: "新会话岗位" } });
  await act(async () => {
    if (phase === "check") pending.reject(new HttpError("旧报告不存在", 404));
    else pending.resolve(phase === "confirm" ? true : { ok: true });
  });
  expect(state.destroy).toHaveBeenCalledTimes(phase === "confirm" ? 0 : 1);
  expect(state.history).toHaveBeenCalledTimes(2); expect(state.push).not.toHaveBeenCalled();
  expect(screen.queryByText(/已确认记录 #7 不存在/)).toBeNull();
  expect(roleInput().value).toBe("新会话岗位"); expect(screen.getByRole("link", { name: /原历史报告/ })).toBeTruthy();
});
