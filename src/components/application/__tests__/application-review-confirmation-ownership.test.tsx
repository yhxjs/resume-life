// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApplicationInterviewReviewDialog } from "../application-interview-review-dialog";
import { ConfirmDialogHost, confirmDialog } from "@/components/common/confirm-dialog";
import { jsonFetch } from "@/lib/fetcher";
import type { Application, ApplicationInterview } from "@/lib/applications-types";
import type { InterviewReviewResponse } from "@/lib/application-interview-review";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/lib/fetcher", () => ({ jsonFetch: vi.fn() }));
const app = { id: 8, company: "甲公司 <T> &amp; " + "长公司_".repeat(20), role: "接口开发_".repeat(20) } as Application;
const round = { id: 3, application_id: 8, round_name: "技术一面 <T> &amp;" } as ApplicationInterview;
const question = { question: "兼容性如何验证", answer: "尚未上线", stuck: "验证范围", feedback: "未记录" };
type SourceContext = { company: string; role: string; round_name: string; jd: string };
const sourceContext: SourceContext = { company: "生成时原公司 <T> &amp;", role: "生成时初级前端岗位", round_name: "生成时浏览器技术面", jd: "仅测试浏览器兼容性。" };
const recap = { id: 7, application_id: 8, interview_id: 3, input_hash: "a".repeat(64), questions: [question], created_at: "2026-11-01T01:02:03.000Z",
  source_context: null as SourceContext | null,
  result: { mistakes: [{ question_index: 1, gap: "缺少记录", improved_answer: "待确认" }], drills: [{ question_index: 1, question: "如何验证？" }], resume_suggestions: [{ question_index: 1, suggestion: "核对实际范围" }] },
  exports: { mistakes: false, drills: null as number | null, resume_suggestions: false } };
const response = { material_error: null, questions: [question], input_hash: recap.input_hash, latest: recap, selected: null, history: [{ id: 7, created_at: recap.created_at, input_hash: recap.input_hash }] } satisfies InterviewReviewResponse;
const actions = [
  { action: "discard", trigger: "关闭", title: "放弃未保存的逐题记录？", accept: "放弃编辑" },
  { action: "mistakes", trigger: "加入错题本", title: "加入错题本？", accept: "确认加入" },
  { action: "drills", trigger: "开始追练", title: "开始追练？", accept: "创建并开始" },
  { action: "resume_suggestions", trigger: "创建修改待办", title: "创建修改待办？", accept: "确认创建" },
] as const;
beforeEach(() => {
  push.mockReset(); vi.mocked(jsonFetch).mockReset().mockResolvedValue(structuredClone(response));
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([new DOMRect(0, 0, 100, 20)] as unknown as DOMRectList);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const writes = () => vi.mocked(jsonFetch).mock.calls.filter(([, init]) => init?.method);
async function setup(triggerName: string) {
  render(<ConfirmDialogHost />); const onClose = vi.fn();
  const view = render(<ApplicationInterviewReviewDialog application={app} interview={round} onClose={onClose} />);
  await screen.findByRole("textbox", { name: "怎么回答" });
  const draft = "未保存 <T> &amp;\n内部  空格";
  fireEvent.change(screen.getByRole("textbox", { name: "怎么回答" }), { target: { value: draft } });
  const trigger = screen.getByRole("button", { name: new RegExp(`^${triggerName}$`) });
  return { ...view, onClose, trigger, draft };
}
async function start(trigger: HTMLElement, title: string) { trigger.focus(); fireEvent.click(trigger); return screen.findByRole("dialog", { name: title }); }

it.each(["已知", "空JD", "未知"] as const)("追练确认展示%s来源及实际JD策略，保留当前操作身份", async kind => {
  const source = kind === "未知" ? null : { ...sourceContext, jd: kind === "空JD" ? "" : sourceContext.jd };
  vi.mocked(jsonFetch).mockResolvedValueOnce({ ...response, latest: { ...recap, source_context: source } });
  const view = await setup("开始追练");
  const dialog = await start(view.trigger, "开始追练？");
  for (const value of [app.company, app.role, round.round_name, "投递 #8", "轮次 #3", "复盘 #7"]) expect(dialog.textContent).toContain(value);
  if (source) for (const value of [source.company, source.role, source.round_name]) expect(dialog.textContent).toContain(value);
  expect(dialog.textContent).toContain(kind === "已知" ? "追练采用生成时的 JD。"
    : kind === "空JD" ? "生成时未提供 JD，追练将不附岗位背景。" : "生成时岗位资料未保存，追练将不附岗位背景。");
  fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "开始追练？" })).toBeNull());
  expect(writes()).toHaveLength(0);
});

it.each(["company", "role", "round_name", "jd", "已知改未知", "未知改已知", "缺失", "数组", "缺字段", "公司非文本", "岗位非文本", "轮次非文本", "JD非文本"] as const)("导出同摘要但来源%s异常时不导航，保留原来源并允许显式重试", async field => {
  const source = field === "未知改已知" ? null : sourceContext;
  const original = { ...recap, source_context: source };
  vi.mocked(jsonFetch).mockResolvedValueOnce({ ...response, latest: original });
  const view = await setup("开始追练");
  const completed = { ...structuredClone(original), exports: { ...recap.exports, drills: 24 } };
  const bad: Record<string, unknown> = { ...completed };
  if (field === "缺失") delete bad.source_context;
  else if (field === "数组") bad.source_context = [];
  else if (field === "缺字段") bad.source_context = { company: sourceContext.company, role: sourceContext.role, jd: sourceContext.jd };
  else if (field === "公司非文本" || field === "岗位非文本" || field === "轮次非文本" || field === "JD非文本") {
    bad.source_context = { ...sourceContext, [{ 公司非文本: "company", 岗位非文本: "role", 轮次非文本: "round_name", JD非文本: "jd" }[field]]: 123 };
  } else bad.source_context = field === "已知改未知" ? null : field === "未知改已知" ? sourceContext : { ...sourceContext, [field]: "另一份材料" };
  vi.mocked(jsonFetch).mockResolvedValueOnce({ ...response, latest: bad, selected: bad, drill_id: 24 });
  let dialog = await start(view.trigger, "开始追练？");
  fireEvent.click(within(dialog).getByRole("button", { name: "创建并开始" }));
  expect((await screen.findByRole("alert")).textContent).toContain("导出结果");
  expect(push).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "继续追练" })).toBeNull();
  expect((screen.getByRole("textbox", { name: "怎么回答" }) as HTMLTextAreaElement).value).toBe(view.draft);
  const region = screen.getByRole("region", { name: "生成时的岗位资料" });
  expect(region.textContent).toContain(source ? source.company : "生成时岗位资料未保存");
  expect(region.textContent).not.toContain("另一份材料");
  vi.mocked(jsonFetch).mockResolvedValueOnce({ ...response, latest: completed, selected: completed, drill_id: 24 });
  dialog = await start(screen.getByRole("button", { name: "开始追练" }), "开始追练？");
  fireEvent.click(within(dialog).getByRole("button", { name: "创建并开始" }));
  await waitFor(() => expect(push).toHaveBeenCalledExactlyOnceWith("/drills/24"));
  expect(writes()).toHaveLength(2);
  expect(writes().map(([, init]) => init!.body)).toEqual([JSON.stringify({ recap_id: 7, action: "drills" }), JSON.stringify({ recap_id: 7, action: "drills" })]);
});

for (const action of actions) {
  it.each(["卸载", "切换投递", "切换轮次"])(`${action.action}：%s 关闭所属确认且旧入口不能重开`, async change => {
    const view = await setup(action.trigger); await start(view.trigger, action.title);
    if (change === "卸载") view.unmount();
    else view.rerender(<ApplicationInterviewReviewDialog application={change === "切换投递" ? { ...app, id: 9 } : app} interview={change === "切换轮次" ? { ...round, id: 4 } : round} onClose={view.onClose} />);
    expect(screen.queryByRole("dialog", { name: action.title })).toBeNull();
    fireEvent.click(view.trigger); await act(async () => {}); expect(writes()).toHaveLength(0); expect(view.onClose).not.toHaveBeenCalled(); expect(push).not.toHaveBeenCalled();
  });
  it(`${action.action}：离页移除排队确认，保留其他操作顺序`, async () => {
    const view = await setup(action.trigger); act(() => { void confirmDialog({ title: "其他当前操作", message: "当前" }); });
    fireEvent.click(view.trigger); await act(async () => {});
    act(() => { void confirmDialog({ title: "其他后续操作", message: "后续" }); }); view.unmount();
    fireEvent.click(screen.getByRole("button", { name: "确定" })); expect(screen.getByRole("dialog").textContent).toContain("其他后续操作");
    fireEvent.click(screen.getByRole("button", { name: "取消" })); expect(writes()).toHaveLength(0); expect(view.onClose).not.toHaveBeenCalled();
  });
  it.each(["取消", "Escape"])(`${action.action}：重复点击只一次确认，%s 保留逐字草稿与触发焦点`, async cancel => {
    const view = await setup(action.trigger); const dialog = await start(view.trigger, action.title);
    fireEvent.click(view.trigger); fireEvent.click(screen.getByRole("button", { name: "保存逐题记录" }));
    fireEvent.click(screen.getByRole("button", { name: "关闭逐题复盘" }));
    fireEvent.change(screen.getByRole("textbox", { name: "怎么回答" }), { target: { value: "确认中另改" } });
    if (cancel === "Escape") fireEvent.keyDown(document, { key: "Escape" }); else fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(document.activeElement).toBe(view.trigger));
    expect(screen.queryByRole("dialog", { name: action.title })).toBeNull();
    expect((screen.getByRole("textbox", { name: "怎么回答" }) as HTMLTextAreaElement).value).toBe(view.draft);
    expect(writes()).toHaveLength(0); expect(view.onClose).not.toHaveBeenCalled(); expect(push).not.toHaveBeenCalled();
  });
  it(`${action.action}：展示完整投递、轮次和操作对象`, async () => {
    const view = await setup(action.trigger); const dialog = await start(view.trigger, action.title);
    for (const text of ["投递 #8", app.company, app.role, "轮次 #3", round.round_name]) expect(dialog.textContent).toContain(text);
    if (action.action !== "discard") { expect(dialog.textContent).toContain("复盘 #7"); expect(dialog.textContent).toContain(recap.created_at); expect(dialog.textContent).toContain("1"); }
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: "取消" })); });
    expect(screen.queryByRole("dialog", { name: action.title })).toBeNull(); expect(writes()).toHaveLength(0);
  });
  it(`${action.action}：接受与离页同事件不写入或调用旧关闭`, async () => {
    const view = await setup(action.trigger); const dialog = await start(view.trigger, action.title);
    act(() => { within(dialog).getByRole("button", { name: action.accept }).click(); view.unmount(); }); await act(async () => {});
    expect(writes()).toHaveLength(0); expect(view.onClose).not.toHaveBeenCalled(); expect(push).not.toHaveBeenCalled();
  });
  it(`${action.action}：明确接受仅执行一次，取消后仍能重试`, async () => {
    const view = await setup(action.trigger); let dialog = await start(view.trigger, action.title);
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" })); await act(async () => {});
    const completed = structuredClone(recap);
    if (action.action !== "discard") {
      if (action.action === "drills") completed.exports.drills = 24; else completed.exports[action.action] = true;
      vi.mocked(jsonFetch).mockResolvedValueOnce({ ...response, latest: completed, selected: completed, drill_id: action.action === "drills" ? 24 : null });
    }
    dialog = await start(view.trigger, action.title);
    const accept = within(dialog).getByRole("button", { name: action.accept });
    act(() => { accept.click(); accept.click(); });
    if (action.action === "discard") { await waitFor(() => expect(view.onClose).toHaveBeenCalledOnce()); expect(writes()).toHaveLength(0); }
    else {
      await waitFor(() => expect(writes()).toHaveLength(1));
      expect(writes()[0]![1]).toMatchObject({ method: "POST", body: JSON.stringify({ recap_id: 7, action: action.action }) });
      if (action.action === "drills") await waitFor(() => expect(push).toHaveBeenCalledExactlyOnceWith("/drills/24"));
      else await screen.findByText(action.action === "mistakes" ? "错题已加入错题本" : "简历修改待办已创建");
      expect(view.onClose).not.toHaveBeenCalled();
    }
  });
}

it.each(["投递", "轮次", "摘要", "未完成", "非法追练ID", "追练ID不一致"])("导出回包%s异常不能假报完成或跳转，可显式重试", async invalid => {
  const view = await setup("开始追练"); const completed = structuredClone(recap); completed.exports.drills = 24;
  const bad = structuredClone(completed); let drillId: number = 24;
  if (invalid === "投递") bad.application_id = 9;
  if (invalid === "轮次") bad.interview_id = 4;
  if (invalid === "摘要") bad.input_hash = "b".repeat(64);
  if (invalid === "未完成") bad.exports.drills = null;
  if (invalid === "非法追练ID") { bad.exports.drills = -1; drillId = -1; }
  if (invalid === "追练ID不一致") drillId = 25;
  vi.mocked(jsonFetch).mockResolvedValueOnce({ ...response, latest: bad, selected: bad, drill_id: drillId });
  let dialog = await start(view.trigger, "开始追练？"); fireEvent.click(within(dialog).getByRole("button", { name: "创建并开始" }));
  expect((await screen.findByRole("alert")).textContent).toContain("导出结果"); expect(push).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "继续追练" })).toBeNull(); expect((screen.getByRole("textbox", { name: "怎么回答" }) as HTMLTextAreaElement).value).toBe(view.draft);
  vi.mocked(jsonFetch).mockResolvedValueOnce({ ...response, latest: completed, selected: completed, drill_id: 24 });
  dialog = await start(screen.getByRole("button", { name: "开始追练" }), "开始追练？"); fireEvent.click(within(dialog).getByRole("button", { name: "创建并开始" }));
  await waitFor(() => expect(push).toHaveBeenCalledExactlyOnceWith("/drills/24")); expect(writes()).toHaveLength(2);
});

it.each(["mistakes", "resume_suggestions"] as const)("导出 %s 标记未完成不能报成功", async action => {
  const entry = actions.find(item => item.action === action)!; const view = await setup(entry.trigger);
  vi.mocked(jsonFetch).mockResolvedValueOnce({ ...response, drill_id: null });
  const dialog = await start(view.trigger, entry.title); fireEvent.click(within(dialog).getByRole("button", { name: entry.accept }));
  expect((await screen.findByRole("alert")).textContent).toContain("导出结果"); expect(push).not.toHaveBeenCalled();
  expect(screen.queryByText(action === "mistakes" ? "错题已加入错题本" : "简历修改待办已创建")).toBeNull();
});
