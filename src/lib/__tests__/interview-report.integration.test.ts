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
};
const summary = { jd_match: 9, strengths: "技术取舍清楚", weaknesses: "需扩展经验", suggestions: "练习系统设计", evaluator_report: evaluator };
const miningSummary = { project_name: "项目", background: "背景", actions: "行动", tradeoffs: "取舍", results: "成果待确认",
  contribution: "个人贡献", pending_confirmations: [], resume_bullets: ["实现核心模块，指标待核实"] };
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
    ["最后一轮 next_question 为空", JSON.stringify({ ...scores, comment: "点评", next_question: "  ", next_kind: "question" }), true],
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

describe("报告真实性与独立重试", () => {
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
  });

  it.each([
    { pending_confirmations: undefined },
    { pending_confirmations: [{ category: "指标", item: "待核对" }] },
    { pending_confirmations: [null] },
    { resume_bullets: ["有效草稿", 42] },
  ])("挖掘成果不静默丢弃非法字段 %j", async (invalid) => {
    db.exec("UPDATE interviews SET style='mining' WHERE id=1");
    llm.chat.mockResolvedValueOnce(JSON.stringify({ ...summary, mining_summary: { ...miningSummary, ...invalid } }));
    const original = row();
    const finish = (await import("@/app/api/interviews/[id]/finish/route")).POST;
    expect((await finish(request(), context)).status).toBe(502);
    expect(row()).toEqual(original);
  });

  it.each([null, true, false, "", " ", {}, [], -1, 11, "11", "NaN", "Infinity"].map((jdMatch) => [jdMatch]))("拒绝非法 jd_match %j，返回 502 且不落库", async (jdMatch) => {
    llm.chat.mockResolvedValueOnce(JSON.stringify({ ...summary, jd_match: jdMatch }));
    const original = row();
    const finish = (await import("@/app/api/interviews/[id]/finish/route")).POST;
    expect((await finish(request(), context)).status).toBe(502);
    expect(row()).toEqual(original);
  });

  it.each([0, 10, "8", "8.5"])("接受有效 jd_match %j 并存储数值", async (jdMatch) => {
    llm.chat.mockResolvedValueOnce(JSON.stringify({ ...summary, jd_match: jdMatch }));
    const finish = (await import("@/app/api/interviews/[id]/finish/route")).POST;
    const response = await finish(request(), context);
    expect(response.status).toBe(200);
    expect(JSON.parse(String(row()!.report)).jd_match).toBe(Number(jdMatch));
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
