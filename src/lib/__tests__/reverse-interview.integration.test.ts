import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const model = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock("@/lib/llm", async (original) => ({ ...await original<typeof import("@/lib/llm")>(), ...model }));

const validResponse = {
  answer: "面试官作答",
  evaluation: {
    score: 8, level: "优秀", insight: "体现技术视角", feedback: "问题具体", suggestions: "补充业务背景",
  },
};
const context = { params: Promise.resolve({ id: "1" }) };
let directory: string;
let db: DatabaseSync;

beforeEach(async () => {
  vi.resetModules();
  model.chat.mockReset().mockResolvedValue(JSON.stringify(validResponse));
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-reverse-interview-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", path.join(directory, "data"));
  db = (await import("@/lib/db")).getDb();
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'测试简历','',''); INSERT INTO interviews (id,resume_id,jd,created_at) VALUES (1,1,'JD','')");
});

afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-reverse-interview-")) throw new Error("Unsafe cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
});

async function post(signal?: AbortSignal) {
  const { POST } = await import("@/app/api/interviews/[id]/reverse/route");
  return POST(new Request("http://localhost/api/interviews/1/reverse", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question: "岗位核心挑战？" }), signal,
  }), context);
}

function storedReverse() {
  return (db.prepare("SELECT reverse_interview FROM interviews WHERE id=1").get() as { reverse_interview: string }).reverse_interview;
}

async function pause(signal?: AbortSignal) {
  const entered = Promise.withResolvers<void>();
  const result = Promise.withResolvers<string>();
  model.chat.mockImplementationOnce(() => { entered.resolve(); return result.promise; });
  const pending = post(signal);
  await entered.promise;
  return { pending, release: () => result.resolve(JSON.stringify(validResponse)) };
}

describe("反问生成提交边界", () => {
  it("模型等待期间生成报告后返回冲突并保持反问为空", async () => {
    const paused = await pause();
    db.prepare("UPDATE interviews SET report=? WHERE id=1").run('{"overall":8}');
    paused.release();
    expect((await paused.pending).status).toBe(409);
    expect(storedReverse()).toBe("");
    expect(db.prepare("SELECT report FROM interviews WHERE id=1").get()).toEqual({ report: '{"overall":8}' });
  });

  it("模型等待期间已有反问时不覆盖先保存的结果", async () => {
    const paused = await pause();
    db.prepare("UPDATE interviews SET reverse_interview=? WHERE id=1").run('{"answer":"先保存的反问"}');
    paused.release();
    expect((await paused.pending).status).toBe(409);
    expect(storedReverse()).toBe('{"answer":"先保存的反问"}');
  });

  it("模型等待期间状态变更后返回冲突", async () => {
    const paused = await pause();
    db.prepare("UPDATE interviews SET status='finished' WHERE id=1").run();
    paused.release();
    expect((await paused.pending).status).toBe(409);
    expect(storedReverse()).toBe("");
  });

  it("模型等待期间删除面试后返回冲突", async () => {
    const paused = await pause();
    db.prepare("DELETE FROM interviews WHERE id=1").run();
    paused.release();
    expect((await paused.pending).status).toBe(409);
  });

  it("并发反问与报告命令在模型前被拒绝，完成后释放命令锁", async () => {
    const paused = await pause();
    const duplicate = await post();
    const { POST: finish } = await import("@/app/api/interviews/[id]/finish/route");
    const report = await finish(new Request("http://localhost/api/interviews/1/finish", { method: "POST" }), context);
    paused.release();
    const response = await paused.pending;
    expect(duplicate.status).toBe(409);
    expect(report.status).toBe(409);
    expect(model.chat).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect((await post()).status).toBe(400);
  });

  it("调用前取消请求不调用模型也不写入", async () => {
    const controller = new AbortController();
    controller.abort();
    expect((await post(controller.signal)).status).toBe(499);
    expect(model.chat).not.toHaveBeenCalled();
    expect(storedReverse()).toBe("");
  });

  it("模型等待期间取消请求，即使模型返回成功也不写入", async () => {
    const controller = new AbortController();
    const paused = await pause(controller.signal);
    controller.abort();
    paused.release();
    expect((await paused.pending).status).toBe(499);
    expect(storedReverse()).toBe("");
    expect((await post()).status).toBe(200);
  });
});

describe("反问模型响应协议", () => {
  it.each([
    ["缺少评价", { answer: "模型回答" }],
    ["评价为 null", { ...validResponse, evaluation: null }],
    ["评价为数组", { ...validResponse, evaluation: [] }],
    ["缺少评分", { ...validResponse, evaluation: { ...validResponse.evaluation, score: undefined } }],
    ["字符串评分", { ...validResponse, evaluation: { ...validResponse.evaluation, score: "8" } }],
    ["小数评分", { ...validResponse, evaluation: { ...validResponse.evaluation, score: 7.5 } }],
    ["零分", { ...validResponse, evaluation: { ...validResponse.evaluation, score: 0 } }],
    ["超范围评分", { ...validResponse, evaluation: { ...validResponse.evaluation, score: 11 } }],
    ["非法评级", { ...validResponse, evaluation: { ...validResponse.evaluation, level: "超级优秀" } }],
    ["空 insight", { ...validResponse, evaluation: { ...validResponse.evaluation, insight: " \n " } }],
    ["空 feedback", { ...validResponse, evaluation: { ...validResponse.evaluation, feedback: "" } }],
    ["非文本 suggestions", { ...validResponse, evaluation: { ...validResponse.evaluation, suggestions: 42 } }],
    ["空回答", { ...validResponse, answer: " \t " }],
  ])("拒绝%s并保持数据库为空", async (_label, value) => {
    model.chat.mockResolvedValueOnce(JSON.stringify(value));
    expect((await post()).status).toBe(502);
    expect(storedReverse()).toBe("");
  });

  it.each([
    ["根数组", JSON.stringify([validResponse])],
    ["根 null", "null"],
    ["无限评分", JSON.stringify(validResponse).replace('"score":8', '"score":1e309')],
    ["非法 JSON", "not JSON"],
    ["JSON 后追加文本", `${JSON.stringify(validResponse)} trailing`],
  ])("拒绝%s并保持数据库为空", async (_label, raw) => {
    model.chat.mockResolvedValueOnce(raw);
    expect((await post()).status).toBe(502);
    expect(storedReverse()).toBe("");
  });

  it.each([1, 10])("接受边界评分 %s 并裁剪必填文本", async (score) => {
    model.chat.mockResolvedValueOnce(JSON.stringify({
      answer: " 面试官作答 ",
      evaluation: { score, level: "优秀", insight: " 体现技术视角 ", feedback: " 问题具体 ", suggestions: " 补充业务背景 " },
    }));
    const response = await post();
    expect(response.status).toBe(200);
    const stored = JSON.parse(storedReverse());
    expect(stored).toMatchObject({ question: "岗位核心挑战？", ...validResponse, evaluation: { ...validResponse.evaluation, score } });
    expect(stored.created_at).toEqual(expect.any(String));
  });
});
