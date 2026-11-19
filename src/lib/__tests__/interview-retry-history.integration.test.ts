import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseInterviewRetryResponse } from "../interview-retry-response";

const model = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock("@/lib/llm", async original => ({ ...await original<typeof import("@/lib/llm")>(), ...model }));
let directory: string;
let db: DatabaseSync;
const requestId = "19cc674b-8736-481f-9055-883829b55e73";
const answer = "本次真实回答";
const scores = { depth: 7, structure: 8, authenticity: 9, completeness: 7 };
const legacy = { id: "legacy", answer: "  旧原文 <T> &amp;\n未上线  ", comment: "", scores: null, created_at: "" };
beforeEach(async () => {
  vi.resetModules();
  model.chat.mockReset().mockResolvedValue(JSON.stringify({ ...scores, comment: "点评", reference: "新参考" }));
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-retry-history-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'简历','',''); INSERT INTO interviews (id,resume_id,jd,rounds,status,created_at) VALUES (1,1,'岗位',1,'finished',''); INSERT INTO interview_turns (id,interview_id,idx,question,answer,reference,answered_at) VALUES (1,1,1,'原题','原答','原参考','已答')");
});
afterEach(() => {
  db.close(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-retry-history-")) throw new Error("Unsafe cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
});
function stored() { return db.prepare("SELECT * FROM interview_turns WHERE id=1").get()!; }
async function get() {
  return (await import("@/app/api/interviews/[id]/route")).GET(new Request("http://localhost/api/interviews/1"), { params: Promise.resolve({ id: "1" }) });
}
async function retry() {
  return (await import("@/app/api/interviews/[id]/turns/[tid]/retry/route")).POST(new Request("http://localhost/api/interviews/1/turns/1/retry", {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": requestId }, body: JSON.stringify({ answer }),
  }), { params: Promise.resolve({ id: "1", tid: "1" }) });
}

it.each([legacy, { id: "sparse", scores: null }, { ...legacy, scores: { ...scores, depth: 7.5 }, reference: ` \n${"长文 <T> &amp;".repeat(1500)} ` }].map((history, index) => ({ history, index })))(
  "历史 $index 缺字段／空日期正常读取与重答，原存储字段和额外字段不被回写", async ({ history }) => {
    const original = { ...history, extra_legacy: "原存储扩展字段" };
    const raw = JSON.stringify([original]);
    db.prepare("UPDATE interview_turns SET retries=? WHERE id=1").run(raw);
    const before = stored();
    const response = await get();
    expect(response.status).toBe(200);
    const turn = (await response.json()).turns[0];
    const displayed = { answer: "", comment: "", created_at: "", ...history };
    expect(turn.retries).toEqual([displayed]);
    expect(turn.retries_error).toBeUndefined();
    expect(stored()).toEqual(before);
    const first = await retry();
    expect(first.status).toBe(200);
    const payload = await first.json();
    expect(parseInterviewRetryResponse(payload, { id: requestId, answer }).retries).toEqual([displayed, payload.retry]);
    expect(JSON.parse(stored().retries as string)).toEqual([original, payload.retry]);
    expect(stored()).toEqual({ ...before, retries: stored().retries });
    expect(await (await retry()).json()).toEqual(payload);
    expect(model.chat).toHaveBeenCalledOnce();
  },
);

const damaged = ['{broken', 'null', '{}', '[null]', '[{}]', JSON.stringify([{ ...legacy, reference: {} }]), JSON.stringify([{ ...legacy, scores: { ...scores, depth: "7" } }]), JSON.stringify([legacy, legacy])];
it("新重答重复评分字段整份拒绝，原答及重答历史保留，显式重试可恢复", async () => {
  db.prepare("UPDATE interview_turns SET retries=? WHERE id=1").run(JSON.stringify([legacy]));
  const before = stored();
  model.chat.mockResolvedValueOnce('{"depth":2,' + JSON.stringify({ ...scores, comment: "点评", reference: "参考" }).slice(1));
  const failed = await retry();
  expect(failed.status).toBe(502);
  expect(stored()).toEqual(before);
  const recovered = await retry();
  expect(recovered.status).toBe(200);
  const payload = await recovered.json();
  expect(JSON.parse(stored().retries as string)).toEqual([legacy, payload.retry]);
  expect(payload.retry.scores).toEqual(scores);
  expect(stored()).toEqual({ ...before, retries: stored().retries });
  expect(model.chat).toHaveBeenCalledTimes(2);
});

it.each(damaged)("损坏历史 %s 读取提示且原题可见，写入前拒绝并保留原字节", async raw => {
  db.prepare("UPDATE interview_turns SET retries=? WHERE id=1").run(raw);
  const before = stored();
  const response = await get();
  expect(response.status).toBe(200);
  const turn = (await response.json()).turns[0];
  expect(turn).toMatchObject({ answer: "原答", reference: "原参考", retries: [] });
  expect(turn.retries_error).toContain("重答历史暂无法读取");
  const result = await retry();
  expect(result.status).toBe(422);
  expect((await result.json()).error).toContain("历史数据损坏");
  expect(model.chat).not.toHaveBeenCalled();
  expect(stored()).toEqual(before);
});

it("等待模型期间历史变成损坏数组时拒绝提交，不覆盖并发原字节", async () => {
  const raw = JSON.stringify([null]);
  model.chat.mockImplementationOnce(async () => {
    db.prepare("UPDATE interview_turns SET retries=? WHERE id=1").run(raw);
    return JSON.stringify({ ...scores, comment: "点评", reference: "参考" });
  });
  const response = await retry();
  expect(response.status).toBe(422);
  expect(stored().retries).toBe(raw);
  expect(model.chat).toHaveBeenCalledOnce();
});
