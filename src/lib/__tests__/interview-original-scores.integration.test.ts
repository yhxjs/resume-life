import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseInterviewDetail } from "../interview-detail";

const model = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock("@/lib/llm", async original => ({ ...await original<typeof import("@/lib/llm")>(), ...model }));
let directory: string;
let db: DatabaseSync;
const summary = { jd_match: 7, strengths: "实际分工", weaknesses: "验证不足", suggestions: "补充记录" };
const first = { depth: 7.4, structure: 8.2, authenticity: 6.6, completeness: 9.1 };
const second = { depth: 8.4, structure: 7.2, authenticity: 7.6, completeness: 8.1 };
const ctx = { params: Promise.resolve({ id: "1" }) };
const snapshot = () => ["interviews", "interview_turns", "notebook_entries", "review_cards"].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
async function detail() {
  const response = await (await import("@/app/api/interviews/[id]/route")).GET(new Request("http://localhost/api/interviews/1"), ctx);
  expect(response.status).toBe(200);
  return response.json();
}
async function finish() {
  return (await import("@/app/api/interviews/[id]/finish/route")).POST(new Request("http://localhost/api/interviews/1/finish", { method: "POST" }), ctx);
}
beforeEach(async () => {
  vi.resetModules(); model.chat.mockReset().mockResolvedValue(JSON.stringify(summary));
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-original-scores-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'原简历','',''); INSERT INTO interviews (id,resume_id,jd,rounds,created_at) VALUES (1,1,'岗位',3,''),(2,1,'另一面试',3,''); INSERT INTO interview_turns (id,interview_id,idx,question,answer,answered_at) VALUES (1,1,1,'原题 <T> &amp;','原答一','saved'),(2,1,2,'第二题','原答二','saved'),(3,1,3,'未答题','','')");
  db.prepare("UPDATE interview_turns SET scores=? WHERE id=1").run(JSON.stringify(first));
  db.prepare("UPDATE interview_turns SET scores=? WHERE id=2").run(JSON.stringify(second));
});
afterEach(() => {
  db.close(); vi.unstubAllEnvs();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-original-scores-")) throw new Error("Unsafe cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
});
it.each([
  ["缺失", ""], ["旧 null", "null"], ["截断", '{"depth":'], ["空白", " "],
  ["数组", "[]"], ["布尔", "true"], ["对象缺维度", "{}"],
  ["数字字符串", JSON.stringify({ ...first, depth: "7.4" })],
  ["null 维度", JSON.stringify({ ...first, depth: null })],
  ["负分", JSON.stringify({ ...first, depth: -0.1 })],
  ["超范围", JSON.stringify({ ...first, depth: 10.1 })],
  ["无限值", '{"depth":1e309,"structure":8,"authenticity":7,"completeness":9}'],
])("%s 原答评分不冒充无分成功，详情保留原答，报告零模型零写入", async (_label, raw) => {
  db.prepare("UPDATE interview_turns SET scores=? WHERE id=1").run(raw);
  const before = snapshot();
  const payload = await detail();
  expect(payload.turns[0].scores).toBeNull();
  expect(payload.turns[0].scores_error).toContain("原答评分缺失或损坏");
  expect(parseInterviewDetail(payload, 1).turns[0]!.answer).toBe("原答一");
  expect(payload.turns[1].scores).toEqual(second);
  expect(payload.turns[2].scores_error).toBeUndefined();
  const response = await finish();
  expect(response.status).toBe(422);
  expect((await response.json()).error).toContain("第 1 题");
  expect(model.chat).not.toHaveBeenCalled();
  expect(snapshot()).toEqual(before);
  db.prepare("UPDATE interview_turns SET scores=? WHERE id=1").run(JSON.stringify(first));
  expect((await finish()).status).toBe(200);
  expect(model.chat).toHaveBeenCalledOnce();
});

it("报告按完整原始小数汇总；未作答题的坏评分不计分，不修改其他记录", async () => {
  db.exec("UPDATE interview_turns SET scores='{broken' WHERE id=3");
  const before = snapshot();
  const payload = await detail();
  expect(payload.turns[0].scores).toEqual(first);
  expect(payload.turns[1].scores).toEqual(second);
  expect(payload.turns[2].scores_error).toContain("原答评分缺失或损坏");
  expect(parseInterviewDetail(payload, 1).turns).toHaveLength(3);
  const response = await finish();
  expect(response.status).toBe(200);
  const receipt = await response.json();
  expect(receipt.report).toMatchObject({ depth: 7.9, structure: 7.7, authenticity: 7.1, completeness: 8.6, overall: 7.7 });
  expect(snapshot().slice(1)).toEqual(before.slice(1));
  expect(snapshot()[0]![1]).toEqual(before[0]![1]);
  expect(JSON.parse(String(db.prepare("SELECT report FROM interviews WHERE id=1").get()!.report))).toEqual(receipt.report);
  expect(model.chat).toHaveBeenCalledOnce();
});

it("所有已答题无评分时不生成零分报告", async () => {
  db.exec("UPDATE interview_turns SET scores=''");
  const before = snapshot();
  expect((await finish()).status).toBe(422);
  expect(model.chat).not.toHaveBeenCalled();
  expect(snapshot()).toEqual(before);
});

it("模型等待期间评分变更由现有快照检查拒绝，不覆盖刚变化的记录", async () => {
  let resolve!: (value: string) => void;
  let started!: () => void;
  const entered = new Promise<void>(done => { started = done; });
  model.chat.mockImplementationOnce(() => { started(); return new Promise<string>(done => { resolve = done; }); });
  const pending = finish();
  await entered;
  db.exec("UPDATE interview_turns SET scores='{damaged' WHERE id=1");
  const changed = snapshot();
  resolve(JSON.stringify(summary));
  expect((await pending).status).toBe(409);
  expect(snapshot()).toEqual(changed);
  expect((await finish()).status).toBe(422);
  expect(model.chat).toHaveBeenCalledOnce();
});

it.each(["", 1, {}, "warning"] as const)("详情不能以矛盾或非法 scores_error %j 混入有效评分", async warning => {
  const payload = await detail();
  payload.turns[0].scores_error = warning;
  expect(() => parseInterviewDetail(payload, 1)).toThrow("面试状态不完整");
});
