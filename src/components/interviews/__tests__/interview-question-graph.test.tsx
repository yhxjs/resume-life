// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  createInterviewQuestionGraphRoot,
  expandInterviewQuestionGraph,
  collectInterviewQuestionGraphTextsExcludingDescendants,
  predictInterviewQuestionGraphAnswers,
  type InterviewQuestionGraphExpand,
  type InterviewQuestionGraphPredict,
  type InterviewQuestionGraphNode,
  type InterviewQuestionGraphStart,
} from "@/lib/interview-question-graph";

const network = vi.hoisted(() => ({ fetch: vi.fn() }));
import { InterviewQuestionGraph } from "@/components/interviews/interview-question-graph";

const start: InterviewQuestionGraphStart = {
  question: "请说明项目中你实际负责的工作。",
  branches: [
    { label: "回答具体", predicted_answer: "可说明已确认的职责。", followup_question: "你实际完成了哪项检查？" },
    { label: "回答概括", predicted_answer: "具体参与范围仍需核实。", followup_question: "你能举出一次实际操作吗？" },
  ],
};
const scenarios = [
  { label: "证据充分", predicted_answer: "可以指出一项具体检查记录。", followup_question: "你如何确认检查覆盖了目标范围？" },
  { label: "证据不足", predicted_answer: "目前没有足够信息说明检查范围。", followup_question: "还有哪些记录能帮助确认？" },
];
const lastScenarios = [
  { label: "记得操作", predicted_answer: "可以回忆一项实际操作。", followup_question: "这项操作中有哪些需要注意的条件？" },
  { label: "记忆不足", predicted_answer: "需要先核对操作记录。", followup_question: "你准备向谁核对操作细节？" },
];
const predictedAnswers = [
  { label: "有实际依据", predicted_answer: "可以说明当时的记录，具体细节仍待核实。" },
  { label: "细节待确认", predicted_answer: "我需要先核对记录，再说明具体步骤。" },
];

function expansion(questionId: string): InterviewQuestionGraphExpand {
  return { expansions: [{ question_id: questionId, branches: questionId === "q2-1" ? scenarios : lastScenarios }] };
}

function prediction(questionId: string): InterviewQuestionGraphPredict {
  return { predictions: [{ question_id: questionId, answers: predictedAnswers }] };
}

function renderGraph(jd = "接口开发岗位") {
  return render(<InterviewQuestionGraph hidden={false} resumeId={1} resumeVersionId={11} jd={jd} style="deep" />);
}

beforeEach(() => {
  network.fetch.mockReset();
  vi.stubGlobal("fetch", network.fetch);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function queueResponses(...responses: unknown[]) {
  const pending = [...responses];
  let graph: InterviewQuestionGraphNode | null = null;
  const history: InterviewQuestionGraphNode[] = [];
  let revision = 0;
  network.fetch.mockImplementation(async (url: string, init: RequestInit) => {
    expect(init.method).toBe("POST");
    if (url === "/api/interviews/question-graphs/41/undo") {
      const request = JSON.parse(init.body as string) as { expected_revision: number };
      expect(request.expected_revision).toBe(revision);
      graph = history.pop() ?? graph;
      revision += 1;
      return new Response(JSON.stringify({ graph, history, revision }), { headers: { "Content-Type": "application/json" } });
    }
    expect(url).toBe("/api/interviews/question-graph");
    const request = JSON.parse(init.body as string) as { action: "start" | "expand" | "predict"; graph_id?: number };
    const value = pending.shift();
    if (value === undefined) throw new Error("缺少图谱响应测试数据");
    if (value instanceof Response) return value;
    let response: unknown;
    if (request.action === "start") {
      graph = createInterviewQuestionGraphRoot(value as InterviewQuestionGraphStart);
      history.splice(0, history.length);
      revision = 0;
      response = { ...value, graph_id: 41, revision };
    } else if (request.action === "expand") {
      if (!graph) throw new Error("扩展前缺少首题");
      const expansions = (value as InterviewQuestionGraphExpand).expansions;
      const known = new Set(collectInterviewQuestionGraphTextsExcludingDescendants(graph, expansions.map((item) => item.question_id)));
      if (expansions.some((item) => item.branches.some((branch) => known.has(branch.followup_question)))) {
        return new Response('event: error\ndata: {"error":"AI 题目图谱包含重复题目，请重试"}\n\n', {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      history.push(graph);
      graph = expandInterviewQuestionGraph(graph, expansions);
      revision += 1;
      response = { ...value, graph_id: request.graph_id, revision };
    } else {
      if (!graph) throw new Error("预测回答前缺少首题");
      const predictions = (value as InterviewQuestionGraphPredict).predictions;
      history.push(graph);
      graph = predictInterviewQuestionGraphAnswers(graph, predictions);
      revision += 1;
      response = { ...value, graph_id: request.graph_id, revision };
    }
    return new Response(`event: done\ndata: ${JSON.stringify(response)}\n\n`, {
      headers: { "Content-Type": "text/event-stream" },
    });
  });
}

it("第三层生成预测回答，并可逐步回退到三层题目上限", async () => {
  queueResponses(start, expansion("q2-2"), expansion("q2-1"), prediction("q3-q2-1-1"));
  renderGraph();
  fireEvent.click(screen.getByRole("button", { name: "一键生成题目图谱" }));
  await screen.findByText(start.question);
  expect(screen.getByText("你实际完成了哪项检查？")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "为“你能举出一次实际操作吗？”生成分支" }));
  await screen.findByText(lastScenarios[0]!.followup_question);
  const firstRequest = network.fetch.mock.calls[1]![1] as RequestInit;
  const firstExpansion = JSON.parse(firstRequest.body as string) as { frontier: { question_id: string; depth: number }[] };
  expect(firstExpansion.frontier).toEqual([{ question_id: "q2-2", depth: 2, question: "你能举出一次实际操作吗？", parent_question: start.question, answer_scenario: start.branches[1]!.predicted_answer }]);

  fireEvent.click(screen.getByRole("button", { name: "为“你实际完成了哪项检查？”生成分支" }));
  await screen.findByText(scenarios[0]!.followup_question);
  const secondRequest = network.fetch.mock.calls[2]![1] as RequestInit;
  const secondExpansion = JSON.parse(secondRequest.body as string) as { frontier: { question_id: string; depth: number }[] };
  expect(secondExpansion.frontier[0]?.question_id).toBe("q2-1");
  await waitFor(() => expect(screen.getByText("待生成 4 个预测回答 · 已扩展 2 个追问")).toBeTruthy());
  const region = screen.getByRole("region", { name: "模拟面试问题图谱" });
  expect(within(region).getAllByText("预测回答 · 练习假设")).toHaveLength(6);
  expect(within(region).getAllByText("第 3 层")).toHaveLength(4);
  expect(within(region).getAllByText("待生成预测回答")).toHaveLength(4);
  expect(region.querySelectorAll("[data-graph-question]")).toHaveLength(7);

  fireEvent.click(screen.getByRole("button", { name: `为“${scenarios[0]!.followup_question}”生成预测回答` }));
  await screen.findByText(predictedAnswers[0]!.predicted_answer);
  expect(within(region).getAllByText("预测回答 · 练习假设")).toHaveLength(8);
  expect(within(region).getByText("预测回答已生成 · 可重新生成")).toBeTruthy();
  const predictionRequest = JSON.parse((network.fetch.mock.calls[3]![1] as RequestInit).body as string) as { action: string; frontier: { depth: number }[] };
  expect(predictionRequest).toMatchObject({ action: "predict", frontier: [{ depth: 3 }] });

  fireEvent.click(screen.getByRole("button", { name: "撤销上一步" }));
  await waitFor(() => expect(within(region).getAllByText("预测回答 · 练习假设")).toHaveLength(6));
  expect(within(region).queryByText(predictedAnswers[0]!.predicted_answer)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "撤销上一步" }));
  await waitFor(() => expect(region.querySelectorAll("[data-graph-question]")).toHaveLength(5));
  expect(screen.getByRole("button", { name: "为“你实际完成了哪项检查？”生成分支" })).toBeTruthy();
  expect(screen.getByText(lastScenarios[0]!.followup_question)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "撤销上一步" }));
  await waitFor(() => expect(region.querySelectorAll("[data-graph-question]")).toHaveLength(3));
  expect(region.querySelectorAll("[data-graph-question]")).toHaveLength(3);
  expect(screen.queryByText(lastScenarios[0]!.followup_question)).toBeNull();
  expect(screen.queryByRole("button", { name: "撤销上一步" })).toBeNull();
});

it("支持拖动脑图节点、缩放画布并通过小地图定位", async () => {
  queueResponses(start);
  renderGraph();
  fireEvent.click(screen.getByRole("button", { name: "一键生成题目图谱" }));
  await screen.findByText(start.question);

  const region = screen.getByRole("region", { name: "模拟面试问题图谱" });
  const root = region.querySelector('[data-graph-node-id="q1"]') as HTMLElement;
  const initialLeft = root.style.left;
  fireEvent.pointerDown(root, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(region, { pointerId: 1, clientX: 150, clientY: 130 });
  fireEvent.pointerUp(region, { pointerId: 1, clientX: 150, clientY: 130 });
  expect(root.style.left).not.toBe(initialLeft);
  expect(region.querySelectorAll("[data-graph-answer]")).toHaveLength(2);
  const map = screen.getByRole("group", { name: "图谱小地图" });
  const minimapButton = within(map).getByRole("button", { name: "点击小地图定位画布" });
  vi.spyOn(minimapButton, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 220, height: 144 } as DOMRect);
  const viewportIndicator = minimapButton.querySelector("rect:last-child") as SVGRectElement;
  const indicatorBefore = viewportIndicator.getAttribute("x");
  fireEvent.click(minimapButton, { detail: 1, clientX: 200, clientY: 120 });
  await waitFor(() => expect(viewportIndicator.getAttribute("x")).not.toBe(indicatorBefore));

  const zoom = screen.getByText("100%");
  const parentWheel = vi.fn();
  const canvasParent = region.parentElement;
  canvasParent?.addEventListener("wheel", parentWheel);
  const ordinaryWheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100, clientX: 200, clientY: 200 });
  fireEvent(region, ordinaryWheel);
  expect(ordinaryWheel.defaultPrevented).toBe(false);
  expect(parentWheel).toHaveBeenCalledOnce();
  expect(zoom.textContent).toBe("100%");
  const controlWheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -100, clientX: 200, clientY: 200 });
  fireEvent(region, controlWheel);
  expect(controlWheel.defaultPrevented).toBe(true);
  expect(parentWheel).toHaveBeenCalledOnce();
  await waitFor(() => expect(zoom.textContent).not.toBe("100%"));
  canvasParent?.removeEventListener("wheel", parentWheel);
  const zoomAfterControlWheel = zoom.textContent;
  fireEvent.click(screen.getByRole("button", { name: "放大图谱" }));
  await waitFor(() => expect(zoom.textContent).not.toBe(zoomAfterControlWheel));
  expect(screen.getByRole("button", { name: "适配画布" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "适配画布" }));

  const layer = region.querySelector(":scope > div[aria-hidden='false']") as HTMLElement;
  const initialTransform = layer.style.transform;
  fireEvent.pointerDown(region, { button: 0, pointerId: 2, clientX: 200, clientY: 200 });
  fireEvent.pointerMove(region, { pointerId: 2, clientX: 240, clientY: 220 });
  fireEvent.pointerUp(region, { pointerId: 2, clientX: 240, clientY: 220 });
  expect(layer.style.transform).not.toBe(initialTransform);
});

it("扩展图谱后保留当前视口缩放和平移", async () => {
  queueResponses(start, expansion("q2-1"));
  renderGraph();
  fireEvent.click(screen.getByRole("button", { name: "一键生成题目图谱" }));
  await screen.findByText(start.question);
  const region = screen.getByRole("region", { name: "模拟面试问题图谱" });
  vi.spyOn(region, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 600, height: 480 } as DOMRect);
  const layer = region.querySelector(":scope > div[aria-hidden='false']") as HTMLElement;
  await act(async () => {
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  });
  fireEvent.click(screen.getByRole("button", { name: "放大图谱" }));
  fireEvent.pointerDown(region, { button: 0, pointerId: 1, clientX: 200, clientY: 180 });
  fireEvent.pointerMove(region, { pointerId: 1, clientX: 240, clientY: 210 });
  fireEvent.pointerUp(region, { pointerId: 1, clientX: 240, clientY: 210 });
  const transformBeforeExpansion = layer.style.transform;

  fireEvent.click(screen.getByRole("button", { name: "为“你实际完成了哪项检查？”生成分支" }));
  await screen.findByText(scenarios[0]!.followup_question);
  await act(async () => {
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  });

  expect(layer.style.transform).toBe(transformBeforeExpansion);
});

it("扩展中只在目标追问节点显示加载状态", async () => {
  queueResponses(start, expansion("q2-1"));
  renderGraph();
  fireEvent.click(screen.getByRole("button", { name: "一键生成题目图谱" }));
  await screen.findByText(start.question);

  const pending = Promise.withResolvers<Response>();
  network.fetch.mockImplementationOnce(() => pending.promise);
  fireEvent.click(screen.getByRole("button", { name: "为“你实际完成了哪项检查？”生成分支" }));

  const region = screen.getByRole("region", { name: "模拟面试问题图谱" });
  const loadingNode = region.querySelector('[data-graph-node-id="q2-1"]') as HTMLElement;
  const otherNode = region.querySelector('[data-graph-node-id="q2-2"]') as HTMLElement;
  expect(loadingNode.getAttribute("aria-busy")).toBe("true");
  expect(within(loadingNode).getByText("正在生成回答与追问…")).toBeTruthy();
  expect(within(loadingNode).getByRole("button", { name: "正在为“你实际完成了哪项检查？”生成后续分支" })).toBeTruthy();
  expect(otherNode.getAttribute("aria-busy")).toBe("false");
  expect(within(otherNode).queryByText("正在生成回答与追问…")).toBeNull();

  await act(async () => {
    pending.resolve(new Response(`event: done\ndata: ${JSON.stringify({ ...expansion("q2-1"), graph_id: 41, revision: 1 })}\n\n`, {
      headers: { "Content-Type": "text/event-stream" },
    }));
  });
  await screen.findByText(scenarios[0]!.followup_question);
  expect(loadingNode.getAttribute("aria-busy")).toBe("false");
  expect(within(loadingNode).queryByText("正在生成回答与追问…")).toBeNull();
});

it("重新生成失败保留旧子树，成功后替换旧后代且可撤销恢复", async () => {
  const regenerated: InterviewQuestionGraphExpand = { expansions: [{ question_id: "q2-1", branches: [
    { label: "新方向一", predicted_answer: "新的练习回答。", followup_question: "重新生成后的追问一？" },
    { label: "新方向二", predicted_answer: "另一种练习回答。", followup_question: "重新生成后的追问二？" },
  ] }] };
  queueResponses(
    start,
    expansion("q2-1"),
    prediction("q3-q2-1-1"),
    new Response('event: error\ndata: {"error":"模型暂时不可用"}\n\n', { headers: { "Content-Type": "text/event-stream" } }),
    regenerated,
  );
  renderGraph();
  fireEvent.click(screen.getByRole("button", { name: "一键生成题目图谱" }));
  await screen.findByText(start.question);
  fireEvent.click(screen.getByRole("button", { name: "为“你实际完成了哪项检查？”生成分支" }));
  await screen.findByText(scenarios[0]!.followup_question);
  fireEvent.click(screen.getByRole("button", { name: `为“${scenarios[0]!.followup_question}”生成预测回答` }));
  await screen.findByText(predictedAnswers[0]!.predicted_answer);

  const regenerateButton = () => screen.getByRole("button", { name: "重新生成“你实际完成了哪项检查？”的后续分支" });
  fireEvent.click(regenerateButton());
  expect((await screen.findByRole("alert")).textContent).toContain("模型暂时不可用");
  expect(screen.getByText(scenarios[0]!.followup_question)).toBeTruthy();
  expect(screen.getByText(predictedAnswers[0]!.predicted_answer)).toBeTruthy();

  fireEvent.click(regenerateButton());
  await screen.findByText("重新生成后的追问一？");
  const region = screen.getByRole("region", { name: "模拟面试问题图谱" });
  expect(within(region).queryByText(scenarios[0]!.followup_question)).toBeNull();
  expect(within(region).queryByText(predictedAnswers[0]!.predicted_answer)).toBeNull();
  expect(region.querySelectorAll("[data-graph-question]")).toHaveLength(5);
  expect(region.querySelectorAll("[data-graph-answer]")).toHaveLength(4);

  fireEvent.click(screen.getByRole("button", { name: "撤销上一步" }));
  await screen.findByText(scenarios[0]!.followup_question);
  expect(screen.getByText(predictedAnswers[0]!.predicted_answer)).toBeTruthy();
});

it("重复首题不会进入图谱，修正后的响应可重试", async () => {
  queueResponses({ ...start, branches: [start.branches[0], start.branches[0]] }, start);
  renderGraph();
  fireEvent.click(screen.getByRole("button", { name: "一键生成题目图谱" }));
  expect((await screen.findByRole("alert")).textContent).toContain("重复题目");
  expect(screen.queryByRole("region", { name: "模拟面试问题图谱" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "一键生成题目图谱" }));
  await screen.findByText(start.question);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("拒绝重复追问并保留已有分支，重试相同节点后仍可完成图谱", async () => {
  queueResponses(start, expansion("q2-1"), { expansions: [{ question_id: "q2-2", branches: scenarios }] }, expansion("q2-2"));
  renderGraph();
  fireEvent.click(screen.getByRole("button", { name: "一键生成题目图谱" }));
  await screen.findByText(start.question);
  fireEvent.click(screen.getByRole("button", { name: "为“你实际完成了哪项检查？”生成分支" }));
  await screen.findByText(scenarios[0]!.followup_question);
  fireEvent.click(screen.getByRole("button", { name: "为“你能举出一次实际操作吗？”生成分支" }));
  expect((await screen.findByRole("alert")).textContent).toContain("重复题目");
  const region = screen.getByRole("region", { name: "模拟面试问题图谱" });
  expect(region.querySelectorAll("[data-graph-question]")).toHaveLength(5);
  expect(screen.getByText(scenarios[0]!.followup_question)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "为“你能举出一次实际操作吗？”生成分支" }));
  await screen.findByText(lastScenarios[0]!.followup_question);
  expect(region.querySelectorAll("[data-graph-question]")).toHaveLength(7);
  expect(screen.queryByRole("alert")).toBeNull();
  const failedBody = network.fetch.mock.calls[2]![1] as RequestInit;
  const retryBody = network.fetch.mock.calls[3]![1] as RequestInit;
  expect(retryBody.body).toBe(failedBody.body);
});

it("配置变化时保留旧图供查看，但要求重生成后才能扩展", async () => {
  queueResponses(start);
  const view = renderGraph();
  fireEvent.click(screen.getByRole("button", { name: "一键生成题目图谱" }));
  await screen.findByText(start.question);
  view.rerender(<InterviewQuestionGraph hidden={false} resumeId={1} resumeVersionId={11} jd="另一岗位" style="deep" />);
  expect(screen.getByText(/当前简历、JD 或面试官风格已变化/)).toBeTruthy();
  expect(screen.getByRole("button", { name: "重新生成图谱" })).toBeTruthy();
  const expandButtons = screen.getAllByRole("button", { name: /生成分支/ });
  expect(expandButtons).toHaveLength(2);
  expect(expandButtons.every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
});

it("断流保留旧图和待扩展节点，重试后继续完善", async () => {
  queueResponses(start, new Response(": keep-alive\n\n", { headers: { "Content-Type": "text/event-stream" } }), expansion("q2-1"));
  renderGraph();
  fireEvent.click(screen.getByRole("button", { name: "一键生成题目图谱" }));
  await screen.findByText(start.question);
  const expandButton = () => screen.getByRole("button", { name: "为“你实际完成了哪项检查？”生成分支" });
  fireEvent.click(expandButton());
  expect((await screen.findByRole("alert")).textContent).toContain("未收到完成事件");
  expect(screen.getByRole("region", { name: "模拟面试问题图谱" }).querySelectorAll("[data-graph-question]")).toHaveLength(3);
  fireEvent.click(expandButton());
  await screen.findByText(scenarios[0]!.followup_question);
  expect(screen.getByRole("button", { name: "为“你能举出一次实际操作吗？”生成分支" })).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("等待时拦截重复点击，配置变化后的旧响应保留原配置归属", async () => {
  const pending = Promise.withResolvers<Response>();
  network.fetch.mockReturnValueOnce(pending.promise);
  const view = renderGraph();
  const button = screen.getByRole("button", { name: "一键生成题目图谱" });
  fireEvent.click(button);
  fireEvent.click(button);
  expect(network.fetch).toHaveBeenCalledOnce();
  view.rerender(<InterviewQuestionGraph hidden={false} resumeId={1} resumeVersionId={11} jd="新的岗位" style="deep" />);
  await act(async () => {
    pending.resolve(new Response(`event: done\ndata: ${JSON.stringify({ ...start, graph_id: 41, revision: 0 })}\n\n`, { headers: { "Content-Type": "text/event-stream" } }));
  });
  expect(screen.getByText(start.question)).toBeTruthy();
  expect(screen.getByText(/当前简历、JD 或面试官风格已变化/)).toBeTruthy();
  expect(screen.getAllByRole("button", { name: /生成分支/ }).every((item) => (item as HTMLButtonElement).disabled)).toBe(true);
  const regenerated = { ...start, question: "请介绍新岗位相关的一项实际工作。" };
  queueResponses(regenerated);
  fireEvent.click(screen.getByRole("button", { name: "重新生成图谱" }));
  await screen.findByText(regenerated.question);
  expect(screen.queryByText(/当前简历、JD 或面试官风格已变化/)).toBeNull();
  const request = network.fetch.mock.calls[1]![1] as RequestInit;
  expect(JSON.parse(request.body as string).jd).toBe("新的岗位");
});

it("离页时中止正在进行的请求", async () => {
  const pending = Promise.withResolvers<Response>();
  network.fetch.mockReturnValueOnce(pending.promise);
  const view = renderGraph();
  fireEvent.click(screen.getByRole("button", { name: "一键生成题目图谱" }));
  const request = network.fetch.mock.calls[0]![1] as RequestInit;
  expect(request.signal?.aborted).toBe(false);
  view.unmount();
  expect(request.signal?.aborted).toBe(true);
  await act(async () => {
    pending.resolve(new Response(`event: done\ndata: ${JSON.stringify({ ...start, graph_id: 41, revision: 0 })}\n\n`, { headers: { "Content-Type": "text/event-stream" } }));
  });
  expect(screen.queryByRole("region", { name: "模拟面试问题图谱" })).toBeNull();
});
