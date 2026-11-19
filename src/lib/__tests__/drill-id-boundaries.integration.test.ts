import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const model = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock("@/lib/llm", async original => ({ ...await original<typeof import("@/lib/llm")>(), ...model }));
const PREFIX = "resume-life-drill-id-boundaries-";
const evaluation = { depth: 7, structure: 7, authenticity: 8, completeness: 7, comment: "仅依据原答评分。", reference: "保留个人职责与待验证状态。" };
let directory: string;
let db: DatabaseSync;

beforeEach(async () => {
  vi.resetModules(); model.chat.mockReset();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.exec(`INSERT INTO projects (id,name,created_at,updated_at) VALUES (1,'项目一','',''),(2,'另一项目','','');
    INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'简历一','','');
    INSERT INTO drills (id,source,project_id,created_at) VALUES (1,'project',1,''),(2,'bank',NULL,'');
    INSERT INTO drill_questions (id,drill_id,idx,question,answer,comment,reference,answered_at)
      VALUES (1,1,0,'请说明个人分工','只参与接口校验','原点评','原参考','original'),(2,1,1,'同一练习的另一题','另一题原答','','',''),(3,2,0,'另一练习的题目','另一练习原答','','','');
    INSERT INTO notebook_entries (id,source,source_id,question,answer,comment,reference,scores,created_at,updated_at)
      VALUES (1,'drill',1,'收藏原题','收藏原答','收藏原评','收藏原参考','{}','','');
    INSERT INTO review_cards (notebook_id,next_review_date,created_at) VALUES (1,'2026-10-29','original');
    INSERT INTO review_attempts (card_id,request_id,answer,grade,reviewed_at,review_date,interval_days,next_review_date)
      VALUES (1,'7ba78903-825b-41e5-995b-0785f5d7e1c9','原复习作答','good','2026-10-28T00:00:00Z','2026-10-28',1,'2026-10-29');`);
  db.prepare("INSERT INTO interviews (id,resume_id,jd,report,created_at) VALUES (1,1,'接口校验岗位',?,'')").run(JSON.stringify({
    depth: 5, structure: 6, authenticity: 6, completeness: 5, jd_match: 6,
    strengths: "说明职责", weaknesses: "验证待补充", suggestions: "练习解释边界",
  }));
});

afterEach(() => {
  db?.close(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(PREFIX)) throw new Error("Unsafe cleanup path");
  fs.rmSync(resolved, { recursive: true, force: true });
});

function state() {
  return Object.fromEntries(["projects", "resumes", "interviews", "drills", "drill_questions", "notebook_entries", "review_cards", "review_attempts", "llm_call_logs"]
    .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
}
function request(body: unknown) {
  return new Request("http://localhost/api/drills", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
const invalidBodyIds = [true, false, [1], [[1]], [], {}, null, "", "1", "1e0", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined];

describe.each(["project", "bank", "interview"] as const)("练习 %s 题量类型", source => {
  it.each([true, false, null, "3", "1e1", "", [], [3], {}, { toString: null }]
    .map(count => ({ count, label: JSON.stringify(count) })))("拒绝 $label，不能转换或回退后创建", async ({ count }) => {
    model.chat.mockResolvedValue(JSON.stringify({ questions: source === "project" ? ["请说明职责边界"] : [{ question: "请说明职责边界", kind: "tech" }] }));
    const before = state();
    const { POST } = await import("@/app/api/drills/route");
    const response = await POST(request({ source, project_id: 1, interview_id: 1, direction: "前端", count }));
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect((await response.json()).error).toEqual(expect.any(String));
    expect(model.chat).not.toHaveBeenCalled();
    expect(state()).toEqual(before);
  });

  it.each([
    { count: undefined, expected: 5 }, { count: 0, expected: 5 },
    { count: -2, expected: 1 }, { count: 0.5, expected: 1 },
    { count: 3.9, expected: 3 }, { count: 99, expected: 20 },
  ])("数值 $count 保留默认及截断为 $expected 的规则", async ({ count, expected }) => {
    const questions = Array.from({ length: expected }, (_, index) => `独立考点 ${index + 1}`);
    model.chat.mockResolvedValue(JSON.stringify({ questions: source === "project" ? questions : questions.map(question => ({ question, kind: "tech" })) }));
    const { POST } = await import("@/app/api/drills/route");
    const response = await POST(request({ source, project_id: 1, interview_id: 1, direction: "前端", count }));
    expect(response.status).toBe(201);
    const created = await response.json();
    expect(created.count).toBe(expected);
    expect(db.prepare("SELECT question FROM drill_questions WHERE drill_id=? ORDER BY idx").all(created.id)).toEqual(questions.map(question => ({ question })));
    expect(model.chat.mock.calls[0]![1][1].content).toContain(`<question_count>\n${expected}\n</question_count>`);
  });
});

it.each([
  ...["typo", null, true, [], {}].map(source => ({ source, project_id: 1 })),
  ...["direction", "jd"].flatMap(field => [false, null, [], { toString: null }]
    .map(value => ({ source: "bank", direction: "前端", jd: "岗位原文不能静默丢失", [field]: value }))),
])("拒绝来源或岗位材料类型错误 %#，保留原存档", async body => {
  model.chat.mockResolvedValue(JSON.stringify({ questions: body.source === "bank" ? [{ question: "合法题目", kind: "tech" }] : ["合法题目"] }));
  const before = state();
  const { POST } = await import("@/app/api/drills/route");
  const response = await POST(request(body));
  expect(response.status).toBe(400);
  expect(model.chat).not.toHaveBeenCalled();
  expect(state()).toEqual(before);
});

it("拒绝 JSON 指数溢出的非有限题量，不调用模型", async () => {
  model.chat.mockResolvedValue(JSON.stringify({ questions: ["请说明个人职责边界"] }));
  const before = state();
  const { POST } = await import("@/app/api/drills/route");
  const response = await POST(new Request("http://localhost/api/drills", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: '{"source":"project","project_id":1,"count":1e400}',
  }));
  expect(response.status).toBe(400);
  expect(model.chat).not.toHaveBeenCalled();
  expect(state()).toEqual(before);
});

describe.each(["project", "interview"] as const)("练习 %s 创建来源 ID", source => {
  const field = source === "project" ? "project_id" : "interview_id";
  const message = source === "project" ? "请选择项目" : "请选择面试记录";
  it.each(invalidBodyIds.map(value => ({ value, label: JSON.stringify(value) ?? "undefined" })))("拒绝 $label，不能转换成来源 1", async ({ value }) => {
    model.chat.mockResolvedValue(JSON.stringify({ questions: source === "project" ? ["请解释一次参数边界取舍"] : [{ question: "假设出现参数不兼容，你会如何排查？", kind: "tech" }] }));
    const before = state();
    const { POST } = await import("@/app/api/drills/route");
    const response = await POST(request({ source, [field]: value, count: 1 }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: message });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(model.chat).not.toHaveBeenCalled();
    expect(state()).toEqual(before);
  });

  it("正安全整数上界仍按不存在处理，不误判参数错误", async () => {
    const before = state();
    const { POST } = await import("@/app/api/drills/route");
    const response = await POST(request({ source, [field]: Number.MAX_SAFE_INTEGER, count: 1 }));
    expect(response.status).toBe(404);
    expect(model.chat).not.toHaveBeenCalled(); expect(state()).toEqual(before);
  });

  it("真实数字 ID 仍按原来源创建完整题单", async () => {
    const before = state();
    const question = "请解释一次参数边界取舍";
    model.chat.mockResolvedValue(JSON.stringify({ questions: source === "project" ? [question] : [{ question, kind: "tech" }] }));
    const { POST } = await import("@/app/api/drills/route");
    const response = await POST(request({ source, [field]: 1, count: 1 }));
    expect(response.status).toBe(201);
    const created = await response.json();
    expect(created).toEqual({ id: expect.any(Number), count: 1 });
    expect(db.prepare(`SELECT source,${field} FROM drills WHERE id=?`).get(created.id)).toEqual({ source, [field]: 1 });
    expect(db.prepare("SELECT question FROM drill_questions WHERE drill_id=?").all(created.id)).toEqual([{ question }]);
    expect(model.chat).toHaveBeenCalledOnce();
    const after = state();
    for (const key of ["projects", "resumes", "interviews", "notebook_entries", "review_cards", "review_attempts"]) expect(after[key]).toEqual(before[key]);
  });
});

describe.each(["id", "qid"] as const)("练习评分路径 %s", field => {
  it.each(["0", "-1", "1.5", "9007199254740992", "9007199254740993", "1e100", "1e0", "0x1", "+1", "01", " 1", "1 ", "NaN", "Infinity", "abc", ""])("拒绝 %s，保留原答、其他题和收藏复习", async value => {
    model.chat.mockResolvedValue(JSON.stringify(evaluation));
    const before = state();
    const { POST } = await import("@/app/api/drills/[id]/questions/[qid]/route");
    const response = await POST(request({ answer: "新的原答不能写入" }), { params: Promise.resolve({ id: "1", qid: "1", [field]: value }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "无效的 ID" });
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(model.chat).not.toHaveBeenCalled(); expect(state()).toEqual(before);
  });

  it("安全整数上界和串练习题目均保持 404，不评分其他记录", async () => {
    const before = state();
    const { POST } = await import("@/app/api/drills/[id]/questions/[qid]/route");
    for (const params of [{ id: "1", qid: "1", [field]: String(Number.MAX_SAFE_INTEGER) }, { id: "1", qid: "3" }]) {
      const response = await POST(request({ answer: "新的原答不能写入" }), { params: Promise.resolve(params) });
      expect(response.status).toBe(404);
    }
    expect(model.chat).not.toHaveBeenCalled(); expect(state()).toEqual(before);
  });
});

it("有效练习及题目 ID 继续评分，只更新目标题，保留独立收藏与复习历史", async () => {
  const before = state(); model.chat.mockResolvedValue(JSON.stringify(evaluation));
  const { POST } = await import("@/app/api/drills/[id]/questions/[qid]/route");
  const response = await POST(request({ answer: "我只负责参数校验，验收待确认。" }), { params: Promise.resolve({ id: "1", qid: "1" }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ question_id: 1, scores: { depth: 7, structure: 7, authenticity: 8, completeness: 7 }, comment: evaluation.comment, reference: evaluation.reference });
  expect(model.chat).toHaveBeenCalledOnce();
  expect(db.prepare("SELECT answer,comment,reference FROM drill_questions WHERE id=1").get()).toEqual({ answer: "我只负责参数校验，验收待确认。", comment: evaluation.comment, reference: evaluation.reference });
  expect(db.prepare("SELECT answer FROM notebook_entries WHERE id=1").get()).toEqual({ answer: "收藏原答" });
  const after = state();
  expect((after.drill_questions as { id: number }[]).filter(row => row.id !== 1)).toEqual((before.drill_questions as { id: number }[]).filter(row => row.id !== 1));
  for (const key of ["projects", "resumes", "interviews", "drills", "notebook_entries", "review_cards", "review_attempts"]) expect(after[key]).toEqual(before[key]);
});
