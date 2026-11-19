import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const llm = vi.hoisted(() => ({ chat: vi.fn(), chatStream: vi.fn() }));
vi.mock("@/lib/llm", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/llm")>(),
  ...llm,
}));

let tempDir: string;
let db: DatabaseSync;
const context = { params: Promise.resolve({ id: "1" }) };
const scores = { depth: 9, structure: 9, authenticity: 9, completeness: 9 };
const evaluator = {
  recommendation: "Hire",
  level: "P6 (资深工程师)",
  level_justification: "能独立负责服务，跨团队架构经验不足。",
  summary_for_hr: "回答覆盖实际交付经历。",
  hire_reasons: ["能解释技术取舍"],
  concerns_and_risks: ["缺少跨团队经验"],
  placement_suggestion: "负责业务服务开发。",
  evidence_quotes: [],
};
const summary = { jd_match: 9, strengths: "技术取舍清楚", weaknesses: "需扩展经验", suggestions: "练习系统设计", evaluator_report: evaluator };
const miningSummary = { project_name: "项目", background: "背景", actions: "行动", tradeoffs: "取舍", results: "成果待确认",
  contribution: "个人贡献", pending_confirmations: [], resume_bullets: ["实现核心模块，指标待核实"] };
const emptyMiningSummary = { project_name: "", background: "", actions: "", tradeoffs: "", results: "",
  contribution: "", pending_confirmations: [], resume_bullets: [] };
const candidate = { ...scores, ...summary, overall: 9 };
const answerResult = JSON.stringify({ ...scores, comment: "点评", next_question: "下一题", next_kind: "question" });
const request = (signal?: AbortSignal) => new Request("http://localhost/api/interviews/1/finish", { method: "POST", signal });
const answerRequest = () => new Request("http://localhost/api/interviews/1/answer", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ turn_id: 2, answer: "本次回答" }),
});
function row() {
  return db.prepare("SELECT status, report, evaluator_report, finished_at FROM interviews WHERE id = 1").get();
}
function deferModel(mock: typeof llm.chat) {
  let resolve!: (value: string) => void;
  let started!: () => void;
  const pending = new Promise<string>((done) => { resolve = done; });
  const entered = new Promise<void>((done) => { started = done; });
  mock.mockImplementationOnce(() => { started(); return pending; });
  return { entered, resolve };
}

beforeEach(async () => {
  vi.resetModules();
  llm.chat.mockReset().mockResolvedValue(JSON.stringify(summary));
  llm.chatStream.mockReset().mockResolvedValue(answerResult);
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-report-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", tempDir);
  db = (await import("@/lib/db")).getDb();
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'测试简历','',''); INSERT INTO interviews (id,resume_id,jd,rounds,created_at) VALUES (1,1,'工程师',3,''); INSERT INTO interview_turns (id,interview_id,idx,question,answer,comment,answered_at) VALUES (1,1,1,'已答问题','原回答','原点评','2026-09-16T00:00:00.000Z'); INSERT INTO interview_turns (id,interview_id,idx,question) VALUES (2,1,2,'待答问题')");
  db.prepare("UPDATE interview_turns SET scores = ? WHERE id = 1").run(JSON.stringify(scores));
});
afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  if (path.dirname(tempDir) !== os.tmpdir() || !path.basename(tempDir).startsWith("resume-life-report-")) throw new Error("Unsafe cleanup path");
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("结束面试的并发与快照一致性", () => {
  describe.each(["finish", "evaluator-report"].flatMap(action => ["gentle", "mining"].map(style => ({ action, style }))))("$action / $style 的完整 JSON 协议", ({ action, style }) => {
    it.each([
      ["围栏", (json: string) => ["```json", json, "```"].join("\n")],
      ["前置说明", (json: string) => `以下为初稿：\n${json}`],
      ["后置说明", (json: string) => `${json}\n上述报告仍需修订。`],
      ["追加截断内容", (json: string) => `${json}\n{"correction":`],
    ] as const)("%s 的模型回复不截取后保存报告，释放锁后纯 JSON 可重试", async (_label, wrap) => {
      db.prepare("UPDATE interviews SET style=?,report='{broken',evaluator_report='{broken',finished_at='original' WHERE id=1").run(style);
      const route = action === "finish"
        ? await import("@/app/api/interviews/[id]/finish/route")
        : await import("@/app/api/interviews/[id]/evaluator-report/route");
      const output = action === "finish" ? { ...summary, ...(style === "mining" ? { mining_summary: miningSummary } : {}) } : evaluator;
      llm.chat.mockResolvedValueOnce(wrap(JSON.stringify(output)));
      const tables = ["interviews", "interview_turns", "notebook_entries", "review_cards"];
      const state = () => tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
      const before = state();
      expect((await route.POST(request(), context)).status).toBe(502);
      expect(state()).toEqual(before);
      expect(llm.chat.mock.calls[0]![2]).toMatchObject({ requireJson: "strict" });
      llm.chat.mockResolvedValueOnce(` \n${JSON.stringify(output)}\t `);
      expect((await route.POST(request(), context)).status).toBe(200);
      expect(llm.chat).toHaveBeenCalledTimes(2);
      expect(JSON.parse(String(row()!.evaluator_report))).toEqual(evaluator);
      expect(state().slice(1)).toEqual(before.slice(1));
      if (action === "finish") expect(row()).toMatchObject({ status: "finished" });
      else expect(row()).toMatchObject({ report: "{broken", finished_at: "original" });
    });
  });

  it("作答模型等待期间拒绝结束，之后报告包含新增回答", async () => {
    const answer = (await import("@/app/api/interviews/[id]/answer/route")).POST;
    const finish = (await import("@/app/api/interviews/[id]/finish/route")).POST;
    const gate = deferModel(llm.chatStream);
    const answering = await answer(answerRequest(), context);
    await gate.entered;
    const finishing = await finish(request(), context);
    gate.resolve(answerResult);
    const events = await answering.text();
    expect(finishing.status).toBe(409);
    expect(llm.chat).not.toHaveBeenCalled();
    expect(events).toContain("event: done");
    const completed = await finish(request(), context);
    expect(completed.status).toBe(200);
    expect(JSON.stringify(llm.chat.mock.calls[0]![1])).toContain("本次回答");
  });

  it("结束模型等待期间拒绝作答和重复结束", async () => {
    const finish = (await import("@/app/api/interviews/[id]/finish/route")).POST;
    const answer = (await import("@/app/api/interviews/[id]/answer/route")).POST;
    const gate = deferModel(llm.chat);
    const pending = finish(request(), context);
    await gate.entered;
    const answering = await answer(answerRequest(), context);
    const events = await answering.text();
    const duplicate = await finish(request(), context);
    gate.resolve(JSON.stringify(summary));
    const completed = await pending;
    expect(answering.status, events).toBe(409);
    expect(duplicate.status).toBe(409);
    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(llm.chatStream).not.toHaveBeenCalled();
    expect(completed.status).toBe(200);
    const persisted = row();
    expect((await finish(request(), context)).status).toBe(400);
    expect(row()).toEqual(persisted);
  });

  it.each([
    ["历史回答", "UPDATE interview_turns SET answer = '另一连接修改回答' WHERE id = 1"],
    ["新增作答", "UPDATE interview_turns SET answer = '另一连接作答', answered_at = 'later' WHERE id = 2"],
    ["待答题目", "UPDATE interview_turns SET question = '另一连接换题' WHERE id = 2"],
    ["场次状态", "UPDATE interviews SET status = 'finished', finished_at = 'external' WHERE id = 1"],
    ["反问记录", "UPDATE interviews SET reverse_interview = '{\"question\":\"新反问\"}' WHERE id = 1"],
    ["候选人报告", "UPDATE interviews SET report = '另一连接报告' WHERE id = 1"],
    ["场次删除", "DELETE FROM interviews WHERE id = 1"],
  ])("另一 SQLite 连接修改%s后拒绝旧报告，网络等待期间不占事务", async (_label, sql) => {
    const finish = (await import("@/app/api/interviews/[id]/finish/route")).POST;
    const gate = deferModel(llm.chat);
    const pending = finish(request(), context);
    await gate.entered;
    const other = new DatabaseSync(path.join(tempDir, "resume-life.db"));
    try { other.exec(sql); } finally { other.close(); }
    const changed = row();
    gate.resolve(JSON.stringify(summary));
    expect((await pending).status).toBe(409);
    expect(row()).toEqual(changed);
  });

  it("请求取消后即使模型返回有效总结也不落库，释放锁后可重试", async () => {
    const finish = (await import("@/app/api/interviews/[id]/finish/route")).POST;
    const gate = deferModel(llm.chat);
    const controller = new AbortController();
    const original = row();
    const pending = finish(request(controller.signal), context);
    await gate.entered;
    controller.abort();
    gate.resolve(JSON.stringify(summary));
    expect((await pending).status).toBe(499);
    expect(row()).toEqual(original);
    expect((await finish(request(), context)).status).toBe(200);
  });

  it("自然答毕但尚无报告的场次可生成报告", async () => {
    db.exec("UPDATE interviews SET status = 'finished', finished_at = 'natural' WHERE id = 1");
    const finish = (await import("@/app/api/interviews/[id]/finish/route")).POST;
    expect((await finish(request(), context)).status).toBe(200);
    expect(JSON.parse(String(row()!.report)).jd_match).toBe(9);
  });
});

describe("回答模型协议错误不改变面试状态", () => {
  it.each([
    ["无效 JSON", "{broken", false],
    ["缺少 comment", JSON.stringify({ ...scores, next_question: "下一题", next_kind: "question" }), false],
    ["分数越界", JSON.stringify({ ...scores, depth: 11, comment: "点评", next_question: "下一题", next_kind: "question" }), false],
    ["非末题 next_question 为空", JSON.stringify({ ...scores, comment: "点评", next_question: "  ", next_kind: "question" }), false],
    ["最后一题缺少 next_question", JSON.stringify({ ...scores, comment: "点评", next_kind: "question" }), true],
    ["最后一题评分非法", JSON.stringify({ ...scores, depth: 11, comment: "点评", next_question: "", next_kind: "question" }), true],
  ])("拒绝%s，发送 SSE error 且不落库", async (_label, raw, finalTurn) => {
    if (finalTurn) db.exec("UPDATE interviews SET rounds = 2 WHERE id = 1");
    llm.chatStream.mockResolvedValueOnce(raw);
    const originalTurn = db.prepare("SELECT answer, comment, scores, answered_at FROM interview_turns WHERE id = 2").get();
    const originalInterview = db.prepare("SELECT status, finished_at FROM interviews WHERE id = 1").get();
    const originalTurnCount = db.prepare("SELECT COUNT(*) AS count FROM interview_turns WHERE interview_id = 1").get();
    const answer = (await import("@/app/api/interviews/[id]/answer/route")).POST;

    const response = await answer(answerRequest(), context);
    const events = await response.text();

    expect(response.status).toBe(200);
    expect(events).toContain("event: error");
    expect(events).not.toContain("event: done");
    expect(db.prepare("SELECT answer, comment, scores, answered_at FROM interview_turns WHERE id = 2").get()).toEqual(originalTurn);
    expect(db.prepare("SELECT COUNT(*) AS count FROM interview_turns WHERE interview_id = 1").get()).toEqual(originalTurnCount);
    expect(db.prepare("SELECT status, finished_at FROM interviews WHERE id = 1").get()).toEqual(originalInterview);
  });
});

describe("最后一题只点评并结束", () => {
  it.each([
    { style: "gentle", nextQuestion: "" },
    { style: "mining", nextQuestion: "" },
    { style: "gentle", nextQuestion: "旧版模型多余的下一题" },
  ])("$style 面试接受末题结果，不保存或返回下一题", async ({ style, nextQuestion }) => {
    db.prepare("UPDATE interviews SET rounds = 2, style = ? WHERE id = 1").run(style);
    llm.chatStream.mockResolvedValueOnce(JSON.stringify({ ...scores, comment: "本次点评", next_question: nextQuestion, next_kind: "question" }));
    const answer = (await import("@/app/api/interviews/[id]/answer/route")).POST;
    const events = await (await answer(answerRequest(), context)).text();
    expect(events).toContain("event: done");
    expect(events).not.toContain("event: error");
    expect(events).toContain('"next_question":""');
    expect(events).toContain('"finished":true');
    expect(events).not.toContain("旧版模型多余的下一题");
    expect(db.prepare("SELECT COUNT(*) AS count FROM interview_turns WHERE interview_id = 1").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT answer, comment, scores FROM interview_turns WHERE id = 2").get())
      .toEqual({ answer: "本次回答", comment: "本次点评", scores: JSON.stringify(scores) });
    expect(row()).toMatchObject({ status: "finished", finished_at: expect.any(String) });
    const system = llm.chatStream.mock.calls[0]![1][0].content;
    expect(system).toContain("这是本场最后一题");
    expect(system).not.toContain("next_question 为非空");
    expect(llm.chatStream.mock.calls[0]![3]).toMatchObject({ requireJson: "strict" });
  });
});

describe("报告真实性与独立重试", () => {
  it("普通面试拒绝经历挖掘专属输出，修正模型结果后可重试", async () => {
    llm.chat
      .mockResolvedValueOnce(JSON.stringify({ ...summary, mining_summary: miningSummary }))
      .mockResolvedValueOnce(JSON.stringify(summary));
    const finish = (await import("@/app/api/interviews/[id]/finish/route")).POST;
    const original = row();

    const rejected = await finish(request(), context);
    expect(rejected.status).toBe(502);
    expect(row()).toEqual(original);
    const firstSystem = (llm.chat.mock.calls[0]![1] as { role: string; content: string }[])
      .find((message) => message.role === "system")!.content;
    expect(firstSystem).not.toContain('"mining_summary"');

    const retried = await finish(request(), context);
    expect(retried.status).toBe(200);
    const body = await retried.json();
    expect(body.report).not.toHaveProperty("mining_summary");
    expect(row()!.report).not.toContain("mining_summary");
    expect(llm.chat).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, null, {}, [], { recommendation: "unknown", level: "P7" }, { ...evaluator, level: "" },
    { recommendation: "Hire", level: "P6" }, { ...evaluator, summary_for_hr: {} },
    { ...evaluator, hire_reasons: [{}] }, { ...evaluator, concerns_and_risks: null }].map((rawEvaluator) => [rawEvaluator]))(
    "缺失或非法面试官评估 %j 不伪造录用和职级，保留候选人报告",
    async (rawEvaluator) => {
      llm.chat.mockResolvedValueOnce(JSON.stringify({ ...summary, evaluator_report: rawEvaluator }));
      const finish = (await import("@/app/api/interviews/[id]/finish/route")).POST;
      const response = await finish(request(), context);
      expect(response.status).toBe(200);
      expect((await response.json()).evaluator_report).toBeNull();
      expect(row()!.evaluator_report).toBe("");
      expect(JSON.parse(String(row()!.report)).strengths).toBe(summary.strengths);
      const get = (await import("@/app/api/interviews/[id]/route")).GET;
      const refreshed = await (await get(request(), context)).json();
      expect(refreshed.evaluator_report).toBeNull();
      expect(refreshed.report.overall).toBe(9);
    },
  );

  it("缺失评估明确提示未生成，并仅提供评估重试", async () => {
    const { InterviewEvaluatorCard } = await import("@/components/interview/evaluator-card");
    const html = renderToStaticMarkup(createElement(InterviewEvaluatorCard, { report: null, interviewId: 1 }));
    expect(html).toContain("面试官评估未生成");
    expect(html).toContain("重试生成面试官评估");
    expect(html).not.toContain("P6/P7");
  });

  it.each(["", "{}", "broken json"])("只补全缺失/损坏评估（%s），候选人报告与完成时间不变", async (oldEvaluator) => {
    db.prepare("UPDATE interviews SET status = 'finished', report = ?, evaluator_report = ?, finished_at = 'original' WHERE id = 1").run(JSON.stringify(candidate), oldEvaluator);
    const original = row();
    llm.chat.mockResolvedValueOnce(JSON.stringify(evaluator));
    const retry = (await import("@/app/api/interviews/[id]/evaluator-report/route")).POST;
    const response = await retry(request(), context);
    expect(response.status).toBe(200);
    expect(row()).toEqual({ ...original, evaluator_report: JSON.stringify(evaluator) });
  });

  it("评估重试结果非法时拒绝写入并保留候选人报告", async () => {
    db.prepare("UPDATE interviews SET status = 'finished', report = ? WHERE id = 1").run(JSON.stringify(candidate));
    const original = row();
    llm.chat.mockResolvedValueOnce("{}");
    const retry = (await import("@/app/api/interviews/[id]/evaluator-report/route")).POST;
    expect((await retry(request(), context)).status).toBe(502);
    expect(row()).toEqual(original);
  });

  it("已生成的有效评估直接复用，不再次请求模型或覆盖报告", async () => {
    db.prepare("UPDATE interviews SET status = 'finished', report = ?, evaluator_report = ? WHERE id = 1").run(JSON.stringify(candidate), JSON.stringify(evaluator));
    const original = row();
    const retry = (await import("@/app/api/interviews/[id]/evaluator-report/route")).POST;
    const response = await retry(request(), context);
    expect(response.status).toBe(200);
    expect((await response.json()).evaluator_report).toEqual(evaluator);
    expect(llm.chat).not.toHaveBeenCalled();
    expect(row()).toEqual(original);
  });

  it("评估重试取消后不落库，保留候选人报告", async () => {
    db.prepare("UPDATE interviews SET status = 'finished', report = ? WHERE id = 1").run(JSON.stringify(candidate));
    const original = row();
    const retry = (await import("@/app/api/interviews/[id]/evaluator-report/route")).POST;
    const controller = new AbortController();
    const gate = deferModel(llm.chat);
    const pending = retry(request(controller.signal), context);
    await gate.entered;
    controller.abort();
    gate.resolve(JSON.stringify(evaluator));
    expect((await pending).status).toBe(499);
    expect(row()).toEqual(original);
  });

  it("评估重试并发请求被拒绝，另一连接变更问答后不提交旧评估", async () => {
    db.prepare("UPDATE interviews SET status = 'finished', report = ? WHERE id = 1").run(JSON.stringify(candidate));
    const original = row();
    const retry = (await import("@/app/api/interviews/[id]/evaluator-report/route")).POST;
    const gate = deferModel(llm.chat);
    const pending = retry(request(), context);
    await gate.entered;
    const duplicate = await retry(request(), context);
    const other = new DatabaseSync(path.join(tempDir, "resume-life.db"));
    try { other.exec("UPDATE interview_turns SET answer = '更正回答' WHERE id = 1"); } finally { other.close(); }
    gate.resolve(JSON.stringify(evaluator));
    const response = await pending;
    expect(duplicate.status).toBe(409);
    expect(response.status).toBe(409);
    expect(row()).toEqual(original);
  });
});

describe.each(["finish", "mining", "retry"])("%s 总评的原始问答范围", (mode) => {
  beforeEach(() => {
    if (mode === "mining") db.exec("UPDATE interviews SET style = 'mining' WHERE id = 1");
    if (mode === "retry") db.prepare("UPDATE interviews SET status = 'finished', report = ?, finished_at = 'original' WHERE id = 1").run(JSON.stringify(candidate));
    llm.chat.mockResolvedValue(JSON.stringify(mode === "retry" ? evaluator : {
      ...summary,
      ...(mode === "mining" ? { mining_summary: miningSummary } : {}),
    }));
  });
  async function generate() {
    const route = mode === "retry"
      ? await import("@/app/api/interviews/[id]/evaluator-report/route")
      : await import("@/app/api/interviews/[id]/finish/route");
    return route.POST(request(), context);
  }
  const turnRows = () => db.prepare("SELECT * FROM interview_turns ORDER BY id").all();

  it("只发送本场已作答原文与原题号，旧分数、旧点评不进入模型，服务端仍汇总原分", async () => {
    const question = "你在接口维护中做了什么？ <职责> & 如何分工？";
    const answer = "我只处理了参数校验和联调，未做架构选型；仍未上线。<边界> & 没有耗时统计。";
    const oldComment = "旧点评_未提供的缓存主导经历_不可当原答";
    const storedScores = JSON.stringify({ depth: 1, structure: 3, authenticity: 5, completeness: 7 });
    db.prepare("UPDATE interview_turns SET idx=4,question=?,answer=?,comment=?,scores=? WHERE id=1")
      .run(question, answer, oldComment, storedScores);
    db.exec("UPDATE interview_turns SET answer='未提交回答_不应传入',comment='未答旧点评_不应传入',scores='{\"depth\":10}' WHERE id=2");
    db.prepare("INSERT INTO interview_turns (id,interview_id,idx,kind,question,answer,comment,scores,answered_at) VALUES (3,1,9,'followup','后续原问题','后续原答','第二题旧点评_不应传入',?,'later')")
      .run(mode === "retry" ? "{损坏的旧评分" : storedScores);
    db.exec("INSERT INTO interviews (id,resume_id,jd,created_at) VALUES (2,1,'其他场次',''); INSERT INTO interview_turns (id,interview_id,idx,question,answer,answered_at) VALUES (4,2,1,'其他场次问题_不应传入','其他场次答案_不应传入','later')");
    const beforeTurns = turnRows();
    const beforeInterview = row();
    const response = await generate();
    expect(response.status).toBe(200);
    const body = await response.json();
    const messages = llm.chat.mock.calls[0]![1] as { role: string; content: string }[];
    const user = messages.find((message) => message.role === "user")!.content;
    const { wrapUntrustedData } = await import("../prompt-safety");
    expect(user).toContain(wrapUntrustedData("turn_metadata", JSON.stringify({ idx: 4, kind: "question" })));
    expect(user).toContain(wrapUntrustedData("interview_question", question));
    expect(user).toContain(wrapUntrustedData("candidate_answer", answer));
    expect(user).toContain(wrapUntrustedData("turn_metadata", JSON.stringify({ idx: 9, kind: "followup" })));
    expect(user).toContain(wrapUntrustedData("candidate_answer", "后续原答"));
    for (const removed of [oldComment, "第二题旧点评_不应传入", "未提交回答_不应传入", "未答旧点评_不应传入", "其他场次问题_不应传入", "其他场次答案_不应传入", "损坏的旧评分", '"scores"', "<model_comment>"]) {
      expect(user).not.toContain(removed);
    }
    expect(turnRows()).toEqual(beforeTurns);
    if (mode === "retry") {
      expect(row()).toEqual({ ...beforeInterview, evaluator_report: JSON.stringify(evaluator) });
    } else {
      expect(body.report).toMatchObject({ depth: 1, structure: 3, authenticity: 5, completeness: 7, jd_match: 9, overall: 5 });
    }
  });

  it("超长旧点评不再占用模型输入预算，原文与历史点评均不被截断或改写", async () => {
    const oldComment = "旧点评" + "<".repeat(17000);
    db.prepare("UPDATE interview_turns SET comment=? WHERE id=1").run(oldComment);
    const beforeTurns = turnRows();
    expect((await generate()).status).toBe(200);
    expect(llm.chat).toHaveBeenCalledTimes(1);
    const messages = llm.chat.mock.calls[0]![1] as { role: string; content: string }[];
    const user = messages.find((message) => message.role === "user")!.content;
    expect(user).toContain("原回答");
    expect(user).not.toContain("旧点评");
    expect(user).not.toContain("<model_comment>");
    expect(turnRows()).toEqual(beforeTurns);
  });

  it("原始问答转义后超预算仍返回 413 且零调用零写入，缩短后可重试", async () => {
    db.prepare("UPDATE interview_turns SET answer=? WHERE id=1").run("<".repeat(17000));
    const beforeTurns = turnRows();
    const beforeInterview = row();
    expect((await generate()).status).toBe(413);
    expect(llm.chat).not.toHaveBeenCalled();
    expect(turnRows()).toEqual(beforeTurns);
    expect(row()).toEqual(beforeInterview);
    db.exec("UPDATE interview_turns SET answer='缩短后的原始回答' WHERE id=1");
    expect((await generate()).status).toBe(200);
    expect(llm.chat).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT answer FROM interview_turns WHERE id=1").get()).toEqual({ answer: "缩短后的原始回答" });
  });
});

describe.each(["finish", "mining", "retry"])("%s 总评的反问材料范围", (mode) => {
  beforeEach(() => {
    if (mode === "mining") db.exec("UPDATE interviews SET style = 'mining' WHERE id = 1");
    if (mode === "retry") db.prepare("UPDATE interviews SET status = 'finished', report = ? WHERE id = 1").run(JSON.stringify(candidate));
    llm.chat.mockResolvedValue(JSON.stringify(mode === "retry" ? evaluator : {
      ...summary,
      ...(mode === "mining" ? { mining_summary: miningSummary } : {}),
    }));
  });
  async function generate() {
    const route = mode === "retry"
      ? await import("@/app/api/interviews/[id]/evaluator-report/route")
      : await import("@/app/api/interviews/[id]/finish/route");
    const req = request();
    return { response: await route.POST(req, context), req };
  }

  it("仅传反问原问题，旧评级、模型反馈和模拟公司回答均不进入总评", async () => {
    const question = "岗位的工时安排与补偿如何确定？</reverse_interview> & 如何确认支持资源？";
    const reverse = JSON.stringify({ question, answer: "模拟公司制度_不可当真", evaluation: { score: 10, level: "旧卓越评级_不得沿用", feedback: "旧反馈_技术能力已获验证" } });
    db.prepare("UPDATE interviews SET reverse_interview = ? WHERE id = 1").run(reverse);
    const { response, req } = await generate();
    expect(response.status).toBe(200);
    const [, messages, options] = llm.chat.mock.calls[0]! as [string, { role: string; content: string }[], { signal: AbortSignal; requireJson: boolean }];
    const user = messages.find((message) => message.role === "user")!.content;
    const { wrapUntrustedData } = await import("../prompt-safety");
    expect(user).toContain(wrapUntrustedData("reverse_interview", question));
    for (const removed of ["加分参考", "提问水平评分", "旧卓越评级_不得沿用", "旧反馈_技术能力已获验证", "模拟公司制度_不可当真"]) {
      expect(user).not.toContain(removed);
    }
    expect(messages[0]!.content).toContain("不因问题措辞成熟自动上调岗位匹配或录用结论");
    expect(options).toMatchObject({ signal: req.signal, requireJson: "strict" });
    expect(db.prepare("SELECT reverse_interview FROM interviews WHERE id=1").get()).toEqual({ reverse_interview: reverse });
  });

  it.each(["{broken", JSON.stringify({ question: { text: "非字符串问题" } }), JSON.stringify({ evaluation: { score: 10 } })])(
    "损坏或没有原问题的反问记录 %j 不生成默认反问材料", async (reverse) => {
      db.prepare("UPDATE interviews SET reverse_interview = ? WHERE id = 1").run(reverse);
      expect((await generate()).response.status).toBe(200);
      const messages = llm.chat.mock.calls[0]![1] as { role: string; content: string }[];
      const user = messages.find((message) => message.role === "user")!.content;
      expect(user).not.toContain("<reverse_interview>");
      expect(user).not.toContain("[object Object]");
      expect(db.prepare("SELECT reverse_interview FROM interviews WHERE id=1").get()).toEqual({ reverse_interview: reverse });
    },
  );
});

describe.each(["finish", "mining", "retry"])("%s 录用评估证据校验", (mode) => {
  beforeEach(() => {
    // 真实题号不连续，避免把数组位置当作题号；第 2 题仍未作答。
    db.exec("UPDATE interview_turns SET idx = 4 WHERE id = 1");
    if (mode === "mining") db.exec("UPDATE interviews SET style = 'mining' WHERE id = 1");
    if (mode === "retry") db.prepare("UPDATE interviews SET status = 'finished', report = ?, finished_at = 'original' WHERE id = 1").run(JSON.stringify(candidate));
  });
  const evidence = { turn_idx: 4, topic: "实际问题", observation: "候选人提供了原回答。" };
  async function generate(quotes: unknown, overrides: Partial<typeof evaluator> = {}) {
    const evaluated = { ...evaluator, ...overrides, evidence_quotes: quotes };
    llm.chat.mockResolvedValueOnce(JSON.stringify(mode === "retry" ? evaluated : {
      ...summary,
      ...(mode === "mining" ? { mining_summary: miningSummary } : {}),
      evaluator_report: evaluated,
    }));
    const route = mode === "retry"
      ? await import("@/app/api/interviews/[id]/evaluator-report/route")
      : await import("@/app/api/interviews/[id]/finish/route");
    return route.POST(request(), context);
  }

  it.each(["Strong Hire", "No Hire"])("%s 提供对应理由时允许无法定级，不套用示例结论", async (recommendation) => {
    const expected = {
      recommendation, level: "暂无法判断", level_justification: "本场尚未考察系统设计，无法确定职级。",
      hire_reasons: recommendation === "Strong Hire" ? ["已展示相关岗位能力"] : [],
      concerns_and_risks: recommendation === "No Hire" ? ["已展示的关键要求未满足"] : [],
    };
    const response = await generate([], expected);
    expect(response.status).toBe(200);
    expect((await response.json()).evaluator_report).toMatchObject(expected);
    expect(JSON.parse(String(row()!.evaluator_report))).toMatchObject(expected);

    const { EVALUATOR_REPORT_PROMPT } = await import("../interview-report-llm");
    const { INTERVIEW_MATCH_SCORE_RULE } = await import("../prompt-guidelines");
    const messages = llm.chat.mock.calls[0]![1] as { role: string; content: string }[];
    const system = messages.find((message) => message.role === "system")!.content;
    expect(system.split(EVALUATOR_REPORT_PROMPT)).toHaveLength(2);
    expect(EVALUATOR_REPORT_PROMPT).not.toContain("jd_match");
    expect(EVALUATOR_REPORT_PROMPT).toContain("句数是篇幅目标，结论简单且已充分表达时可以更短，不重复内容凑句");
    expect(system).toContain("Strong Hire 和 Hire 至少有一条 hire_reasons；No Hire 至少有一条 concerns_and_risks");
    expect(system.includes(INTERVIEW_MATCH_SCORE_RULE)).toBe(mode !== "retry");
    if (mode !== "retry") {
      expect(system).toContain("仅用于已考察且回答显示核心要求明显不满足");
      expect(system).toContain("未考察的要求应说明为未知而非候选人不具备");
    }
    if (mode !== "retry") {
      expect(system).toContain("必填非空字符串，但这只是结构要求，不代表必须凑出强项或短板");
      expect(system).toContain("没有足够依据归纳强项/明确短板时");
      expect(system).toContain("不按示例句数扩写");
      expect(system).toContain("若该字段缺失或无法通过评估校验，候选人复盘仍可保存，评估可通过独立入口重试");
      for (const oldOuterExample of ["强项挖掘总结，2-3 句", "未明细节与表达短板，2-3 句", "强项总结，2-3 句", "短板总结，2-3 句", "后续简历与面试建议，2-4 句", "后续改进建议，2-4 句"]) {
        expect(system).not.toContain(oldOuterExample);
      }
    }
    expect(system).toContain("不将外层复盘评分或总结字段复制进该对象");
    for (const oldBias of ["真实经历水分", "为什么给P6而不是P7", '"level": "如 P6', '"turn_idx": 1']) {
      expect(system).not.toContain(oldBias);
    }
    // 实际外发的嵌套/独立示例必须都是合法 JSON，且使用现有业务校验可接收的结构。
    const match = system.match(/输出严格的 JSON 格式：\n([\s\S]+?)\n(?:外层只返回示例列出的字段，不得添加字段；|只返回示例列出的字段，不得添加字段；)只输出合法 JSON/);
    expect(match).not.toBeNull();
    const example = JSON.parse(match![1]!);
    const { EVALUATOR_REPORT_OUTPUT_LIMITS, validateGeneratedEvaluatorReport } = await import("../scores");
    expect(validateGeneratedEvaluatorReport(mode === "retry" ? example : example.evaluator_report, [4])).not.toBeNull();
    expect(system).toContain(`level_justification ${EVALUATOR_REPORT_OUTPUT_LIMITS.levelJustification} 字、summary_for_hr ${EVALUATOR_REPORT_OUTPUT_LIMITS.summaryForHr} 字、placement_suggestion ${EVALUATOR_REPORT_OUTPUT_LIMITS.placementSuggestion} 字`);
    expect(system).toContain(`evidence_quotes 必须返回对象数组`);
    expect(system).toContain("回答依据摘要而非逐字引文");
    expect(system).toContain("不加引号伪装原话");
  });

  it.each([
    ["Strong Hire", { hire_reasons: [] }],
    ["Hire", { hire_reasons: [] }],
    ["No Hire", { concerns_and_risks: [] }],
    [" Strong Hire ", { hire_reasons: [] }],
    ["\tHire\n", { hire_reasons: [] }],
    ["\u3000No Hire\u00a0", { concerns_and_risks: [] }],
  ] as [string, Partial<typeof evaluator>][])("%s 缺少对应理由时不保存评估", async (recommendation, missingReason) => {
    const before = row()!.evaluator_report;
    const response = await generate([], { recommendation, ...missingReason });
    if (mode === "retry") {
      expect(response.status).toBe(502);
      expect(row()!.evaluator_report).toBe(before);
    } else {
      expect(response.status).toBe(200);
      expect((await response.json()).evaluator_report).toBeNull();
      expect(row()!.evaluator_report).toBe("");
    }
  });

  it.each([
    ["缺少证据数组", undefined],
    ["缺少题号", [{ topic: "主题", observation: "观察" }]],
    ["字符串题号", [{ ...evidence, turn_idx: "4" }]],
    ["布尔题号", [{ ...evidence, turn_idx: true }]],
    ["数组题号", [{ ...evidence, turn_idx: [4] }]],
    ["小数题号", [{ ...evidence, turn_idx: 4.5 }]],
    ["负数题号", [{ ...evidence, turn_idx: -1 }]],
    ["零题号", [{ ...evidence, turn_idx: 0 }]],
    ["不存在的题号", [{ ...evidence, turn_idx: 9 }]],
    ["误用列表位置", [{ ...evidence, turn_idx: 1 }]],
    ["尚未作答的题号", [{ ...evidence, turn_idx: 2 }]],
    ["重复题号", [evidence, evidence]],
    ["空主题", [{ ...evidence, topic: " " }]],
    ["空观察", [{ ...evidence, observation: " " }]],
    ["非文本观察", [{ ...evidence, observation: { text: "观察" } }]],
    ["非对象条目", [null]],
    ["非数组证据", {}],
    ["空值证据", null],
  ])("拒绝%s，不保存无效面试官评估", async (_label, quotes) => {
    const before = row();
    const response = await generate(quotes);
    expect(response.status).toBe(mode === "retry" ? 502 : 200);
    if (mode === "retry") expect(row()).toEqual(before);
    else {
      expect((await response.json()).evaluator_report).toBeNull();
      expect(row()!.evaluator_report).toBe("");
      expect(JSON.parse(String(row()!.report)).strengths).toBe(summary.strengths);
    }
  });

  it("超过三条证据时拒绝评估", async () => {
    for (const idx of [6, 8, 10]) {
      db.prepare("INSERT INTO interview_turns (interview_id,idx,question,answer,answered_at,scores) VALUES (1,?,'补充题','补充回答','answered',?)").run(idx, JSON.stringify(scores));
    }
    const before = row();
    const response = await generate([4, 6, 8, 10].map((turn_idx) => ({ ...evidence, turn_idx })));
    expect(response.status).toBe(mode === "retry" ? 502 : 200);
    expect(row()!.evaluator_report).toBe("");
    if (mode === "retry") expect(row()).toEqual(before);
  });

  it.each([false, true])("有效证据可保存，明确空证据：%s", async (empty) => {
    const quotes = empty ? [] : [evidence];
    const response = await generate(quotes);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.evaluator_report).toMatchObject({ recommendation: "Hire" });
    expect(body.evaluator_report.evidence_quotes ?? []).toEqual(quotes);
    expect(JSON.parse(String(row()!.evaluator_report)).evidence_quotes ?? []).toEqual(quotes);
    const get = (await import("@/app/api/interviews/[id]/route")).GET;
    const refreshed = await (await get(request(), context)).json();
    expect(refreshed.evaluator_report.evidence_quotes ?? []).toEqual(quotes);
    const messages = llm.chat.mock.calls[0]![1];
    expect(JSON.stringify(messages)).toContain('\\"idx\\":4');
  });
});

describe("岗位匹配分不允许 JavaScript 隐式类型转换", () => {
  it.each([
    { jd_match: 7 },
    { ...summary, strengths: undefined },
    { ...summary, weaknesses: " \n " },
    { ...summary, suggestions: 7 },
  ])("拒绝不完整总结 %j，不落库且完整响应可重试", async (incomplete) => {
    const finish = (await import("@/app/api/interviews/[id]/finish/route")).POST;
    llm.chat.mockResolvedValueOnce(JSON.stringify(incomplete));
    const original = row();
    expect((await finish(request(), context)).status).toBe(502);
    expect(row()).toEqual(original);
    expect((await finish(request(), context)).status).toBe(200);
  });

  it("既有空总结不再锁住重新生成入口", async () => {
    db.prepare("UPDATE interviews SET status='finished', report=? WHERE id=1")
      .run(JSON.stringify({ ...scores, jd_match: 7 }));
    const finish = (await import("@/app/api/interviews/[id]/finish/route")).POST;
    expect((await finish(request(), context)).status).toBe(200);
    expect(JSON.parse(String(row()!.report)).strengths).toBe(summary.strengths);
  });

  it("挖掘面试缺少经历成果时拒绝完成，完整成果可重试", async () => {
    db.exec("UPDATE interviews SET style='mining' WHERE id=1");
    const finish = (await import("@/app/api/interviews/[id]/finish/route")).POST;
    const original = row();
    expect((await finish(request(), context)).status).toBe(502);
    expect(row()).toEqual(original);
    llm.chat.mockResolvedValueOnce(JSON.stringify({ ...summary, mining_summary: miningSummary }));
    expect((await finish(request(), context)).status).toBe(200);
    const system = (llm.chat.mock.calls[0]![1] as { role: string; content: string }[])
      .find((message) => message.role === "system")!.content;
    expect(system).toContain('"mining_summary"');
    expect(system).toContain("pending_confirmations 最多");
    expect(system).toContain('"pending_confirmations": []');
  });

  it.each([
    { label: "已知项目但无足够草稿", mining: { ...emptyMiningSummary, project_name: "订单项目" } },
    { label: "无量化指标的已确认成果", mining: { ...emptyMiningSummary, actions: "参与接口联调", results: "完成接口验收",
      resume_bullets: ["参与接口联调，完成接口验收"] } },
    { label: "仅有待确认清单", mining: { ...emptyMiningSummary, pending_confirmations: [
      { category: "个人职责", item: "确认当时参与的模块及职责", source_hint: "建议回查任务记录或向原同事核实" },
    ] } },
  ])("挖掘报告允许$label，保存与回读不补造事实", async ({ mining }) => {
    db.exec("UPDATE interviews SET style='mining' WHERE id=1");
    llm.chat.mockResolvedValueOnce(JSON.stringify({ ...summary, mining_summary: mining }));
    const finish = (await import("@/app/api/interviews/[id]/finish/route")).POST;
    const response = await finish(request(), context);
    expect(response.status).toBe(200);
    expect((await response.json()).report.mining_summary).toEqual(mining);
    expect(row()).toMatchObject({ status: "finished", finished_at: expect.any(String) });
    expect(JSON.parse(String(row()!.report)).mining_summary).toEqual(mining);
    const get = (await import("@/app/api/interviews/[id]/route")).GET;
    expect((await (await get(request(), context)).json()).report.mining_summary).toEqual(mining);
  });

  it.each(["", " \n "])("拒绝六字段和两个数组全空的挖掘报告（%j）", async (blank) => {
    db.exec("UPDATE interviews SET style='mining' WHERE id=1");
    llm.chat.mockResolvedValueOnce(JSON.stringify({ ...summary, mining_summary: {
      ...emptyMiningSummary, project_name: blank, background: blank, actions: blank,
      tradeoffs: blank, results: blank, contribution: blank,
    } }));
    const original = row();
    const finish = (await import("@/app/api/interviews/[id]/finish/route")).POST;
    expect((await finish(request(), context)).status).toBe(502);
    expect(row()).toEqual(original);
  });

  it.each(["project_name", "background", "actions", "tradeoffs", "results", "contribution"].flatMap((key) =>
    [undefined, null, 42].map((value) => ({ key, value })),
  ))("挖掘字段 $key 缺失或类型错误（$value）不能被补为空事实", async ({ key, value }) => {
    db.exec("UPDATE interviews SET style='mining' WHERE id=1");
    llm.chat.mockResolvedValueOnce(JSON.stringify({ ...summary, mining_summary: { ...miningSummary, [key]: value } }));
    const original = row();
    const finish = (await import("@/app/api/interviews/[id]/finish/route")).POST;
    expect((await finish(request(), context)).status).toBe(502);
    expect(row()).toEqual(original);
  });

  it.each([
    { pending_confirmations: undefined },
    { pending_confirmations: null },
    { pending_confirmations: [{ category: "指标", item: "待核对" }] },
    { pending_confirmations: [{ category: "指标", item: "待核对", source_hint: " " }] },
    { pending_confirmations: [null] },
    { resume_bullets: undefined },
    { resume_bullets: null },
    { resume_bullets: [" "] },
    { resume_bullets: ["有效草稿", 42] },
  ])("挖掘成果不静默丢弃非法字段 %j", async (invalid) => {
    db.exec("UPDATE interviews SET style='mining' WHERE id=1");
    llm.chat.mockResolvedValueOnce(JSON.stringify({ ...summary, mining_summary: { ...miningSummary, ...invalid } }));
    const original = row();
    const finish = (await import("@/app/api/interviews/[id]/finish/route")).POST;
    expect((await finish(request(), context)).status).toBe(502);
    expect(row()).toEqual(original);
  });

  describe.each(["gentle", "mining"])("%s 风格的生成评分与历史兼容", (style) => {
    const generatedReport = (overrides: Record<string, unknown> = {}) => ({
      ...summary,
      ...(style === "mining" ? { mining_summary: miningSummary } : {}),
      ...overrides,
    });

    beforeEach(() => {
      db.prepare("UPDATE interviews SET style=? WHERE id=1").run(style);
      llm.chat.mockResolvedValue(JSON.stringify(generatedReport()));
    });

    it.each([undefined, null, true, false, "", " ", {}, [], -1, 11, "8", "8.5", 8.5, "11", "NaN", "Infinity"].map((jdMatch) => [jdMatch]))("拒绝非法 jd_match %j，返回 502 且不落库，整数结果可重试", async (jdMatch) => {
      llm.chat.mockResolvedValueOnce(JSON.stringify(generatedReport({ jd_match: jdMatch })));
      const original = row();
      const finish = (await import("@/app/api/interviews/[id]/finish/route")).POST;
      expect((await finish(request(), context)).status).toBe(502);
      expect(row()).toEqual(original);
      expect((await finish(request(), context)).status).toBe(200);
      expect(llm.chat).toHaveBeenCalledTimes(2);
    });

    it.each([0, 8, 10])("接受整数 jd_match %j 并原值存储", async (jdMatch) => {
      llm.chat.mockResolvedValueOnce(JSON.stringify(generatedReport({ jd_match: jdMatch })));
      const finish = (await import("@/app/api/interviews/[id]/finish/route")).POST;
      const response = await finish(request(), context);
      expect(response.status).toBe(200);
      expect(JSON.parse(String(row()!.report)).jd_match).toBe(jdMatch);
    });

    it.each([8, 8.5, "8", "8.5"])("已保存的完整报告仍兼容 jd_match %j，不重新生成或覆盖", async (jdMatch) => {
      db.prepare("UPDATE interviews SET status='finished', report=?, finished_at='original' WHERE id=1")
        .run(JSON.stringify({ ...candidate, depth: 8.5, jd_match: jdMatch, mining_summary: miningSummary }));
      const original = row();
      const finish = (await import("@/app/api/interviews/[id]/finish/route")).POST;
      expect((await finish(request(), context)).status).toBe(400);
      expect(llm.chat).not.toHaveBeenCalled();
      expect(row()).toEqual(original);
      const get = (await import("@/app/api/interviews/[id]/route")).GET;
      const response = await get(request(), context);
      expect(response.status).toBe(200);
      expect((await response.json()).report).toMatchObject({ depth: 8.5, jd_match: Number(jdMatch) });
      expect(row()).toEqual(original);
    });

    it("服务端四维均分与综合分保留一位小数，不采纳模型重算值", async () => {
      db.prepare("UPDATE interview_turns SET scores=? WHERE id=1")
        .run(JSON.stringify({ depth: 9, structure: 8, authenticity: 7, completeness: 6 }));
      db.prepare("UPDATE interview_turns SET answer='第二题原答', answered_at='later', scores=? WHERE id=2")
        .run(JSON.stringify({ depth: 8, structure: 7, authenticity: 6, completeness: 5 }));
      llm.chat.mockResolvedValueOnce(JSON.stringify(generatedReport()));
      const finish = (await import("@/app/api/interviews/[id]/finish/route")).POST;
      const response = await finish(request(), context);
      expect(response.status).toBe(200);
      const expected = { depth: 8.5, structure: 7.5, authenticity: 6.5, completeness: 5.5, jd_match: 9, overall: 7.4 };
      expect((await response.json()).report).toMatchObject(expected);
      expect(JSON.parse(String(row()!.report))).toMatchObject(expected);
      const get = (await import("@/app/api/interviews/[id]/route")).GET;
      expect((await (await get(request(), context)).json()).report).toMatchObject(expected);
    });

    it("拒绝模型附加服务端派生的维度分或 overall", async () => {
      llm.chat.mockResolvedValueOnce(JSON.stringify(generatedReport({ depth: 0, overall: 10 })));
      const original = row();
      const finish = (await import("@/app/api/interviews/[id]/finish/route")).POST;
      expect((await finish(request(), context)).status).toBe(502);
      expect(row()).toEqual(original);
    });
  });
});

describe("作答 SSE 流内异常接入日志与 requestId", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("未知错误落 server-error 日志，并向客户端发含 requestId 的通用文案", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    llm.chatStream.mockRejectedValueOnce(new Error("SQLITE_IOERR: disk I/O error"));
    const answer = (await import("@/app/api/interviews/[id]/answer/route")).POST;

    const response = await answer(answerRequest(), context);
    const events = await response.text();

    expect(events).toContain("event: error");
    expect(events).toMatch(/服务端处理失败（[A-Za-z0-9._:-]{1,128}）/);
    expect(events).not.toContain("SQLITE_IOERR");

    const logged = errorSpy.mock.calls.flat().join(" ");
    expect(logged).toContain("[server-error]");
    expect(logged).toContain("sse.interviews.answer");
  });

  it("LlmConfigError 保持原文案且不记 server-error 日志", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // 动态取类，确保与路由模块在同一模块注册表中，instanceof 成立
    const { LlmConfigError } = await import("@/lib/llm");
    llm.chatStream.mockRejectedValueOnce(new LlmConfigError("未配置模型"));
    const answer = (await import("@/app/api/interviews/[id]/answer/route")).POST;

    const response = await answer(answerRequest(), context);
    const events = await response.text();

    expect(events).toContain("event: error");
    expect(events).toContain("未配置模型");

    const logged = errorSpy.mock.calls.flat().join(" ");
    expect(logged).not.toContain("[server-error]");
  });
});
