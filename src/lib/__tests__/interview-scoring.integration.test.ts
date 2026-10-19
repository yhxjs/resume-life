import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_BACKUP_FIELD_BYTES, MAX_BACKUP_RECORD_BYTES } from "@/lib/backup-limits";

const model = vi.hoisted(() => ({ chat: vi.fn(), chatStream: vi.fn() }));
vi.mock("@/lib/llm", async (original) => ({ ...await original<typeof import("@/lib/llm")>(), ...model }));

let directory: string;
let db: DatabaseSync;
const valid = { depth: 0, structure: 10, authenticity: 0, completeness: 10, comment: "点评", reference: "参考答案" };

beforeEach(async () => {
  vi.resetModules();
  model.chat.mockReset().mockResolvedValue(JSON.stringify(valid));
  model.chatStream.mockReset();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-scoring-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", path.join(directory, "data"));
  db = (await import("@/lib/db")).getDb();
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'合成简历','',''); INSERT INTO interviews (id,resume_id,jd,rounds,created_at) VALUES (1,1,'岗位',2,''); INSERT INTO interview_turns (id,interview_id,idx,question) VALUES (1,1,1,'问题')");
});

afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-scoring-")) throw new Error("Unsafe cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
});

async function retry(answer = "新回答") {
  const { POST } = await import("@/app/api/interviews/[id]/turns/[tid]/retry/route");
  return POST(new Request("http://localhost/api/interviews/1/turns/1/retry", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answer }),
  }), { params: Promise.resolve({ id: "1", tid: "1" }) });
}

describe("面试评分写入契约", () => {
  it.each(['[{"id":"old"}', '{}', 'null', '"legacy"'])("损坏或非数组历史 %s 拒绝追加并保留原字节", async (retries) => {
    db.prepare("UPDATE interview_turns SET retries=?,reference='旧参考' WHERE id=1").run(retries);
    const response = await retry();
    expect(response.status).toBe(422);
    expect((await response.json()).error).toContain("重答历史数据损坏");
    expect(model.chat).not.toHaveBeenCalled();
    expect(db.prepare("SELECT retries,reference FROM interview_turns WHERE id=1").get()).toEqual({ retries, reference: "旧参考" });
  });

  it("模型等待期间历史损坏，提交时仍拒绝覆盖", async () => {
    const retries = '[{"id":"concurrent"}';
    model.chat.mockImplementationOnce(async () => {
      db.prepare("UPDATE interview_turns SET retries=? WHERE id=1").run(retries);
      return JSON.stringify(valid);
    });
    const response = await retry();
    expect(response.status).toBe(422);
    expect(db.prepare("SELECT retries,reference FROM interview_turns WHERE id=1").get()).toEqual({ retries, reference: "" });
  });

  it("累计历史字段超限时拒绝写入并保留历史和参考答案", async () => {
    const retries = history("A".repeat(MAX_BACKUP_FIELD_BYTES - 200));
    expect(Buffer.byteLength(retries)).toBeLessThan(MAX_BACKUP_FIELD_BYTES);
    db.prepare("UPDATE interview_turns SET retries=? WHERE id=1").run(retries);
    const response = await retry("B".repeat(12000));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("重答历史");
    expect(db.prepare("SELECT retries,reference FROM interview_turns WHERE id=1").get()).toEqual({ retries, reference: "" });
  });

  it.each(["中", '"\\'])("%s 的 UTF-8/JSON 开销使完整备份记录超限时拒绝追加", async (unit) => {
    const retries = nearRecordLimit(unit, 4000);
    expect(Buffer.byteLength(retries)).toBeLessThan(MAX_BACKUP_FIELD_BYTES);
    db.prepare("UPDATE interview_turns SET retries=? WHERE id=1").run(retries);
    const before = db.prepare("SELECT * FROM interview_turns WHERE id=1").get()!;
    expect(recordBytes(before)).toBeLessThanOrEqual(MAX_BACKUP_RECORD_BYTES);
    const response = await retry("B".repeat(12000));
    expect(response.status).toBe(400);
    expect(db.prepare("SELECT * FROM interview_turns WHERE id=1").get()).toEqual(before);
  });

  it("合法的临界历史追加后，真实整库备份流仍完整导出", async () => {
    const retries = nearRecordLimit('"\\', 30000);
    db.prepare("UPDATE interview_turns SET retries=? WHERE id=1").run(retries);
    const response = await retry("B".repeat(12000));
    expect(response.status).toBe(200);
    const { createBackupRecordStream } = await import("@/lib/backup-records");
    let exported: string | undefined;
    for await (const chunk of createBackupRecordStream(db)) {
      const record = JSON.parse(chunk.toString());
      if (record.kind === "row" && record.table === "interview_turns") exported = record.data.retries;
    }
    expect(exported).toBe((db.prepare("SELECT retries FROM interview_turns WHERE id=1").get() as { retries: string }).retries);
    expect(JSON.parse(exported!)).toHaveLength(2);
  });

  it("主作答接受零分，发送 done 并保存回答和下一题", async () => {
    model.chatStream.mockResolvedValueOnce(JSON.stringify({ ...valid, next_kind: "question", next_question: "下一题" }));
    const { POST } = await import("@/app/api/interviews/[id]/answer/route");
    const response = await POST(new Request("http://localhost/api/interviews/1/answer", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ turn_id: 1, answer: "回答" }),
    }), { params: Promise.resolve({ id: "1" }) });
    expect(await response.text()).toContain("event: done");
    const stored = db.prepare("SELECT answer,scores FROM interview_turns WHERE id=1").get() as { answer: string; scores: string };
    expect(stored.answer).toBe("回答");
    expect(JSON.parse(stored.scores)).toEqual({ depth: 0, structure: 10, authenticity: 0, completeness: 10 });
    expect(db.prepare("SELECT question FROM interview_turns WHERE idx=2").get()).toEqual({ question: "下一题" });
  });

  it.each([
    ["空对象", {}],
    ["缺少维度", { ...valid, depth: undefined }],
    ["字符串评分", { ...valid, depth: "8" }],
    ["负分", { ...valid, depth: -1 }],
    ["超范围", { ...valid, depth: 11 }],
    ["小数评分", { ...valid, depth: 0.5 }],
    ["空点评", { ...valid, comment: " \n " }],
    ["缺少点评", { ...valid, comment: undefined }],
    ["空参考答案", { ...valid, reference: " " }],
    ["缺少参考答案", { ...valid, reference: undefined }],
    ["数组根值", []],
    ["null 根值", null],
  ])("重评拒绝%s，历史和参考答案不变", async (_label, value) => {
    const originalRetries = JSON.stringify([{ id: "old", scores: null, comment: "", answer: "旧回答", created_at: "" }]);
    db.prepare("UPDATE interview_turns SET retries=?,reference='已有参考答案' WHERE id=1").run(originalRetries);
    model.chat.mockResolvedValueOnce(JSON.stringify(value));
    const response = await retry();
    expect(response.status).toBe(502);
    expect((await response.json()).error).toContain("协议错误");
    expect(db.prepare("SELECT retries,reference FROM interview_turns WHERE id=1").get()).toEqual({ retries: originalRetries, reference: "已有参考答案" });
  });

  it("重评接受零分，裁剪必填文本并保留历史空评分", async () => {
    db.prepare("UPDATE interview_turns SET retries=? WHERE id=1").run(JSON.stringify([{ id: "legacy", scores: null }]));
    model.chat.mockResolvedValueOnce(JSON.stringify({ ...valid, comment: " 点评 ", reference: " 参考答案 " }));
    const response = await retry();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.retry).toMatchObject({ scores: { depth: 0, structure: 10, authenticity: 0, completeness: 10 }, comment: "点评", reference: "参考答案" });
    expect(body.retries).toHaveLength(2);
    expect(body.retries[0]).toEqual({ id: "legacy", scores: null });
    expect(body.reference).toBe("参考答案");
  });
});

function history(answer: string): string {
  return JSON.stringify([{ id: "old", answer, scores: null, comment: "", created_at: "" }]);
}

function recordBytes(data: Record<string, unknown>): number {
  return Buffer.byteLength(`${JSON.stringify({ kind: "row", table: "interview_turns", data })}\n`, "utf8");
}

function nearRecordLimit(unit: string, remaining: number): string {
  const row = db.prepare("SELECT * FROM interview_turns WHERE id=1").get()!;
  let low = 0;
  let high = MAX_BACKUP_RECORD_BYTES;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (recordBytes({ ...row, retries: history(unit.repeat(mid)) }) <= MAX_BACKUP_RECORD_BYTES - remaining) low = mid;
    else high = mid - 1;
  }
  return history(unit.repeat(low));
}
