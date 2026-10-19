import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewDetail, ReviewList } from "../spaced-repetition-card-types";

const model = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock("../safe-llm", async (original) => ({ ...await original<typeof import("../safe-llm")>(), safeChat: model.chat }));

let directory: string;
let db: DatabaseSync;
beforeEach(async () => {
  vi.resetModules();
  model.chat.mockReset();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-reviews-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
});
afterEach(() => {
  db?.close();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-reviews-")) throw new Error("Unsafe cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
});

function seedQuestion(source = "interview", answered = true) {
  const drill = Number(db.prepare("INSERT INTO drills (source, focus, created_at) VALUES (?, '技术深度', ?)").run(source, new Date().toISOString()).lastInsertRowid);
  const id = Number(db.prepare("INSERT INTO drill_questions (drill_id,idx,question,answer,reference,answered_at) VALUES (?,1,'解释事务隔离','原始回答','参考要点',?)").run(drill, answered ? new Date().toISOString() : "").lastInsertRowid);
  return { id, drill };
}
async function favorite(questionId: number) {
  const route = await import("@/app/api/notebook/route");
  const response = await route.POST(new Request("http://localhost/api/notebook", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: "drill", source_id: questionId }) }));
  expect(response.status).toBe(201);
  return (await response.json()).id as number;
}
async function enroll(questionId: number) {
  (await import("../spaced-repetition-enrollment")).enrollRemedialReview(db, questionId);
}
async function list(query = ""): Promise<ReviewList> {
  const route = await import("@/app/api/reviews/route");
  const response = await route.GET(new Request(`http://localhost/api/reviews?time_zone=Asia%2FShanghai&${query}`));
  expect(response.status).toBe(200);
  return response.json();
}
async function detail(id: number, query = ""): Promise<ReviewDetail> {
  const route = await import("@/app/api/reviews/[id]/route");
  const response = await route.GET(new Request(`http://localhost/api/reviews/${id}?${query}`), { params: Promise.resolve({ id: String(id) }) });
  expect(response.status).toBe(200);
  return response.json();
}
async function submit(id: number, body: Record<string, unknown> = {}) {
  const route = await import("@/app/api/reviews/[id]/route");
  return route.POST(new Request(`http://localhost/api/reviews/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answer: "独立回忆的回答", grade: "good", expected_review_count: 0, request_id: randomUUID(), time_zone: "Asia/Shanghai", ...body }) }), { params: Promise.resolve({ id: String(id) }) });
}

describe("复习闭环", () => {
  it("服务器日期领先用户时，新收藏卡和追练卡仍在当地今日队列", async () => {
    vi.stubEnv("TZ", "UTC");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-27T01:00:00.000Z"));
    await favorite(seedQuestion("bank").id);
    await enroll(seedQuestion().id);
    const route = await import("@/app/api/reviews/route");
    const response = await route.GET(new Request("http://localhost/api/reviews?time_zone=America%2FLos_Angeles"));
    const page = await response.json() as ReviewList;
    expect(page.summary).toMatchObject({ date: "2026-09-26", due: 2, notebook: 1, remedial: 1, overdue: 0 });
    expect(page.items.every(card => card.next_review_date === "2026-09-26")).toBe(true);
    expect(await detail(page.items[0]!.id, "time_zone=America%2FLos_Angeles")).toMatchObject({ next_review_date: "2026-09-26" });
    const saved = await submit(page.items[0]!.id, { time_zone: "America/Los_Angeles" });
    expect((await saved.json()).card.next_review_date).toBe("2026-09-27");
  });
  it("真实追练评分入口完成后自动入列，再次评分不重置复习进度", async () => {
    const question = seedQuestion("interview", false);
    model.chat.mockResolvedValue(JSON.stringify({ depth: 7, structure: 7, authenticity: 7, completeness: 7, comment: "点评", reference: "改进参考" }));
    const route = await import("@/app/api/drills/[id]/questions/[qid]/route");
    const answer = () => route.POST(new Request(`http://localhost/api/drills/${question.drill}/questions/${question.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answer: "首次完整作答" }) }), { params: Promise.resolve({ id: String(question.drill), qid: String(question.id) }) });
    expect((await list()).items).toHaveLength(0);
    expect((await answer()).status).toBe(200);
    const page = await list();
    expect(page.summary.remedial).toBe(1);
    const id = page.items[0]!.id;
    await submit(id);
    expect((await answer()).status).toBe(200);
    expect((await detail(id)).review_count).toBe(1);
  });
  it("备份往返完整保留复习排期、自增序列与作答记录", async () => {
    const notebook = await favorite(seedQuestion().id);
    const id = (await list()).items[0]!.id;
    await submit(id);
    const before = await detail(id);
    const backup = await import("../backup");
    const records = await import("../backup-records");
    const { stageBackupRecordStream } = await import("../backup-staging");
    const chunks: Uint8Array[] = [];
    for await (const chunk of records.createBackupRecordStream(db)) chunks.push(chunk);
    async function* source() { for (const chunk of chunks) yield chunk; }
    const staged = await stageBackupRecordStream(source(), db);
    try {
      db.prepare("DELETE FROM notebook_entries WHERE id=?").run(notebook);
      backup.restoreAllData(staged, false);
      expect(await detail(id)).toEqual(before);
      expect(backup.readBackupSequences(db).review_attempts).toBe(before.attempts[0]!.id);
    } finally { staged.dispose(); }
  });
  it("收藏自动加入今日待复习，保留原始快照", async () => {
    const question = seedQuestion("bank");
    const notebookId = await favorite(question.id);
    const page = await list();
    expect(page.summary).toMatchObject({ total: 1, due: 1, notebook: 1, remedial: 0 });
    expect(page.items[0]).toMatchObject({ source: "notebook", source_id: notebookId, mastery: "new" });
    expect(await detail(page.items[0]!.id)).toMatchObject({ answer: "原始回答", reference: "参考要点", attempts: [] });
  });
  it("仅已答追练自动加入，重复入列幂等", async () => {
    const answered = seedQuestion();
    const unanswered = seedQuestion("interview", false);
    const ordinary = seedQuestion("bank");
    for (const id of [answered.id, answered.id, unanswered.id, ordinary.id]) await enroll(id);
    const page = await list();
    expect(page.items).toHaveLength(1);
    expect(page.summary.remedial).toBe(1);
  });
  it("保存回答与新排期同一事务提交，历史不覆盖原快照", async () => {
    const question = seedQuestion();
    const notebookId = await favorite(question.id);
    const card = (await list()).items[0]!;
    expect((await submit(card.id)).status).toBe(200);
    expect((await list()).items).toHaveLength(0);
    expect((await list()).summary.completed_today).toBe(1);
    expect((await submit(card.id, { expected_review_count: 1, answer: "第二次独立回忆", grade: "again" })).status).toBe(200);
    const saved = await detail(card.id);
    expect(saved).toMatchObject({ review_count: 2, repetitions: 0, mastery: "relearning", interval_days: 1 });
    expect(saved.attempts.map(a => a.answer)).toEqual(["第二次独立回忆", "独立回忆的回答"]);
    expect(db.prepare("SELECT answer FROM notebook_entries WHERE id=?").get(notebookId)).toEqual({ answer: "原始回答" });
  });
  it("相同请求重试不重复计数，旧页面提交返回冲突", async () => {
    await favorite(seedQuestion().id);
    const card = (await list()).items[0]!;
    const request_id = randomUUID();
    expect((await submit(card.id, { request_id })).status).toBe(200);
    expect((await submit(card.id, { request_id })).status).toBe(200);
    expect((await submit(card.id, { request_id, answer: "篡改重试内容" })).status).toBe(409);
    expect((await submit(card.id)).status).toBe(409);
    expect((await detail(card.id)).review_count).toBe(1);
    expect((await detail(card.id)).attempts).toHaveLength(1);
  });
  it("收藏追练转接原卡及历史，删除原练习不影响错题复习", async () => {
    const question = seedQuestion();
    await enroll(question.id);
    const id = (await list()).items[0]!.id;
    await submit(id);
    const notebookId = await favorite(question.id);
    expect((await list("scope=all")).items).toHaveLength(1);
    db.prepare("DELETE FROM drills WHERE id=?").run(question.drill);
    const saved = await detail(id);
    expect(saved).toMatchObject({ source: "notebook", source_id: notebookId, review_count: 1 });
    expect(saved.attempts).toHaveLength(1);
    db.prepare("DELETE FROM notebook_entries WHERE id=?").run(notebookId);
    expect(db.prepare("SELECT COUNT(*) AS count FROM review_attempts").get()).toEqual({ count: 0 });
  });
  it("到期排序分页无遗漏，逾期纳入今日", async () => {
    for (let i = 0; i < 4; i++) await favorite(seedQuestion("bank").id);
    const all = (await list()).items;
    db.prepare("UPDATE review_cards SET next_review_date='2026-01-01', review_count=1 WHERE id=?").run(all[2]!.id);
    db.prepare("UPDATE review_cards SET next_review_date='2099-01-01', review_count=1 WHERE id=?").run(all[0]!.id);
    const first = await list("limit=2");
    expect(first.summary).toMatchObject({ total: 4, due: 3, overdue: 1 });
    expect(first.items[0]!.id).toBe(all[2]!.id);
    const second = await list(`limit=2&cursor=${first.nextCursor}`);
    expect(new Set([...first.items, ...second.items].map(item => item.id)).size).toBe(3);
    expect(second.nextCursor).toBeNull();
  });
  it("输入与时区校验失败不写日志", async () => {
    await favorite(seedQuestion().id);
    const id = (await list()).items[0]!.id;
    for (const body of [{ answer: "  " }, { grade: "invalid" }, { expected_review_count: -1 }, { request_id: "" }, { time_zone: "invalid" }, { answer: "x".repeat(20001) }, { answer: "\u0000hello" }, { answer: "hello\u0000world" }]) {
      expect((await submit(id, body)).status).toBe(400);
    }
    expect((await detail(id)).attempts).toHaveLength(0);
    expect((await submit(9999)).status).toBe(404);
    const route = await import("@/app/api/reviews/route");
    for (const query of ["limit=0", "cursor=bad", "source=bad", "scope=bad", "time_zone=invalid"]) {
      expect((await route.GET(new Request(`http://localhost/api/reviews?${query}`))).status).toBe(400);
    }
  });
  it("历史分页保留每一次作答", async () => {
    await favorite(seedQuestion().id);
    const id = (await list()).items[0]!.id;
    for (let n = 0; n < 3; n++) await submit(id, { expected_review_count: n, answer: `回忆${n}` });
    const first = await detail(id, "limit=2");
    expect(first.attempts).toHaveLength(2);
    const last = await detail(id, `limit=2&cursor=${first.nextCursor}`);
    expect(last.attempts.map(a => a.answer)).toEqual(["回忆0"]);
    expect(last.nextCursor).toBeNull();
  });
  it("日志写入失败时排期同步回滚", async () => {
    await favorite(seedQuestion().id);
    const id = (await list()).items[0]!.id;
    db.exec("CREATE TRIGGER fail_review_insert BEFORE INSERT ON review_attempts BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
    expect((await submit(id)).status).toBe(500);
    expect((await detail(id)).review_count).toBe(0);
    expect((await list()).summary.due).toBe(1);
  });
});
