import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const model = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock("@/lib/llm", async (original) => ({ ...await original<typeof import("@/lib/llm")>(), chat: model.chat }));
let directory: string;
let db: DatabaseSync;
beforeEach(async () => {
  vi.resetModules();
  model.chat.mockReset();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-grade-contract-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("@/lib/db")).getDb();
  db.exec("INSERT INTO drills (id, source, direction, created_at) VALUES (1,'bank','前端',''); INSERT INTO drill_questions (id, drill_id, idx, question) VALUES (1,1,0,'事件循环？')");
});
afterEach(() => {
  db?.close(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-grade-contract-")) throw new Error("Unsafe cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
});
const scores = { depth: 5, structure: 5, authenticity: 5, completeness: 5 };
async function grade() {
  const { POST } = await import("../route");
  return POST(new Request("http://127.0.0.1/api/drills/1/questions/1", {
    method: "POST", headers: { "content-type": "application/json", "x-request-id": "grade-test-id" },
    body: JSON.stringify({ answer: "候选人回答" }),
  }), { params: Promise.resolve({ id: "1", qid: "1" }) });
}
it.each([
  {}, { comment: "点评" }, { reference: "参考" },
  { comment: " ", reference: "参考" }, { comment: "点评", reference: "\n" },
  { comment: 1, reference: "参考" }, { comment: "点评", reference: [] },
])("不完整新输出 %j 不修改答题或复习状态", async (narrative) => {
  const before = db.prepare("SELECT * FROM drill_questions WHERE id = 1").get();
  model.chat.mockResolvedValue(JSON.stringify({ ...scores, ...narrative }));
  const response = await grade();
  expect(response.status).toBe(502);
  expect(db.prepare("SELECT * FROM drill_questions WHERE id = 1").get()).toEqual(before);
  expect(db.prepare("SELECT COUNT(*) AS n FROM review_cards").get()).toEqual({ n: 0 });
});
it("完整评分继续提交，模型调用贯通请求 ID", async () => {
  model.chat.mockResolvedValue(JSON.stringify({ ...scores, comment: "点评", reference: "参考" }));
  const response = await grade();
  expect(response.status).toBe(200);
  expect(model.chat.mock.calls[0]![2]).toMatchObject({ requestId: "grade-test-id" });
  expect(db.prepare("SELECT comment, reference FROM drill_questions WHERE id = 1").get()).toEqual({ comment: "点评", reference: "参考" });
});
it("上游失败响应与脱敏日志使用同一请求 ID", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  model.chat.mockRejectedValue(new Error("synthetic-private-body"));
  const response = await grade();
  expect(response.status).toBe(502);
  expect(response.headers.get("x-request-id")).toBe("grade-test-id");
  expect(warning.mock.calls.flat().join(" ")).toContain("grade-test-id");
  expect(warning.mock.calls.flat().join(" ")).not.toContain("synthetic-private-body");
});
