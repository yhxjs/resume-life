import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const model = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock("@/lib/llm", async (original) => ({
  ...await original<typeof import("@/lib/llm")>(), chat: model.chat,
}));
const PREFIX = "resume-life-drills-output-";
let directory: string;
let db: DatabaseSync;
beforeEach(async () => {
  vi.resetModules();
  model.chat.mockReset();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.prepare("INSERT INTO projects (id,name,created_at,updated_at) VALUES (1,'项目','','')").run();
  db.prepare("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'简历','','')").run();
  db.prepare("INSERT INTO interviews (id,resume_id,jd,report,created_at) VALUES (1,1,'工程师',?,'')").run(JSON.stringify({
    depth: 5, structure: 6, authenticity: 6, completeness: 5, jd_match: 6, overall: 6,
    strengths: "结构清楚", weaknesses: "深度不足", suggestions: "补充细节",
  }));
});
afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(PREFIX)) {
    throw new Error("Unsafe cleanup path");
  }
  fs.rmSync(resolved, { recursive: true, force: true });
});

async function post(source: string, questions: string[], count = 5) {
  model.chat.mockResolvedValueOnce(JSON.stringify({ questions: source === "project"
    ? questions : questions.map((question) => ({ question, kind: "tech" })) }));
  const { POST } = await import("@/app/api/drills/route");
  return POST(new Request("http://localhost/api/drills", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source, project_id: 1, interview_id: 1, direction: "前端", count }),
  }));
}

describe.each(["project", "bank", "interview"])("%s 练习模型输出数量契约", (source) => {
  it.each([6, 21])("请求 5 题却返回 %i 题时返回 502 且零写入", async (n) => {
    const response = await post(source, Array.from({ length: n }, (_, i) => `问题 ${i}`));
    expect(response.status).toBe(502);
    expect((await response.json()).error).toMatch(/题目.*数量/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM drills").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM drill_questions").get()).toEqual({ n: 0 });
  });
  it("有效题不足请求数时返回实际题量", async () => {
    const response = await post(source, ["题一", "题二"]);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ id: expect.any(Number), count: 2 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM drill_questions").get()).toEqual({ n: 2 });
  });
  it("去除重复与空白，响应数量等于持久化数量", async () => {
    const response = await post(source, ["题一", " 题一 ", "题二", " "]);
    expect(response.status).toBe(201);
    expect((await response.json()).count).toBe(2);
    expect(db.prepare("SELECT question FROM drill_questions ORDER BY idx").all()).toEqual([{ question: "题一" }, { question: "题二" }]);
  });
  it("空题目列表拒绝写入", async () => {
    expect((await post(source, [])).status).toBe(502);
    expect(db.prepare("SELECT COUNT(*) AS n FROM drills").get()).toEqual({ n: 0 });
  });
  it("全局最多 20 题，即使请求更大也不能超量", async () => {
    expect((await post(source, Array.from({ length: 21 }, (_, i) => `问题 ${i}`), 99)).status).toBe(502);
    expect(db.prepare("SELECT COUNT(*) AS n FROM drills").get()).toEqual({ n: 0 });
  });
});
