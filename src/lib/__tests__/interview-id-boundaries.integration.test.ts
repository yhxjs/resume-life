import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const model = vi.hoisted(() => ({ chat: vi.fn(), chatStream: vi.fn() }));
vi.mock("@/lib/llm", async original => ({ ...await original<typeof import("@/lib/llm")>(), ...model }));
const PREFIX = "resume-life-interview-id-boundaries-";
const answer = "我仅负责参数校验，验收结论待确认。";
const grade = { depth: 7, structure: 7, authenticity: 8, completeness: 7, comment: "保留了实际分工与未确认状态。", next_kind: "question", next_question: "" };
let directory: string;
let db: DatabaseSync;
let versionId: number;

beforeEach(async () => {
  vi.resetModules(); model.chat.mockReset(); model.chatStream.mockReset();
  model.chatStream.mockResolvedValue(JSON.stringify(grade));
  directory = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'材料原稿','','')");
  versionId = (await import("../resume-versions")).publishResumeVersion(1, { name: "已发布材料" }).id;
  db.exec(`INSERT INTO interview_series (id,resume_id,jd,created_at) VALUES (1,1,'接口校验','');
    INSERT INTO interviews (id,resume_id,jd,rounds,created_at) VALUES (1,1,'接口校验',1,''),(2,1,'另一场次',1,'');
    INSERT INTO interview_turns (id,interview_id,idx,question) VALUES (1,1,1,'请说明个人分工'),(2,2,1,'另一场次题目');
    INSERT INTO notebook_entries (id,source,source_id,question,answer,comment,reference,scores,created_at,updated_at)
      VALUES (1,'interview',1,'独立收藏原题','独立收藏原答','独立收藏点评','独立收藏参考','{}','','');
    INSERT INTO review_cards (notebook_id,next_review_date,created_at) VALUES (1,'2026-10-29','original');
    INSERT INTO review_attempts (card_id,request_id,answer,grade,reviewed_at,review_date,interval_days,next_review_date)
      VALUES (1,'84083c07-12ea-46df-b22a-9723af3e314e','原复习作答','good','2026-10-28T00:00:00Z','2026-10-28',1,'2026-10-29');`);
});

afterEach(() => {
  db?.close(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(PREFIX)) throw new Error("Unsafe cleanup path");
  fs.rmSync(resolved, { recursive: true, force: true });
});

function state() {
  return Object.fromEntries(["resumes", "resume_versions", "interview_series", "interviews", "interview_turns", "notebook_entries", "review_cards", "review_attempts", "llm_call_logs"]
    .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
}
function request(body: unknown, method = "POST") {
  return new Request("http://localhost/api/interviews", { method, ...(method === "GET" || method === "DELETE" ? {} : {
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }) });
}
function untouched(before: ReturnType<typeof state>) {
  expect(model.chat).not.toHaveBeenCalled(); expect(model.chatStream).not.toHaveBeenCalled();
  expect(state()).toEqual(before);
}
async function rejected(response: Response, status: number, message?: string) {
  expect(response.status).toBe(status);
  if (message) expect(await response.json()).toEqual({ error: message });
  expect(response.headers.get("cache-control")).toContain("no-store");
}
const invalidBodyIds = [true, false, [1], [[1]], [], {}, null, "", "1", "1e0", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined];

describe.each(["single", "series"])("面试 %s 创建来源 ID", mode => {
  it.each(invalidBodyIds.map(value => ({ value, label: JSON.stringify(value) ?? "undefined" })))("拒绝 $label，不能转换成简历 1", async ({ value }) => {
    model.chatStream.mockResolvedValue('{"question":"请描述你实际参与的任务。"}');
    const before = state(); const { POST } = await import("@/app/api/interviews/route");
    await rejected(await POST(request({ resume_id: value, resume_version_id: versionId, jd: "接口校验", mode })), 400, "请选择简历");
    untouched(before);
  });

  it("安全整数上界按不存在处理，正常数字来源仍可创建", async () => {
    const before = state(); const { POST } = await import("@/app/api/interviews/route");
    await rejected(await POST(request({ resume_id: Number.MAX_SAFE_INTEGER, jd: "接口校验", mode })), 404, "简历不存在");
    untouched(before);
    const question = "请描述你实际参与的任务。";
    model.chatStream.mockResolvedValue(JSON.stringify({ question }));
    const response = await POST(request({ resume_id: 1, resume_version_id: versionId, jd: "接口校验", rounds: 1, mode }));
    expect(response.status).toBe(200);
    const events = await response.text(); expect(events).not.toContain("event: error");
    const match = events.match(/event: done\ndata: ([^\n]+)/); expect(match, events).not.toBeNull();
    const created = JSON.parse(match![1]!);
    expect(db.prepare("SELECT resume_id,resume_version_id,series_id FROM interviews WHERE id=?").get(created.id)).toEqual({ resume_id: 1, resume_version_id: versionId, series_id: created.series_id });
    expect(db.prepare("SELECT question FROM interview_turns WHERE interview_id=?").all(created.id)).toEqual([{ question }]);
    if (mode === "series") {
      expect(created.series_id).toBeGreaterThan(1);
      expect(db.prepare("SELECT resume_id,resume_version_id FROM interview_series WHERE id=?").get(created.series_id)).toEqual({ resume_id: 1, resume_version_id: versionId });
    } else expect(created.series_id).toBeNull();
    expect(model.chatStream).toHaveBeenCalledOnce();
    const after = state();
    for (const key of ["resumes", "resume_versions", "notebook_entries", "review_cards", "review_attempts"]) expect(after[key]).toEqual(before[key]);
    expect(db.prepare("SELECT * FROM interviews WHERE id<=2 ORDER BY id").all()).toEqual(before.interviews);
  });
});

describe("面试作答 JSON 轮次 ID", () => {
  it.each(invalidBodyIds.map(value => ({ value, label: JSON.stringify(value) ?? "undefined" })))("拒绝 $label，不能转换成未答轮次 1", async ({ value }) => {
    const before = state(); const { POST } = await import("@/app/api/interviews/[id]/answer/route");
    await rejected(await POST(request({ turn_id: value, answer }), { params: Promise.resolve({ id: "1" }) }), 400, "无效的轮次 ID");
    untouched(before);
  });

  it("不存在、跨场和已答轮次沿用业务拒绝，正常数字轮次仅更新目标题", async () => {
    const before = state(); const { POST } = await import("@/app/api/interviews/[id]/answer/route");
    for (const turnId of [Number.MAX_SAFE_INTEGER, 2]) {
      await rejected(await POST(request({ turn_id: turnId, answer }), { params: Promise.resolve({ id: "1" }) }), 400, "该题已作答或不存在");
    }
    untouched(before);
    const response = await POST(request({ turn_id: 1, answer }), { params: Promise.resolve({ id: "1" }) });
    const events = await response.text(); expect(response.status).toBe(200);
    expect(events).toContain("event: done"); expect(events).not.toContain("event: error");
    expect(model.chatStream).toHaveBeenCalledOnce();
    expect(db.prepare("SELECT answer,comment,scores FROM interview_turns WHERE id=1").get()).toEqual({ answer, comment: grade.comment, scores: JSON.stringify({ depth: 7, structure: 7, authenticity: 8, completeness: 7 }) });
    expect(db.prepare("SELECT status FROM interviews WHERE id=1").get()).toEqual({ status: "finished" });
    expect(db.prepare("SELECT * FROM interview_turns WHERE id=2").all()).toEqual((before.interview_turns as { id: number }[]).filter(row => row.id === 2));
    expect(db.prepare("SELECT * FROM interviews WHERE id=2").all()).toEqual((before.interviews as { id: number }[]).filter(row => row.id === 2));
    const after = state();
    for (const key of ["resumes", "resume_versions", "interview_series", "notebook_entries", "review_cards", "review_attempts"]) expect(after[key]).toEqual(before[key]);
    await rejected(await POST(request({ turn_id: 1, answer }), { params: Promise.resolve({ id: "1" }) }), 400, "面试已结束");
    expect(model.chatStream).toHaveBeenCalledOnce(); expect(state()).toEqual(after);
  });
});

const interviewError = "无效的面试 ID";
const seriesError = "无效的进阶面试 ID";
const routes = [
  { label: "面试 GET", method: "GET", load: async () => (await import("@/app/api/interviews/[id]/route")).GET, error: interviewError },
  { label: "面试 DELETE", method: "DELETE", load: async () => (await import("@/app/api/interviews/[id]/route")).DELETE, error: interviewError },
  { label: "作答", load: async () => (await import("@/app/api/interviews/[id]/answer/route")).POST, error: interviewError },
  { label: "结束报告", load: async () => (await import("@/app/api/interviews/[id]/finish/route")).POST, error: interviewError },
  { label: "主考官报告", load: async () => (await import("@/app/api/interviews/[id]/evaluator-report/route")).POST, error: interviewError },
  { label: "反问", load: async () => (await import("@/app/api/interviews/[id]/reverse/route")).POST, error: interviewError },
  ...(["id", "tid"] as const).flatMap(field => [
    { label: `参考答案 ${field}`, field, load: async () => (await import("@/app/api/interviews/[id]/turns/[tid]/reference/route")).POST, error: "无效的 ID" },
    { label: `重答 ${field}`, field, load: async () => (await import("@/app/api/interviews/[id]/turns/[tid]/retry/route")).POST, error: "无效的 ID" },
  ]),
  { label: "系列 GET", method: "GET", load: async () => (await import("@/app/api/interviews/series/[id]/route")).GET, error: seriesError },
  { label: "系列 DELETE", method: "DELETE", load: async () => (await import("@/app/api/interviews/series/[id]/route")).DELETE, error: seriesError },
  { label: "系列总评", load: async () => (await import("@/app/api/interviews/series/[id]/finalize/route")).POST, error: seriesError },
  { label: "系列推进", load: async () => (await import("@/app/api/interviews/series/[id]/advance/route")).POST, error: seriesError },
];
describe.each(routes)("$label 路径边界", route => {
  const field = "field" in route ? route.field : "id";
  const method = "method" in route ? route.method : "POST";
  it.each(["0", "-1", "1.5", "9007199254740992", "9007199254740993", "1e100", "1e0", "0x1", "+1", "01", " 1", "1 ", "NaN", "Infinity", "abc", ""])("拒绝 %s，零模型调用且保留全部存档", async value => {
    const before = state(); const handler = await route.load();
    await rejected(await handler(request({ turn_id: 1, answer, question: "你们如何核对字段？", from_interview_id: 1 }, method), { params: Promise.resolve({ id: "1", tid: "1", [field]: value }) }), 400, route.error);
    untouched(before);
  });
  it("安全整数上界保留不存在语义", async () => {
    const before = state(); const handler = await route.load();
    await rejected(await handler(request({ turn_id: 1, answer, question: "你们如何核对字段？", from_interview_id: 1 }, method), { params: Promise.resolve({ id: "1", tid: "1", [field]: String(Number.MAX_SAFE_INTEGER) }) }), 404);
    untouched(before);
  });
});

it.each(["reference", "retry"] as const)("%s 拒绝跨场题目，不读取或改写另一场原答", async action => {
  const before = state();
  const { POST } = action === "reference"
    ? await import("@/app/api/interviews/[id]/turns/[tid]/reference/route")
    : await import("@/app/api/interviews/[id]/turns/[tid]/retry/route");
  await rejected(await POST(request({ answer }), { params: Promise.resolve({ id: "1", tid: "2" }) }), 404, "题目不存在");
  untouched(before);
});
