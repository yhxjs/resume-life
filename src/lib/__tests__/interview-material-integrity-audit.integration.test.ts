import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const model = vi.hoisted(() => ({ chat: vi.fn(), chatStream: vi.fn() }));
vi.mock("@/lib/llm", async original => ({ ...await original<typeof import("@/lib/llm")>(), ...model }));
const PREFIX = "resume-life-interview-material-integrity-";
const firstQuestion = "请说明一次实际参与的接口验证过程。";
const nextQuestion = "接口字段不兼容时你会如何定位？";
const answerReply = JSON.stringify({ depth: 7, structure: 7, authenticity: 8, completeness: 7,
  comment: "保留个人职责与未上线限定。", next_kind: "question", next_question: nextQuestion });
const questionReply = JSON.stringify({ question: firstQuestion });
type Operation = "create" | "answer" | "advance";
let directory: string;
let db: DatabaseSync;
let versionId: number;

beforeEach(async () => {
  vi.resetModules(); model.chat.mockReset(); model.chatStream.mockReset();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'材料完整性审查','','')");
  db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,content,updated_at) VALUES (1,'summary','summary','简介',?,'')")
    .run(JSON.stringify({ text: "原职业材料：仅参与校验，尚未上线。" }));
  versionId = (await import("../resume-versions")).publishResumeVersion(1, { name: "固定版" }).id;
  db.prepare("INSERT INTO interview_series (id,resume_id,resume_version_id,jd,rounds,created_at) VALUES (1,1,?,'接口校验岗位',3,'')").run(versionId);
  db.prepare(`INSERT INTO interviews (id,resume_id,resume_version_id,jd,rounds,style,series_id,round_no,status,report,created_at)
    VALUES (1,1,?,'接口校验岗位',3,'deep',1,1,'finished',?,'')`).run(versionId, JSON.stringify({
    depth: 5, structure: 6, authenticity: 6, completeness: 5, jd_match: 6,
    strengths: "职责明确", weaknesses: "结果待验证", suggestions: "核对验收记录",
  }));
  db.prepare("INSERT INTO interviews (id,resume_id,resume_version_id,jd,rounds,created_at) VALUES (2,1,?,'接口校验岗位',3,'')").run(versionId);
  db.exec(`INSERT INTO interview_turns (id,interview_id,idx,question,answer,comment,answered_at)
    VALUES (1,1,1,'你实际负责哪些工作？','仅参与校验','原点评','已答'),(2,2,1,'你如何验证参数？','','','')`);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  db?.close(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(PREFIX)) throw new Error("Unsafe cleanup path");
  fs.rmSync(resolved, { recursive: true, force: true });
});

function state() {
  return Object.fromEntries(["resumes", "resume_modules", "resume_versions", "interviews", "interview_series", "interview_turns", "notebook_entries", "runtime_state"]
    .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
}

function writerChange(mutate: (writer: DatabaseSync) => void) {
  const writer = new DatabaseSync(path.join(directory, "resume-life.db"));
  try { writer.exec("PRAGMA foreign_keys=ON"); mutate(writer); } finally { writer.close(); }
  return state();
}

function legacySources() {
  db.exec("UPDATE interviews SET resume_version_id=NULL; UPDATE interview_series SET resume_version_id=NULL");
}

function prepareModel(operation: Operation, mutate?: (writer: DatabaseSync) => void) {
  const reply = operation === "answer" ? answerReply : questionReply;
  const mock = operation === "advance" ? model.chat : model.chatStream;
  mock.mockResolvedValue(reply);
  let changed: ReturnType<typeof state> | undefined;
  if (mutate) mock.mockImplementationOnce(async () => { changed = writerChange(mutate); return reply; });
  return { mock, changed: () => changed };
}

const request = (body: unknown) => new Request("http://localhost/api/test", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

async function submit(operation: Operation) {
  if (operation === "create") return (await import("@/app/api/interviews/route")).POST(request({ resume_id: 1, resume_version_id: versionId, jd: "接口校验岗位", rounds: 3 }));
  if (operation === "answer") return (await import("@/app/api/interviews/[id]/answer/route")).POST(request({ turn_id: 2, answer: "我仅参与校验，尚未上线。" }), { params: Promise.resolve({ id: "2" }) });
  return (await import("@/app/api/interviews/series/[id]/advance/route")).POST(request({ from_interview_id: 1 }), { params: Promise.resolve({ id: "1" }) });
}

async function expectSuccess(operation: Operation) {
  const response = await submit(operation);
  const text = await response.text();
  expect(response.status, text).toBe(operation === "advance" ? 201 : 200);
  if (operation !== "advance") { expect(text).toContain("event: done"); expect(text).not.toContain("event: error"); }
}

describe.each<Operation>(["answer", "advance"])("%s 旧未绑定版材料完整性", operation => {
  it.each([false, true])("职业模块损坏且其他材料存在 %s 时阻止空回退，修复可重试", async hasOtherMaterial => {
    legacySources();
    db.exec("UPDATE resume_modules SET content='{broken-source'");
    if (hasOtherMaterial) db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,content,updated_at) VALUES (1,'skills','skills','技能',?,'')")
      .run(JSON.stringify({ items: ["了解 TypeScript，尚未独立使用。"] }));
    const before = state(); const { mock } = prepareModel(operation);
    const response = await submit(operation); const text = await response.text();
    expect(state()).toEqual(before);
    expect(response.status, text).toBe(422);
    expect(text).toContain("材料损坏"); expect(mock).not.toHaveBeenCalled();
    db.prepare("UPDATE resume_modules SET content=? WHERE module_key='summary'").run(JSON.stringify({ text: "修复后仅参与测试，尚未上线。" }));
    await expectSuccess(operation);
    expect(mock).toHaveBeenCalledOnce(); expect(JSON.stringify(mock.mock.calls[0]![1])).toContain("修复后仅参与测试，尚未上线。");
  });

  it("等待期空职业模块损坏，即使文本投影相同也不提交", async () => {
    legacySources();
    db.prepare("UPDATE resume_modules SET content=?").run(JSON.stringify({ text: "" }));
    const paused = prepareModel(operation, writer => writer.exec("UPDATE resume_modules SET content='{broken-empty-source'"));
    const response = await submit(operation); const text = await response.text();
    expect(state()).toEqual(paused.changed());
    if (operation === "advance") expect(response.status, text).toBe(409);
    else { expect(text).toContain("event: error"); expect(text).not.toMatch(/event: (done|delta)/); }
    expect(paused.mock).toHaveBeenCalledOnce();
  });

  it("不参与模型的基本身份与排版损坏不阻止职业材料使用", async () => {
    legacySources();
    db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,content,updated_at) VALUES (1,'basic','basic','基本信息',?,'')").run("{broken-identity");
    db.exec("UPDATE resumes SET style_overrides='{broken-style'");
    const { mock } = prepareModel(operation);
    await expectSuccess(operation);
    const input = JSON.stringify(mock.mock.calls[0]![1]);
    expect(input).toContain("原职业材料"); expect(input).not.toMatch(/broken-identity|broken-style/);
  });
});

describe.each<Operation>(["create", "answer", "advance"])("%s 发布材料读取", operation => {
  it.each(["{broken-snapshot", "null"])("起始快照无法读取时明确拒绝并零调用：%s", async snapshot => {
    db.prepare("UPDATE resume_versions SET snapshot=? WHERE id=?").run(snapshot, versionId);
    const before = state(); const { mock } = prepareModel(operation);
    const response = await submit(operation); const text = await response.text();
    expect(response.status, text).toBe(422);
    expect(text).toContain("材料损坏"); expect(mock).not.toHaveBeenCalled(); expect(state()).toEqual(before);
  });

  it.each(["{broken-snapshot", "null"])("等待期快照无法读取时按材料冲突拒绝旧结果：%s", async snapshot => {
    const paused = prepareModel(operation, writer => writer.prepare("UPDATE resume_versions SET snapshot=? WHERE id=?").run(snapshot, versionId));
    const response = await submit(operation); const text = await response.text();
    if (operation === "advance") expect(response.status, text).toBe(409);
    else { expect(text).toContain("event: error"); expect(text).not.toMatch(/event: (done|delta)/); }
    expect(text).toMatch(/材料|资料|版本/); expect(text).not.toContain("服务端处理失败");
    expect(state()).toEqual(paused.changed()); expect(paused.mock).toHaveBeenCalledOnce();
  });

  it("有效发布版不受当前草稿职业模块损坏影响", async () => {
    db.exec("UPDATE resume_modules SET content='{broken-draft'");
    const { mock } = prepareModel(operation);
    await expectSuccess(operation);
    const input = JSON.stringify(mock.mock.calls[0]![1]);
    expect(input).toContain("原职业材料"); expect(input).not.toContain("broken-draft");
    expect(db.prepare("SELECT content FROM resume_modules WHERE resume_id=1").get()!.content).toBe("{broken-draft");
  });
});

it("已创建下一轮后重放推进请求，不因后来的材料损坏再次生成", async () => {
  legacySources();
  const { mock } = prepareModel("advance");
  const original = await submit("advance");
  expect(original.status).toBe(201);
  const result = await original.json();
  mock.mockClear();
  db.exec("UPDATE resume_modules SET content='{broken-after-advance'");
  const before = state();
  const response = await submit("advance");
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual(result);
  expect(mock).not.toHaveBeenCalled();
  expect(state()).toEqual(before);
});
