// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { ApplicationInterviewReviewDialog } from "../application-interview-review-dialog";
import type { Application, ApplicationInterview } from "@/lib/applications-types";

const controls = vi.hoisted(() => ({ confirm: vi.fn(), push: vi.fn() }));
vi.mock("@/components/common/confirm-dialog", () => ({ confirmDialog: controls.confirm }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: controls.push }) }));

const app = { id: 8, company: "甲公司", role: "前端工程师" } as Application;
const round = { id: 3, application_id: 8, round_name: "技术一面" } as ApplicationInterview;
const question = { question: "如何处理高并发？", answer: "用了缓存", stuck: "一致性没讲清", feedback: "继续解释" };
type SourceContext = { company: string; role: string; round_name: string; jd: string };
const sourceContext: SourceContext = {
  company: "生成时公司 <T> &amp;", role: "生成时前端岗位", round_name: "生成时技术面",
  jd: "仅讨论浏览器测试 <template> &amp;\n内部  空格与 C:\\new\\resume，尚未上线。",
};
const result = {
  mistakes: [{ question_index: 1, gap: "缺少一致性", improved_answer: "说明失效策略" }],
  drills: [{ question_index: 1, question: "缓存击穿怎么办？" }],
  resume_suggestions: [{ question_index: 1, suggestion: "补充量化结果" }],
};

function historyResponse(selectedId?: number, hash = "a".repeat(64), interviewId = round.id, source: SourceContext | null = null) {
  const recaps = [3, 2, 1].map((id) => ({
    id, application_id: app.id, interview_id: interviewId, questions: [question],
    result: { ...result, mistakes: [{ ...result.mistakes[0]!, gap: `版本${id}的点评` }] },
    exports: { mistakes: false, drills: null as number | null, resume_suggestions: false },
    created_at: "2026-09-29T00:00:00.000Z", input_hash: "a".repeat(64), source_context: source,
  }));
  return { questions: [question], input_hash: hash, material_error: null, latest: recaps[0]!,
    selected: recaps.find((recap) => recap.id === selectedId) ?? null,
    history: recaps.map(({ id, created_at, input_hash }) => ({ id, created_at, input_hash })) };
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); controls.confirm.mockReset(); controls.push.mockReset(); });

const materialError = "参考简历材料损坏，请先修复职业模块或恢复有效备份后再生成";
const blockedResponse = (selectedId?: number) => ({ ...historyResponse(selectedId), input_hash: null, material_error: materialError });

class ReviewBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <p>复盘渲染失败</p> : this.props.children; }
}

it.each(["已知", "空JD", "未知"] as const)("生成时来源%s独立显示，原JD逐字保留且不借用当前投递", async kind => {
  const source = kind === "未知" ? null : { ...sourceContext, jd: kind === "空JD" ? "" : sourceContext.jd };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(historyResponse(undefined, "a".repeat(64), round.id, source))));
  render(<ApplicationInterviewReviewDialog application={app} interview={round} onClose={() => {}} />);
  await screen.findByText("版本3的点评");
  const region = screen.getByRole("region", { name: "生成时的岗位资料" });
  expect(region.textContent).not.toContain(app.company);
  expect(region.textContent).not.toContain(app.role);
  expect(region.textContent).not.toContain(round.round_name);
  if (source) {
    for (const value of [source.company, source.role, source.round_name]) expect(region.textContent).toContain(value);
    if (source.jd) {
      const summary = within(region).getByText("查看生成时的 JD");
      expect(summary.tagName).toBe("SUMMARY");
      const details = summary.closest("details")!;
      expect(details).toBeTruthy();
      fireEvent.click(summary);
      const raw = within(region).getByText((_, element) => element?.textContent === source.jd);
      expect(raw.textContent).toBe(source.jd);
      expect(raw.querySelector("template")).toBeNull();
    } else expect(region.textContent).toContain("生成时未提供 JD");
  } else {
    expect(region.textContent).toContain("生成时岗位资料未保存");
    expect(within(region).queryByText("查看生成时的 JD")).toBeNull();
  }
});

it("切换历史复盘同步读取各版本来源，未知旧版不继承新版本或当前岗位", async () => {
  const latest = historyResponse(undefined, "a".repeat(64), round.id, sourceContext);
  const previous = historyResponse(2, "a".repeat(64), round.id, { ...sourceContext, company: "更早的原始公司", jd: "" });
  const legacy = historyResponse(1);
  const fetch = vi.fn(async (url: string) => Response.json(url.endsWith("?recap_id=2") ? previous : url.endsWith("?recap_id=1") ? legacy : latest));
  vi.stubGlobal("fetch", fetch);
  render(<ApplicationInterviewReviewDialog application={app} interview={round} onClose={() => {}} />);
  await screen.findByText("版本3的点评");
  expect(screen.getByRole("region", { name: "生成时的岗位资料" }).textContent).toContain(sourceContext.jd);
  fireEvent.change(screen.getByRole("combobox", { name: "复盘版本" }), { target: { value: "2" } });
  await screen.findByText("版本2的点评");
  expect(screen.getByRole("region", { name: "生成时的岗位资料" }).textContent).toContain("更早的原始公司");
  expect(screen.getByRole("region", { name: "生成时的岗位资料" }).textContent).toContain("生成时未提供 JD");
  fireEvent.change(screen.getByRole("combobox", { name: "复盘版本" }), { target: { value: "1" } });
  await screen.findByText("版本1的点评");
  const unknown = screen.getByRole("region", { name: "生成时的岗位资料" });
  expect(unknown.textContent).toContain("生成时岗位资料未保存");
  expect(unknown.textContent).not.toContain(sourceContext.company);
  expect(unknown.textContent).not.toContain("更早的原始公司");
  fireEvent.change(screen.getByRole("combobox", { name: "复盘版本" }), { target: { value: "3" } });
  await screen.findByText("版本3的点评");
  expect(screen.getByRole("region", { name: "生成时的岗位资料" }).textContent).toContain(sourceContext.jd);
  expect(fetch).toHaveBeenCalledTimes(3);
});

it.each(["缺失", "数组", "缺字段", "公司非文本", "岗位非文本", "轮次非文本", "JD非文本"] as const)("首读来源%s时拒绝整份回包，显式重读才能恢复", async kind => {
  const bad = historyResponse(undefined, "a".repeat(64), round.id, sourceContext);
  const recap = bad.latest as Record<string, unknown>;
  if (kind === "缺失") delete recap.source_context;
  else if (kind === "数组") recap.source_context = [];
  else if (kind === "缺字段") recap.source_context = { company: sourceContext.company, role: sourceContext.role, jd: sourceContext.jd };
  else recap.source_context = { ...sourceContext, [{ 公司非文本: "company", 岗位非文本: "role", 轮次非文本: "round_name", JD非文本: "jd" }[kind]!]: 123 };
  const fetch = vi.fn().mockResolvedValueOnce(Response.json(bad)).mockResolvedValueOnce(Response.json(historyResponse()));
  vi.stubGlobal("fetch", fetch);
  render(<ReviewBoundary><ApplicationInterviewReviewDialog application={app} interview={round} onClose={() => {}} /></ReviewBoundary>);
  expect((await screen.findByRole("alert")).textContent).toContain("响应不完整");
  expect(screen.queryByText("版本3的点评")).toBeNull();
  expect(screen.queryByText("复盘渲染失败")).toBeNull();
  expect(screen.queryByRole("button", { name: "开始追练" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
  await screen.findByText("版本3的点评");
  expect(screen.getByRole("region", { name: "生成时的岗位资料" }).textContent).toContain("生成时岗位资料未保存");
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("首读不完整的成功回包显示重试入口，不能进入崩溃状态", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(Response.json({ ...historyResponse(), questions: {} }))
    .mockResolvedValueOnce(Response.json({ ...historyResponse(), material_error: null }));
  vi.stubGlobal("fetch", fetch);
  render(<ReviewBoundary><ApplicationInterviewReviewDialog application={app} interview={round} onClose={() => {}} /></ReviewBoundary>);
  expect((await screen.findByRole("alert")).textContent).toContain("响应不完整");
  expect(screen.queryByText("复盘渲染失败")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "重试加载" }));
  await screen.findByText("版本3的点评");
});

it.each(["缺少题目", "结果字段损坏", "状态矛盾", "其他轮次"])("材料重读的%s回包保留原历史并允许再次重读", async kind => {
  const bad = { ...historyResponse(), material_error: null } as Record<string, unknown>;
  if (kind === "缺少题目") delete bad.questions;
  if (kind === "结果字段损坏") (bad.latest as ReturnType<typeof historyResponse>["latest"]).result.mistakes = null as never;
  if (kind === "状态矛盾") bad.input_hash = null;
  if (kind === "其他轮次") (bad.latest as ReturnType<typeof historyResponse>["latest"]).interview_id = 99;
  const fetch = vi.fn().mockResolvedValueOnce(Response.json(blockedResponse()))
    .mockResolvedValueOnce(Response.json(bad))
    .mockResolvedValueOnce(Response.json({ ...historyResponse(), material_error: null }));
  vi.stubGlobal("fetch", fetch);
  render(<ReviewBoundary><ApplicationInterviewReviewDialog application={app} interview={round} onClose={() => {}} /></ReviewBoundary>);
  fireEvent.click(await screen.findByRole("button", { name: "修复后重新加载" }));
  expect((await screen.findByRole("alert")).textContent).toContain("响应不完整");
  expect(screen.getByText("版本3的点评")).toBeTruthy();
  expect(screen.getByText(materialError)).toBeTruthy();
  expect(screen.queryByText("复盘渲染失败")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "修复后重新加载" }));
  await waitFor(() => expect(screen.queryByText(materialError)).toBeNull());
  expect((screen.getByRole("textbox", { name: "怎么回答" }) as HTMLTextAreaElement).readOnly).toBe(false);
});

it("历史回包的版本 ID 相同但归属其他投递时，保留当前复盘和草稿", async () => {
  const bad = historyResponse(1);
  bad.selected!.application_id = 99;
  const fetch = vi.fn(async (url: string) => Response.json(url.includes("?recap_id=") ? bad : historyResponse()));
  vi.stubGlobal("fetch", fetch);
  render(<ApplicationInterviewReviewDialog application={app} interview={round} onClose={() => {}} />);
  await screen.findByText("版本3的点评");
  fireEvent.change(screen.getByRole("textbox", { name: "怎么回答" }), { target: { value: "未保存的原答" } });
  fireEvent.change(screen.getByRole("combobox", { name: "复盘版本" }), { target: { value: "1" } });
  expect((await screen.findByRole("alert")).textContent).toContain("响应不完整");
  expect(screen.getByText("版本3的点评")).toBeTruthy();
  expect(screen.getByDisplayValue("未保存的原答")).toBeTruthy();
  expect(screen.queryByText("版本1的点评")).toBeNull();
});

it("保存成功回包仍为旧草稿时不丢失本地编辑，按原摘要重试并接受服务端去除首尾空白", async () => {
  let writes = 0;
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method !== "PUT" || ++writes === 1) return Response.json(historyResponse());
    return Response.json({ ...historyResponse(undefined, "b".repeat(64)), material_error: null,
      questions: [{ ...question, answer: "本地新回答" }] });
  });
  vi.stubGlobal("fetch", fetch);
  render(<ApplicationInterviewReviewDialog application={app} interview={round} onClose={() => {}} />);
  await screen.findByText("版本3的点评");
  fireEvent.change(screen.getByRole("textbox", { name: "怎么回答" }), { target: { value: " 本地新回答 \n" } });
  fireEvent.click(screen.getByRole("button", { name: "保存逐题记录" }));
  expect((await screen.findByRole("alert")).textContent).toContain("保存结果");
  expect(screen.queryByText("逐题记录已保存")).toBeNull();
  expect((screen.getByRole("textbox", { name: "怎么回答" }) as HTMLTextAreaElement).value).toBe(" 本地新回答 \n");
  fireEvent.click(screen.getByRole("button", { name: "保存逐题记录" }));
  await screen.findByText("逐题记录已保存");
  expect(screen.getByDisplayValue("本地新回答")).toBeTruthy();
  const bodies = fetch.mock.calls.filter(([, init]) => init?.method === "PUT").map(([, init]) => JSON.parse(String(init!.body)));
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toEqual(bodies[1]);
});

it.each(["没有结果", "旧摘要", "错配原题"])("生成成功回包%s时不误报归档成功，保留旧复盘并可显式重试", async kind => {
  const hash = "b".repeat(64);
  const initial = historyResponse(undefined, hash);
  const completed = historyResponse(undefined, hash);
  completed.latest.input_hash = hash;
  completed.history[0]!.input_hash = hash;
  const bad = structuredClone(completed);
  if (kind === "没有结果") { bad.latest = null as never; bad.history = []; }
  if (kind === "旧摘要") { bad.latest.input_hash = "a".repeat(64); bad.history[0]!.input_hash = "a".repeat(64); }
  if (kind === "错配原题") bad.latest.questions = [{ ...question, answer: "其他原答" }];
  let posts = 0;
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => Response.json(init?.method === "POST" ? (++posts === 1 ? bad : completed) : initial));
  vi.stubGlobal("fetch", fetch);
  render(<ApplicationInterviewReviewDialog application={app} interview={round} onClose={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "确认并生成复盘" }));
  expect((await screen.findByRole("alert")).textContent).toContain("生成结果");
  expect(screen.queryByText("复盘结果已保存")).toBeNull();
  expect(screen.getByText("版本3的点评")).toBeTruthy();
  expect((screen.getByRole("button", { name: "确认并生成复盘" }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "确认并生成复盘" }));
  await screen.findByText("复盘结果已保存");
  expect(posts).toBe(2);
});

it.each(["mistakes", "drills", "resume_suggestions"] as const)("材料不可用时仍可选择历史并导出 %s，导出不恢复草稿写入", async action => {
  const exported = historyResponse(1, "b".repeat(64));
  if (action === "drills") exported.selected!.exports.drills = 24;
  else exported.selected!.exports[action] = true;
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith("/export")) return Response.json({ ...exported, material_error: null, drill_id: action === "drills" ? 24 : null });
    return Response.json(blockedResponse(url.endsWith("?recap_id=1") ? 1 : undefined));
  });
  vi.stubGlobal("fetch", fetch);
  controls.confirm.mockResolvedValue(true);
  render(<ApplicationInterviewReviewDialog application={app} interview={round} onClose={() => {}} />);
  await screen.findByText("版本3的点评");
  expect(screen.getByText(materialError)).toBeTruthy();
  expect((screen.getByRole("textbox", { name: "怎么回答" }) as HTMLTextAreaElement).readOnly).toBe(true);
  for (const name of ["添加题目", "删除本题", "保存逐题记录", "确认并生成复盘"]) {
    expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
  }
  fireEvent.change(screen.getByRole("combobox", { name: "复盘版本" }), { target: { value: "1" } });
  await screen.findByText("版本1的点评");
  const labels = { mistakes: "加入错题本", drills: "开始追练", resume_suggestions: "创建修改待办" };
  fireEvent.click(screen.getByRole("button", { name: labels[action] }));
  if (action === "drills") await waitFor(() => expect(controls.push).toHaveBeenCalledWith("/drills/24"));
  else await screen.findByRole("button", { name: action === "mistakes" ? "已加入错题本" : "已创建待办" });
  expect(screen.getByText(materialError)).toBeTruthy();
  expect((screen.getByRole("button", { name: "确认并生成复盘" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("textbox", { name: "怎么回答" }) as HTMLTextAreaElement).value).toBe(question.answer);
});

it("修复材料后显式重读恢复编辑，失败或仍损坏时保留记录且不自动生成", async () => {
  const hash = "b".repeat(64);
  let reads = 0;
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const confirmed = historyResponse(undefined, hash);
      confirmed.latest.input_hash = hash;
      confirmed.history[0]!.input_hash = hash;
      return Response.json(confirmed);
    }
    reads++;
    if (reads === 2) return Response.json({ error: "重读暂时失败" }, { status: 503 });
    return Response.json(reads < 4 ? blockedResponse() : { ...historyResponse(undefined, hash), material_error: null });
  });
  vi.stubGlobal("fetch", fetch);
  render(<ApplicationInterviewReviewDialog application={app} interview={round} onClose={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "修复后重新加载" }));
  await screen.findByText("重读暂时失败");
  expect(screen.getByText("版本3的点评")).toBeTruthy();
  expect(screen.getByText(materialError)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "修复后重新加载" }));
  await waitFor(() => expect(reads).toBe(3));
  await waitFor(() => expect((screen.getByRole("button", { name: "修复后重新加载" }) as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByRole("button", { name: "确认并生成复盘" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "修复后重新加载" }));
  await waitFor(() => expect(screen.queryByText(materialError)).toBeNull());
  expect((screen.getByRole("textbox", { name: "怎么回答" }) as HTMLTextAreaElement).readOnly).toBe(false);
  expect(fetch.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "确认并生成复盘" }));
  await screen.findByText("复盘结果已保存");
  const sent = fetch.mock.calls.find(([, init]) => init?.method === "POST")![1]!;
  expect(JSON.parse(String(sent.body))).toEqual({ expected_hash: hash });
});

it.each(["成功", "失败"])("修复重读中切换轮次，晚到%s不能恢复旧轮次", async outcome => {
  const pending = Promise.withResolvers<Response>();
  let reads = 0;
  const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async url => {
    if (url.includes("/interviews/4/")) return Response.json({ ...historyResponse(), material_error: null, latest: null, history: [], questions: [{ ...question, answer: "另一轮原答" }] });
    return ++reads === 1 ? Response.json(blockedResponse()) : pending.promise;
  });
  vi.stubGlobal("fetch", fetch);
  const view = render(<ApplicationInterviewReviewDialog application={app} interview={round} onClose={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "修复后重新加载" }));
  await waitFor(() => expect(reads).toBe(2));
  view.rerender(<ApplicationInterviewReviewDialog application={app} interview={{ ...round, id: 4 }} onClose={() => {}} />);
  await screen.findByDisplayValue("另一轮原答");
  await act(async () => { pending.resolve(outcome === "成功" ? Response.json(historyResponse()) : Response.json({ error: "旧请求失败" }, { status: 503 })); });
  expect(screen.getByDisplayValue("另一轮原答")).toBeTruthy();
  expect(fetch.mock.calls[1]![1]!.signal!.aborted).toBe(true);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(controls.push).not.toHaveBeenCalled();
});


it("回看历史不推进草稿保存基线，其他页面的新记录仍触发冲突且保留本地编辑", async () => {
  const currentHash = "b".repeat(64);
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("?recap_id=")) return Response.json({ ...historyResponse(1, currentHash), questions: [{ ...question, answer: "另一页面已保存的新回答" }] });
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      return body.expected_hash === currentHash
        ? Response.json({ ...historyResponse(undefined, currentHash), questions: body.questions })
        : Response.json({ error: "面试或投递资料已变化，请刷新后重试" }, { status: 409 });
    }
    return Response.json(historyResponse());
  });
  vi.stubGlobal("fetch", fetch);
  render(<ApplicationInterviewReviewDialog application={app} interview={round} onClose={() => {}} />);
  await screen.findByText("版本3的点评");
  fireEvent.change(screen.getByRole("textbox", { name: "怎么回答" }), { target: { value: "本地尚未保存的补充" } });
  fireEvent.change(screen.getByRole("combobox", { name: "复盘版本" }), { target: { value: "1" } });
  await screen.findByText("版本1的点评");
  fireEvent.click(screen.getByRole("button", { name: "保存逐题记录" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method: "PUT" })));
  const submitted = fetch.mock.calls.find(([, init]) => init?.method === "PUT")![1]!;
  expect(JSON.parse(String(submitted.body))).toMatchObject({ expected_hash: "a".repeat(64), questions: [{ ...question, answer: "本地尚未保存的补充" }] });
  expect((await screen.findByRole("alert")).textContent).toContain("资料已变化");
  expect((screen.getByRole("textbox", { name: "怎么回答" }) as HTMLTextAreaElement).value).toBe("本地尚未保存的补充");
});

it.each(["成功", "失败"])("较早的历史读取晚到%s，不覆盖最后选择的复盘或错误状态", async (outcome) => {
  const old = Promise.withResolvers<Response>();
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith("?recap_id=1")) return old.promise;
    if (url.endsWith("?recap_id=2")) return Response.json(historyResponse(2));
    return Response.json(historyResponse());
  });
  vi.stubGlobal("fetch", fetch);
  render(<ApplicationInterviewReviewDialog application={app} interview={round} onClose={() => {}} />);
  await screen.findByText("版本3的点评");
  fireEvent.change(screen.getByRole("combobox", { name: "复盘版本" }), { target: { value: "1" } });
  fireEvent.change(screen.getByRole("combobox", { name: "复盘版本" }), { target: { value: "2" } });
  await screen.findByText("版本2的点评");
  await act(async () => {
    old.resolve(outcome === "成功" ? Response.json(historyResponse(1)) : Response.json({ error: "旧版本读取错误" }, { status: 503 }));
  });
  expect((screen.getByRole("combobox", { name: "复盘版本" }) as HTMLSelectElement).value).toBe("2");
  expect(screen.getByText("版本2的点评")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it.each(["成功", "失败"])("切回最新复盘后，历史读取晚到%s也不能恢复旧选择", async (outcome) => {
  const pending = Promise.withResolvers<Response>();
  const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) => url.includes("?recap_id=") ? pending.promise : Response.json(historyResponse()));
  vi.stubGlobal("fetch", fetch);
  render(<ApplicationInterviewReviewDialog application={app} interview={round} onClose={() => {}} />);
  await screen.findByText("版本3的点评");
  fireEvent.change(screen.getByRole("combobox", { name: "复盘版本" }), { target: { value: "1" } });
  expect(screen.queryByRole("button", { name: "加入错题本" })).toBeNull();
  fireEvent.change(screen.getByRole("combobox", { name: "复盘版本" }), { target: { value: "3" } });
  await act(async () => { pending.resolve(outcome === "成功" ? Response.json(historyResponse(1)) : Response.json({ error: "旧错误" }, { status: 503 })); });
  expect(screen.getByText("版本3的点评")).toBeTruthy();
  expect((screen.getByRole("combobox", { name: "复盘版本" }) as HTMLSelectElement).value).toBe("3");
  expect(fetch.mock.calls.find(([url]) => url.includes("?recap_id="))![1]!.signal!.aborted).toBe(true);
  expect(screen.queryByRole("alert")).toBeNull();
});

it.each(["mistakes", "drills", "resume_suggestions"] as const)("导出 %s 只更新本版本标记，不推进本地草稿的保存基线", async (action) => {
  const hash = "b".repeat(64);
  const exported = historyResponse(3, hash);
  if (action === "drills") exported.selected!.exports.drills = 24;
  else exported.selected!.exports[action] = true;
  exported.latest = { ...exported.latest, id: 4, input_hash: hash };
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/export")) return Response.json({ ...exported, drill_id: action === "drills" ? 24 : null, questions: [{ ...question, answer: "另一页面的新记录" }] });
    if (init?.method === "PUT") return Response.json({ error: "资料已变化，请刷新后重试" }, { status: 409 });
    return Response.json(historyResponse());
  });
  vi.stubGlobal("fetch", fetch);
  controls.confirm.mockResolvedValue(true);
  render(<ApplicationInterviewReviewDialog application={app} interview={round} onClose={() => {}} />);
  await screen.findByText("版本3的点评");
  fireEvent.change(screen.getByRole("textbox", { name: "怎么回答" }), { target: { value: "本地尚未保存的补充" } });
  const label = { mistakes: "加入错题本", drills: "开始追练", resume_suggestions: "创建修改待办" }[action];
  fireEvent.click(screen.getByRole("button", { name: label }));
  await screen.findByRole("button", { name: { mistakes: "已加入错题本", drills: "继续追练", resume_suggestions: "已创建待办" }[action] });
  expect(screen.getByText("版本3的点评")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "保存逐题记录" }));
  await screen.findByRole("alert");
  const submitted = fetch.mock.calls.find(([, init]) => init?.method === "PUT")![1]!;
  expect(JSON.parse(String(submitted.body)).expected_hash).toBe("a".repeat(64));
  expect((screen.getByRole("textbox", { name: "怎么回答" }) as HTMLTextAreaElement).value).toBe("本地尚未保存的补充");
});

it.each(["成功", "失败"])("保存取消在途历史读取，旧读取晚到%s不替换已保存的草稿或复盘", async (outcome) => {
  const pending = Promise.withResolvers<Response>();
  const saved = historyResponse(undefined, "c".repeat(64));
  saved.questions = [{ ...question, answer: "本次保存的回答" }];
  saved.latest = { ...saved.latest, id: 4, input_hash: saved.input_hash,
    result: { ...result, mistakes: [{ ...result.mistakes[0]!, gap: "保存后当前复盘" }] } };
  saved.history.unshift({ id: 4, created_at: saved.latest.created_at, input_hash: saved.input_hash });
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("?recap_id=")) return pending.promise;
    return Response.json(init?.method === "PUT" ? saved : historyResponse());
  });
  vi.stubGlobal("fetch", fetch);
  render(<ApplicationInterviewReviewDialog application={app} interview={round} onClose={() => {}} />);
  await screen.findByText("版本3的点评");
  fireEvent.change(screen.getByRole("textbox", { name: "怎么回答" }), { target: { value: "本次保存的回答" } });
  fireEvent.change(screen.getByRole("combobox", { name: "复盘版本" }), { target: { value: "1" } });
  fireEvent.click(screen.getByRole("button", { name: "保存逐题记录" }));
  await screen.findByText("逐题记录已保存");
  await act(async () => { pending.resolve(outcome === "成功" ? Response.json(historyResponse(1)) : Response.json({ error: "旧错误" }, { status: 503 })); });
  expect(screen.getByText("保存后当前复盘")).toBeTruthy();
  expect((screen.getByRole("textbox", { name: "怎么回答" }) as HTMLTextAreaElement).value).toBe("本次保存的回答");
  expect(screen.queryByRole("alert")).toBeNull();
});

it.each([null, 2])("历史响应未提供所选版本（selected=%s）时明确报错，保留原版本供重试", async (selectedId) => {
  const fetch = vi.fn(async (url: string) => Response.json(url.includes("?recap_id=") ? historyResponse(selectedId ?? undefined) : historyResponse()));
  vi.stubGlobal("fetch", fetch);
  render(<ApplicationInterviewReviewDialog application={app} interview={round} onClose={() => {}} />);
  await screen.findByText("版本3的点评");
  fireEvent.change(screen.getByRole("combobox", { name: "复盘版本" }), { target: { value: "1" } });
  expect((await screen.findByRole("alert")).textContent).toContain("未读取到所选复盘");
  expect((screen.getByRole("combobox", { name: "复盘版本" }) as HTMLSelectElement).value).toBe("3");
  expect(screen.getByText("版本3的点评")).toBeTruthy();
  fetch.mockImplementation(async (url) => Response.json(url.includes("?recap_id=") ? historyResponse(1) : historyResponse()));
  fireEvent.change(screen.getByRole("combobox", { name: "复盘版本" }), { target: { value: "1" } });
  await screen.findByText("版本1的点评");
  expect(screen.queryByRole("alert")).toBeNull();
});

it("已载入的草稿和复盘在切换轮次时立即清空，新轮次等待期间不能编辑旧记录", async () => {
  const pending = Promise.withResolvers<Response>();
  const fetch = vi.fn(async (url: string) => url.includes("/interviews/4/") ? pending.promise : Response.json(historyResponse()));
  vi.stubGlobal("fetch", fetch);
  const view = render(<ApplicationInterviewReviewDialog application={app} interview={round} onClose={() => {}} />);
  await screen.findByText("版本3的点评");
  fireEvent.change(screen.getByRole("textbox", { name: "怎么回答" }), { target: { value: "一面未保存的草稿" } });
  view.rerender(<ApplicationInterviewReviewDialog application={app} interview={{ ...round, id: 4, round_name: "技术二面" }} onClose={() => {}} />);
  expect(screen.getByText("正在加载逐题记录…")).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "怎么回答" })).toBeNull();
  expect(screen.queryByText("版本3的点评")).toBeNull();
  await act(async () => { pending.resolve(Response.json({ questions: [{ ...question, answer: "二面的记录" }], input_hash: "d".repeat(64), material_error: null, latest: null, selected: null, history: [] })); });
  expect((screen.getByRole("textbox", { name: "怎么回答" }) as HTMLTextAreaElement).value).toBe("二面的记录");
  expect((screen.getByRole("button", { name: "保存逐题记录" }) as HTMLButtonElement).disabled).toBe(true);
});

it("初次加载失败后的重试在切换轮次时取消，晚到结果不串入新轮次", async () => {
  const oldRetry = Promise.withResolvers<Response>();
  const next = Promise.withResolvers<Response>();
  let attempts = 0;
  const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) => {
    if (url.includes("/interviews/4/")) return next.promise;
    attempts += 1;
    if (attempts === 1) return Response.json({ error: "首次读取失败" }, { status: 503 });
    return oldRetry.promise;
  });
  vi.stubGlobal("fetch", fetch);
  const view = render(<ApplicationInterviewReviewDialog application={app} interview={round} onClose={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "重试加载" }));
  await waitFor(() => expect(attempts).toBe(2));
  view.rerender(<ApplicationInterviewReviewDialog application={app} interview={{ ...round, id: 4, round_name: "技术二面" }} onClose={() => {}} />);
  expect(screen.getByText("正在加载逐题记录…")).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "怎么回答" })).toBeNull();
  await act(async () => {
    next.resolve(Response.json({ ...historyResponse(undefined, undefined, 4), questions: [{ ...question, answer: "二面的原答" }] }));
  });
  await act(async () => { oldRetry.resolve(Response.json(historyResponse())); });
  expect((screen.getByRole("textbox", { name: "怎么回答" }) as HTMLTextAreaElement).value).toBe("二面的原答");
  expect(fetch.mock.calls[1]![1]!.signal!.aborted).toBe(true);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("导出响应缺少当前快照时不误报成功或跳转，原版本可以重试", async () => {
  let exports = 0;
  const confirmed = historyResponse(3);
  confirmed.selected!.exports.drills = 24;
  const fetch = vi.fn(async (url: string) => {
    if (!url.endsWith("/export")) return Response.json(historyResponse());
    exports += 1;
    return exports === 1
      ? Response.json({ ...historyResponse(2), latest: null, drill_id: 24 })
      : Response.json({ ...confirmed, drill_id: 24 });
  });
  vi.stubGlobal("fetch", fetch);
  controls.confirm.mockResolvedValue(true);
  render(<ApplicationInterviewReviewDialog application={app} interview={round} onClose={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "开始追练" }));
  expect((await screen.findByRole("alert")).textContent).toContain("未读取到当前复盘的导出结果");
  expect(controls.push).not.toHaveBeenCalled();
  expect(screen.getByText("版本3的点评")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "开始追练" }));
  await screen.findByRole("button", { name: "继续追练" });
  expect(controls.push).toHaveBeenCalledExactlyOnceWith("/drills/24");
  expect(exports).toBe(2);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("导出确认期间离开弹窗，晚到的确认不能再发出写请求", async () => {
  const confirmation = Promise.withResolvers<boolean>();
  controls.confirm.mockReturnValue(confirmation.promise);
  const fetch = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () => Response.json(historyResponse()));
  vi.stubGlobal("fetch", fetch);
  const view = render(<ApplicationInterviewReviewDialog application={app} interview={round} onClose={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "加入错题本" }));
  view.unmount();
  await act(async () => { confirmation.resolve(true); });
  expect(fetch.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  expect(controls.push).not.toHaveBeenCalled();
});

it.each(["保存", "生成", "导出"])("%s等待期间切换轮次会取消旧请求，晚到成功不改写新轮次或触发跳转", async (action) => {
  const pending = Promise.withResolvers<Response>();
  const initial = historyResponse(undefined, "b".repeat(64));
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "PUT" || init?.method === "POST") return pending.promise;
    return Response.json(url.includes("/interviews/4/") ? { ...historyResponse(undefined, "b".repeat(64), 4), questions: [{ ...question, answer: "二面的原答" }] } : initial);
  });
  vi.stubGlobal("fetch", fetch);
  controls.confirm.mockResolvedValue(true);
  const view = render(<ApplicationInterviewReviewDialog application={app} interview={round} onClose={() => {}} />);
  await screen.findByText("版本3的点评");
  if (action === "保存") fireEvent.change(screen.getByRole("textbox", { name: "怎么回答" }), { target: { value: "一面的草稿" } });
  fireEvent.click(screen.getByRole("button", { name: { 保存: "保存逐题记录", 生成: "确认并生成复盘", 导出: "开始追练" }[action] }));
  await waitFor(() => expect(fetch.mock.calls.some(([, init]) => init?.method === "POST" || init?.method === "PUT")).toBe(true));
  const writing = fetch.mock.calls.find(([, init]) => init?.method === "POST" || init?.method === "PUT")![1]!;
  view.rerender(<ApplicationInterviewReviewDialog application={app} interview={{ ...round, id: 4, round_name: "技术二面" }} onClose={() => {}} />);
  await waitFor(() => expect((screen.getByRole("textbox", { name: "怎么回答" }) as HTMLTextAreaElement).value).toBe("二面的原答"));
  await act(async () => { pending.resolve(Response.json({ ...historyResponse(), drill_id: 24 })); });
  expect(writing.signal!.aborted).toBe(true);
  expect((screen.getByRole("textbox", { name: "怎么回答" }) as HTMLTextAreaElement).value).toBe("二面的原答");
  expect(screen.queryByText("逐题记录已保存")).toBeNull();
  expect(screen.queryByText("复盘结果已保存")).toBeNull();
  expect(controls.push).not.toHaveBeenCalled();
});

it("从逐题录入到确认生成并在同一轮回看结果", async () => {
  let questions: typeof question[] = [];
  let latest: unknown = null;
  let hash = "a".repeat(64);
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      questions = JSON.parse(String(init.body)).questions;
      hash = "b".repeat(64);
    }
    if (init?.method === "POST") {
      latest = { id: 1, application_id: app.id, interview_id: round.id, questions, result, source_context: null,
        exports: { mistakes: false, drills: null, resume_suggestions: false },
        created_at: "2026-09-29T00:00:00.000Z", input_hash: hash };
    }
    return { ok: true, json: async () => ({ questions, input_hash: hash, material_error: null, latest, selected: null, history: latest ? [{ id: 1, created_at: "2026-09-29T00:00:00.000Z", input_hash: hash }] : [] }) };
  });
  vi.stubGlobal("fetch", fetch);
  render(<ApplicationInterviewReviewDialog application={app} interview={round} onClose={() => {}} />);
  await screen.findByText("还没有逐题记录");
  fireEvent.click(screen.getByRole("button", { name: "添加题目" }));
  fireEvent.change(screen.getByRole("textbox", { name: "问了什么" }), { target: { value: question.question } });
  fireEvent.change(screen.getByRole("textbox", { name: "怎么回答" }), { target: { value: question.answer } });
  fireEvent.change(screen.getByRole("textbox", { name: "卡在哪里" }), { target: { value: question.stuck } });
  fireEvent.change(screen.getByRole("textbox", { name: "对方反馈" }), { target: { value: question.feedback } });
  fireEvent.click(screen.getByRole("button", { name: "保存逐题记录" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method: "PUT" })));
  fireEvent.click(screen.getByRole("button", { name: "确认并生成复盘" }));
  await screen.findByText("缓存击穿怎么办？");
  expect(screen.getByText("缺少一致性")).toBeTruthy();
  expect(screen.getByText("补充量化结果")).toBeTruthy();
  expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method: "POST" }));
});

it("三类结果分别确认后执行，取消时不写入，追练创建后打开练习", async () => {
  const recap = { id: 7, application_id: app.id, interview_id: round.id, questions: [question], result, source_context: null,
    exports: { mistakes: false, drills: null as number | null, resume_suggestions: false },
    created_at: "2026-09-29T00:00:00.000Z", input_hash: "a".repeat(64) };
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const { action } = JSON.parse(String(init.body));
      if (action === "mistakes") recap.exports.mistakes = true;
      if (action === "drills") recap.exports.drills = 24;
      if (action === "resume_suggestions") recap.exports.resume_suggestions = true;
    }
    return { ok: true, json: async () => ({ questions: [question], input_hash: recap.input_hash, material_error: null, latest: recap,
      selected: null, history: [{ id: recap.id, created_at: recap.created_at, input_hash: recap.input_hash }],
      drill_id: recap.exports.drills }) };
  });
  vi.stubGlobal("fetch", fetch);
  render(<ApplicationInterviewReviewDialog application={app} interview={round} onClose={() => {}} />);
  await screen.findByRole("button", { name: "加入错题本" });

  controls.confirm.mockResolvedValueOnce(false);
  fireEvent.click(screen.getByRole("button", { name: "加入错题本" }));
  await waitFor(() => expect(controls.confirm).toHaveBeenCalledTimes(1));
  expect(fetch).not.toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method: "POST" }));

  controls.confirm.mockResolvedValue(true);
  fireEvent.click(screen.getByRole("button", { name: "加入错题本" }));
  await screen.findByRole("button", { name: "已加入错题本" });
  fireEvent.click(screen.getByRole("button", { name: "开始追练" }));
  await waitFor(() => expect(controls.push).toHaveBeenCalledWith("/drills/24"));
  fireEvent.click(screen.getByRole("button", { name: "创建修改待办" }));
  await screen.findByRole("button", { name: "已创建待办" });
  expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(3);
});

it("当前输入摘要变化后允许重新生成，使用新摘要并保留旧结果到生成完成", async () => {
  const currentHash = "b".repeat(64);
  let latest = { id: 7, application_id: app.id, interview_id: round.id, questions: [question], result, source_context: null,
    exports: { mistakes: false, drills: null, resume_suggestions: false },
    created_at: "2026-09-29T00:00:00.000Z", input_hash: "a".repeat(64) };
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") latest = { ...latest, id: 8, input_hash: currentHash };
    return { ok: true, json: async () => ({ questions: [question], input_hash: currentHash, material_error: null, latest, selected: null,
      history: [{ id: latest.id, created_at: latest.created_at, input_hash: latest.input_hash }] }) };
  });
  vi.stubGlobal("fetch", fetch);
  render(<ApplicationInterviewReviewDialog application={app} interview={round} onClose={() => {}} />);
  const generate = await screen.findByRole("button", { name: "确认并生成复盘" });
  await screen.findByText("缓存击穿怎么办？");
  expect((generate as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(generate);
  await waitFor(() => expect((generate as HTMLButtonElement).disabled).toBe(true));
  expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ method: "POST", body: JSON.stringify({ expected_hash: currentHash }) }));
});
