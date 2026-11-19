import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DRILL_EVALUATION_OUTPUT_LIMITS } from "@/lib/model-protocol";

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
async function grade(answer = "候选人回答") {
  const { POST } = await import("../route");
  return POST(new Request("http://127.0.0.1/api/drills/1/questions/1", {
    method: "POST", headers: { "content-type": "application/json", "x-request-id": "grade-test-id" },
    body: JSON.stringify({ answer }),
  }), { params: Promise.resolve({ id: "1", qid: "1" }) });
}
describe.each(["project", "bank", "interview"])("%s 评分的完整 JSON 协议", source => {
  it.each([
    ["围栏", (json: string) => ["```json", json, "```"].join("\n")],
    ["前置说明", (json: string) => `以下为初稿：\n${json}`],
    ["后置说明", (json: string) => `${json}\n上述评分仍需修订。`],
    ["追加截断内容", (json: string) => `${json}\n{"correction":`],
  ] as const)("%s 的模型回复不截取后覆盖评分、复习或收藏，纯 JSON 可显式重试", async (_label, wrap) => {
    if (source === "project") db.exec("INSERT INTO projects (id,name,created_at,updated_at) VALUES (1,'项目','','')");
    db.prepare("UPDATE drills SET source=?,project_id=? WHERE id=1").run(source, source === "project" ? 1 : null);
    db.exec("INSERT INTO notebook_entries (source,source_id,question,answer,created_at,updated_at) VALUES ('drill',1,'事件循环？','旧收藏','','')");
    const output = { ...scores, comment: "保留本次解释的范围", reference: "按题干要求解释，未知条件待确认" };
    model.chat.mockResolvedValue(JSON.stringify(output));
    expect((await grade()).status).toBe(200);
    model.chat.mockClear().mockResolvedValueOnce(wrap(JSON.stringify({ ...output, comment: "异常回复不可保存" })));
    const tables = ["drills", "drill_questions", "review_cards", "notebook_entries"];
    const before = tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
    expect((await grade("补充后的原答")).status).toBe(502);
    expect(tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all())).toEqual(before);
    expect(model.chat.mock.calls[0]![2]).toMatchObject({ requireJson: "strict" });
    model.chat.mockResolvedValueOnce(` \n${JSON.stringify(output)}\t `);
    expect((await grade("补充后的原答")).status).toBe(200);
    expect(model.chat).toHaveBeenCalledTimes(2);
    expect(db.prepare("SELECT answer,comment,reference FROM drill_questions WHERE id=1").get())
      .toEqual({ answer: "补充后的原答", comment: output.comment, reference: output.reference });
    expect(db.prepare("SELECT * FROM notebook_entries ORDER BY id").all()).toEqual(before[3]);
    expect(db.prepare("SELECT COUNT(*) n FROM review_cards").get()).toEqual({ n: before[2]!.length });
  });
});

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
it.each(["id", "overall", "debug", "null", "array"]) ("异常结构 %s 的评分结果不写入", async (shape) => {
  const before = db.prepare("SELECT * FROM drill_questions WHERE id = 1").get();
  const output = shape === "null" ? null : shape === "array" ? [scores] : { ...scores, comment: "点评", reference: "参考", [shape]: "unexpected" };
  model.chat.mockResolvedValue(JSON.stringify(output));
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
it("简单且充分的答案可使用短点评，不为句数扩写", async () => {
  model.chat.mockResolvedValue(JSON.stringify({ ...scores, comment: "答案简洁且已充分回应。", reference: "参考" }));
  expect((await grade()).status).toBe(200);
  const system = model.chat.mock.calls[0]![1][0].content as string;
  expect(system).toContain("简短且充分时可以少于示例句数");
  expect(system).toContain("简短且充分时可更短，不为句数重复评分理由");
});
it.each([
  ["comment", DRILL_EVALUATION_OUTPUT_LIMITS.comment],
  ["reference", DRILL_EVALUATION_OUTPUT_LIMITS.reference],
] as const)("评分 %s 接受上限长度并拒绝超限且保留旧值", async (field, limit) => {
  db.prepare("UPDATE drill_questions SET answer='旧回答', comment='旧点评', reference='旧参考', scores=?, answered_at='2026-01-01' WHERE id=1")
    .run(JSON.stringify(scores));
  const before = db.prepare("SELECT * FROM drill_questions WHERE id=1").get();
  const output = { ...scores, comment: "点".repeat(DRILL_EVALUATION_OUTPUT_LIMITS.comment), reference: "参".repeat(DRILL_EVALUATION_OUTPUT_LIMITS.reference) };
  model.chat.mockResolvedValueOnce(JSON.stringify(output));
  expect((await grade("新回答")).status).toBe(200);
  const atLimit = field === "comment" ? output.comment : output.reference;
  expect(db.prepare(`SELECT ${field} value FROM drill_questions WHERE id=1`).get()).toEqual({ value: atLimit });

  const afterValid = db.prepare("SELECT * FROM drill_questions WHERE id=1").get();
  const oversized = { ...output, [field]: "超".repeat(limit + 1) };
  model.chat.mockResolvedValueOnce(JSON.stringify(oversized));
  expect((await grade("再次回答")).status).toBe(502);
  expect(db.prepare("SELECT * FROM drill_questions WHERE id=1").get()).toEqual(afterValid);
  expect(before).not.toEqual(afterValid);
  const system = model.chat.mock.calls[1]![1][0].content as string;
  expect(system).toContain(`最多 ${DRILL_EVALUATION_OUTPUT_LIMITS.comment} 字符`);
  expect(system).toContain(`最多 ${DRILL_EVALUATION_OUTPUT_LIMITS.reference} 字符`);
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
