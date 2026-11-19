import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_BACKUP_FIELD_BYTES, MAX_BACKUP_RECORD_BYTES } from "@/lib/backup-limits";
import { INTERVIEW_ANSWER_OUTPUT_LIMITS } from "@/lib/model-protocol";

const model = vi.hoisted(() => ({ chat: vi.fn(), chatStream: vi.fn() }));
vi.mock("@/lib/llm", async (original) => ({ ...await original<typeof import("@/lib/llm")>(), ...model }));

let directory: string;
let db: DatabaseSync;
const valid = { depth: 0, structure: 10, authenticity: 0, completeness: 10, comment: "点评", reference: "参考答案" };
const validDecision = { depth: 0, structure: 10, authenticity: 0, completeness: 10, comment: "点评" };

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

async function retry(answer = "新回答", requestId?: string, turnId = 1) {
  const { POST } = await import("@/app/api/interviews/[id]/turns/[tid]/retry/route");
  return POST(new Request(`http://localhost/api/interviews/1/turns/${turnId}/retry`, {
    method: "POST", headers: { "Content-Type": "application/json", ...(requestId !== undefined ? { "Idempotency-Key": requestId } : {}) }, body: JSON.stringify({ answer }),
  }), { params: Promise.resolve({ id: "1", tid: String(turnId) }) });
}

describe("面试评分写入契约", () => {
  it("重答参考示例不预设高分，不为篇幅目标补造经历", async () => {
    const response = await retry("我只做接口校验，未上线且无量化数据。");
    expect(response.status).toBe(200);
    const messages = model.chat.mock.calls[0]![1] as { role: string; content: string }[];
    const system = messages.find((message) => message.role === "system")!.content;
    expect(system).not.toContain("高分示范");
    expect(system).toContain("不为凑足篇幅");
    expect(system).toContain("简短且充分时可以少于示例句数，不重复评分理由");
    expect(system).toContain("只从“本次重新作答内容”提取证据写评分与 comment");
    expect(system).toContain("JSON 示例中的分数只展示整数类型，不是默认评分");
    expect(system).toContain("comment 必须含可见文字、数字或有意义符号");
    expect(system).toContain("reference 也须有实际内容");
    expect(system).toContain("最多 1200 字符");
    expect(system).toContain("最多 2400 字符");
    expect(system).toContain("最多 1200 字符");
  });

  it("已保存但响应丢失后，同一提交编号回读原结果，不重复评分或追加历史", async () => {
    const requestId = "1998b25b-a321-4079-87af-487de4efbc01";
    const answer = "只负责接口联调 <T> &amp;，尚未上线。";
    const first = await retry(answer, requestId);
    expect(first.status).toBe(200);
    const saved = await first.json();
    db.prepare("UPDATE interview_turns SET reference='后来生成的原题参考' WHERE id=1").run();
    const second = await retry(answer, requestId);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ ...saved, reference: "后来生成的原题参考" });
    expect(model.chat).toHaveBeenCalledOnce();
    expect(JSON.parse((db.prepare("SELECT retries FROM interview_turns WHERE id=1").get() as { retries: string }).retries)).toEqual([saved.retry]);
  });

  it("提交编号大小写归一，进程重载后仍从数据库恢复，不依赖内存缓存", async () => {
    const id = "1998b25b-a321-4079-87af-487de4efbc01";
    const first = await retry("原样回答", id);
    const saved = await first.json();
    db.close();
    vi.resetModules();
    db = (await import("@/lib/db")).getDb();
    const response = await retry("原样回答", id.toUpperCase());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(saved);
    expect(model.chat).toHaveBeenCalledOnce();
  });

  it("同一编号不能用于不同回答，冲突不调用模型或改写原记录", async () => {
    const id = "1998b25b-a321-4079-87af-487de4efbc01";
    const first = await retry("仅负责接口联调", id);
    expect(first.status).toBe(200);
    const before = db.prepare("SELECT * FROM interview_turns WHERE id=1").get();
    const response = await retry("负责另一项工作", id);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("其他回答");
    expect(model.chat).toHaveBeenCalledOnce();
    expect(db.prepare("SELECT * FROM interview_turns WHERE id=1").get()).toEqual(before);
  });

  it.each(["", "invalid", "a".repeat(129)])("非法提交编号 %s 在调用模型前拒绝", async (id) => {
    const response = await retry("回答", id);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("提交编号");
    expect(model.chat).not.toHaveBeenCalled();
    expect(db.prepare("SELECT retries FROM interview_turns WHERE id=1").get()).toEqual({ retries: "[]" });
  });

  it.each(["不同编号", "未传编号"])("%s 的相同文本仍可独立重新评分", async (mode) => {
    const ids = mode === "不同编号"
      ? ["1998b25b-a321-4079-87af-487de4efbc01", "1998b25b-a321-4079-87af-487de4efbc02"]
      : [undefined, undefined];
    const first = await retry("相同回答", ids[0]);
    const firstBody = await first.json();
    const second = await retry("相同回答", ids[1]);
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody.retries).toHaveLength(2);
    expect(secondBody.retry.id).not.toBe(firstBody.retry.id);
    expect(model.chat).toHaveBeenCalledTimes(2);
  });

  it("同编号仍在途时拒绝并行评分，提交后重试恢复同一条结果", async () => {
    const id = "1998b25b-a321-4079-87af-487de4efbc01";
    let finish!: (value: string) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    model.chat.mockImplementationOnce(() => {
      entered();
      return new Promise<string>((resolve) => { finish = resolve; });
    });
    const original = retry("在途回答", id);
    await started;
    const concurrent = await retry("在途回答", id);
    expect(concurrent.status).toBe(409);
    expect((await concurrent.json()).error).toContain("仍在评分");
    expect(model.chat).toHaveBeenCalledOnce();
    finish(JSON.stringify(valid));
    const saved = await (await original).json();
    const replay = await retry("在途回答", id);
    expect(await replay.json()).toEqual(saved);
    expect(saved.retries).toHaveLength(1);
    expect(model.chat).toHaveBeenCalledOnce();
  });

  it("模型失败后释放在途编号，原提交可以重试且只保存成功结果", async () => {
    const id = "1998b25b-a321-4079-87af-487de4efbc01";
    model.chat.mockRejectedValueOnce(new Error("本次模型不可用"));
    expect((await retry("原回答", id)).status).toBe(502);
    const response = await retry("原回答", id);
    expect(response.status).toBe(200);
    expect((await response.json()).retries).toHaveLength(1);
    expect(model.chat).toHaveBeenCalledTimes(2);
  });

  it("在途提交按题目隔离，相同编号不能阻塞另一题的合法重答", async () => {
    db.exec("INSERT INTO interview_turns (id,interview_id,idx,question) VALUES (2,1,2,'第二题')");
    const id = "1998b25b-a321-4079-87af-487de4efbc01";
    let finish!: (value: string) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    model.chat.mockImplementationOnce(() => {
      entered();
      return new Promise<string>((resolve) => { finish = resolve; });
    });
    const first = retry("第一题回答", id);
    await started;
    const second = await retry("第二题回答", id, 2);
    finish(JSON.stringify(valid));
    expect((await first).status).toBe(200);
    expect(second.status).toBe(200);
    const rows = db.prepare("SELECT retries FROM interview_turns ORDER BY id").all() as { retries: string }[];
    expect(rows.map((row) => JSON.parse(row.retries).map((entry: { answer: string }) => entry.answer))).toEqual([["第一题回答"], ["第二题回答"]]);
    expect(model.chat).toHaveBeenCalledTimes(2);
  });

  it("恢复数据后的新世代不被旧在途编号阻塞，旧结果仍拒绝提交", async () => {
    const id = "1998b25b-a321-4079-87af-487de4efbc01";
    let finish!: (value: string) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    model.chat.mockImplementationOnce(() => {
      entered();
      return new Promise<string>((resolve) => { finish = resolve; });
    });
    const old = retry("旧世代回答", id);
    await started;
    db.prepare("INSERT INTO runtime_state (id,data_generation) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET data_generation=excluded.data_generation")
      .run("1998b25b-a321-4079-87af-487de4efbc02");
    const current = await retry("新世代回答", id);
    finish(JSON.stringify(valid));
    const oldResponse = await old;
    expect(current.status).toBe(200);
    expect(oldResponse.status).toBe(409);
    expect((await oldResponse.json()).error).toContain("数据已恢复");
    const entries = JSON.parse((db.prepare("SELECT retries FROM interview_turns WHERE id=1").get() as { retries: string }).retries);
    expect(entries).toEqual([expect.objectContaining({ answer: "新世代回答" })]);
    expect(model.chat).toHaveBeenCalledTimes(2);
  });

  it.each(["相同回答", "其他回答"])("提交事务发现其他进程已保存%s时不重复追加", async (storedAnswer) => {
    const id = "1998b25b-a321-4079-87af-487de4efbc01";
    const savedRetry = { id: `retry_${id}`, answer: storedAnswer, scores: null, comment: "先保存的点评", reference: "先保存的参考", created_at: "2026-10-28" };
    model.chat.mockImplementationOnce(async () => {
      db.prepare("UPDATE interview_turns SET retries=? WHERE id=1").run(JSON.stringify([savedRetry]));
      return JSON.stringify(valid);
    });
    const response = await retry("相同回答", id);
    expect(response.status).toBe(storedAnswer === "相同回答" ? 200 : 409);
    if (response.status === 200) expect((await response.json()).retry).toEqual(savedRetry);
    expect(JSON.parse((db.prepare("SELECT retries FROM interview_turns WHERE id=1").get() as { retries: string }).retries)).toEqual([savedRetry]);
  });

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
    model.chatStream.mockResolvedValueOnce(JSON.stringify({ ...validDecision, next_kind: "question", next_question: "下一题" }));
    const { POST } = await import("@/app/api/interviews/[id]/answer/route");
    const response = await POST(new Request("http://localhost/api/interviews/1/answer", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ turn_id: 1, answer: "回答" }),
    }), { params: Promise.resolve({ id: "1" }) });
    expect(await response.text()).toContain("event: done");
    const stored = db.prepare("SELECT answer,scores FROM interview_turns WHERE id=1").get() as { answer: string; scores: string };
    expect(stored.answer).toBe("回答");
    expect(JSON.parse(stored.scores)).toEqual({ depth: 0, structure: 10, authenticity: 0, completeness: 10 });
    expect(db.prepare("SELECT question FROM interview_turns WHERE idx=2").get()).toEqual({ question: "下一题" });
    const messages = model.chatStream.mock.calls[0]![1] as { role: string; content: string }[];
    expect(messages.find((message) => message.role === "system")!.content).toContain("comment 通常为 2-3 句");
    expect(messages.find((message) => message.role === "system")!.content).toContain("最多 1200 字符");
  });

  it("主作答点评超限时不保存回答或创建下一题", async () => {
    const before = db.prepare("SELECT * FROM interview_turns WHERE id=1").get();
    model.chatStream.mockResolvedValueOnce(JSON.stringify({
      ...validDecision,
      comment: "评".repeat(INTERVIEW_ANSWER_OUTPUT_LIMITS.comment + 1),
      next_kind: "question",
      next_question: "下一题",
    }));
    const { POST } = await import("@/app/api/interviews/[id]/answer/route");
    const response = await POST(new Request("http://localhost/api/interviews/1/answer", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ turn_id: 1, answer: "回答" }),
    }), { params: Promise.resolve({ id: "1" }) });
    const events = await response.text();
    expect(events).toContain("不能超过 1200 字符");
    expect(events).not.toContain("event: done");
    expect(db.prepare("SELECT * FROM interview_turns WHERE id=1").get()).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS n FROM interview_turns").get()).toEqual({ n: 1 });
  });

  it("主作答拒绝仅含不可见字符的点评，不保存回答且有效回复可重试", async () => {
    const before = db.prepare("SELECT * FROM interview_turns WHERE id=1").get();
    const { POST } = await import("@/app/api/interviews/[id]/answer/route");
    const request = () => POST(new Request("http://localhost/api/interviews/1/answer", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ turn_id: 1, answer: "回答" }),
    }), { params: Promise.resolve({ id: "1" }) });
    model.chatStream.mockResolvedValueOnce(JSON.stringify({ ...validDecision, comment: "\u200b\u2060", next_kind: "question", next_question: "下一题" }));
    const rejected = await request();
    expect(await rejected.text()).toContain("不能仅含标点或不可见字符");
    expect(db.prepare("SELECT * FROM interview_turns WHERE id=1").get()).toEqual(before);
    model.chatStream.mockResolvedValueOnce(JSON.stringify({ ...validDecision, next_kind: "question", next_question: "下一题" }));
    expect(await (await request()).text()).toContain("event: done");
  });

  it.each(["？？？", "！ \n？", "【……】；", "\u200b", "\u0000", "\u0301\ufe0f", "（\u200b）？", "\u3164"])("拒绝无内容的下一题 %j，不保存作答且可重试", async (nextQuestion) => {
    model.chatStream.mockResolvedValueOnce(JSON.stringify({ ...validDecision, next_kind: "question", next_question: nextQuestion }));
    const { POST } = await import("@/app/api/interviews/[id]/answer/route");
    const submit = () => POST(new Request("http://localhost/api/interviews/1/answer", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ turn_id: 1, answer: "回答" }),
    }), { params: Promise.resolve({ id: "1" }) });
    const rejected = await submit();
    const events = await rejected.text();
    expect(events).toContain("AI 面试题不能只有标点");
    expect(events).toContain("event: error");
    expect(events).not.toContain("event: done");
    expect(db.prepare("SELECT answer FROM interview_turns WHERE id=1").get()).toEqual({ answer: "" });
    expect(db.prepare("SELECT COUNT(*) AS total FROM interview_turns").get()).toEqual({ total: 1 });

    model.chatStream.mockResolvedValueOnce(JSON.stringify({ ...validDecision, next_kind: "question", next_question: "解释 C++ 中引用与指针的区别？" }));
    const retried = await submit();
    expect(await retried.text()).toContain("event: done");
    expect(db.prepare("SELECT answer FROM interview_turns WHERE id=1").get()).toEqual({ answer: "回答" });
    expect(db.prepare("SELECT question FROM interview_turns WHERE idx=2").get()).toEqual({ question: "解释 C++ 中引用与指针的区别？" });
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
    ["点评超限", { ...valid, comment: "评".repeat(INTERVIEW_ANSWER_OUTPUT_LIMITS.comment + 1) }],
    ["参考答案超限", { ...valid, reference: "参".repeat(INTERVIEW_ANSWER_OUTPUT_LIMITS.reference + 1) }],
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

  it("重评接受零分，裁剪必填文本、保留历史空评分并独立保存重答参考", async () => {
    db.prepare("UPDATE interview_turns SET retries=? WHERE id=1").run(JSON.stringify([{ id: "legacy", scores: null }]));
    model.chat.mockResolvedValueOnce(JSON.stringify({ ...valid, comment: " 点评 ", reference: " 参考答案 " }));
    const response = await retry();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.retry).toMatchObject({ scores: { depth: 0, structure: 10, authenticity: 0, completeness: 10 }, comment: "点评", reference: "参考答案" });
    expect(body.retries).toHaveLength(2);
    expect(body.retries[0]).toEqual({ id: "legacy", answer: "", scores: null, comment: "", created_at: "" });
    expect(body.reference).toBe("");
    expect(db.prepare("SELECT answer, comment, scores, reference, retries FROM interview_turns WHERE id=1").get())
      .toEqual({ answer: "", comment: "", scores: "", reference: "", retries: JSON.stringify([{ id: "legacy", scores: null }, body.retry]) });
    expect(body.retries[1]).toEqual(body.retry);
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
