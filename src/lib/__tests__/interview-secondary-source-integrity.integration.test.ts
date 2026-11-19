import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const model = vi.hoisted(() => ({ safeChat: vi.fn() }));
vi.mock("@/lib/safe-llm", async original => ({ ...await original<typeof import("@/lib/safe-llm")>(), ...model }));
const prefix = "resume-life-interview-secondary-integrity-";
const scores = { depth: 7, structure: 7, authenticity: 8, completeness: 7 };
const evaluator = {
  recommendation: "Hire", level: "待核实", level_justification: "只依据本次原答，经验范围待核实。",
  summary_for_hr: "说明了参数校验任务。", hire_reasons: ["个人职责清楚"], concerns_and_risks: ["验收结果待核实"],
  placement_suggestion: "进一步核对任务范围。", evidence_quotes: [],
};
const replies = {
  retry: { ...scores, comment: "本次重答点评", reference: "仅用于练习的参考" },
  reference: { reference: "基于已知职责的练习参考" },
  reverse: { answer: "岗位安排尚未提供，需要核实。", evaluation: { score: 7, insight: "问题聚焦验证职责", feedback: "关注分工边界", suggestions: "可继续核实验收范围" } },
  finish: { jd_match: 7, strengths: "分工清楚", weaknesses: "结果待核实", suggestions: "核对记录", evaluator_report: evaluator },
  evaluator,
};
type Operation = keyof typeof replies;
let directory: string;
let db: DatabaseSync;
let versionId: number;

beforeEach(async () => {
  vi.resetModules(); model.safeChat.mockReset();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'职业来源','',''),(2,'其他简历','','')");
  db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,content,updated_at) VALUES (1,'summary','summary','简介',?,'')")
    .run(JSON.stringify({ text: "原职业材料：只参与接口校验，尚未上线。" }));
  versionId = (await import("../resume-versions")).publishResumeVersion(1, { name: "有效发布版" }).id;
  db.exec("INSERT INTO interviews (id,resume_id,resume_version_id,jd,rounds,created_at) VALUES (1,1,NULL,'接口验证',3,'')");
  db.prepare("INSERT INTO interview_turns (id,interview_id,idx,kind,question,answer,comment,scores,reference,answered_at) VALUES (1,1,1,'question','你参与哪些工作？','只参与接口校验。','原点评',?,'原参考','已答')")
    .run(JSON.stringify(scores));
  db.exec("INSERT INTO notebook_entries (id,source,source_id,question,answer,comment,reference,created_at,updated_at) VALUES (1,'interview',1,'你参与哪些工作？','只参与接口校验。','原点评','原参考','','')");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  db?.close(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(prefix)) throw new Error("Unsafe cleanup path");
  fs.rmSync(resolved, { recursive: true, force: true });
});

function state() {
  return Object.fromEntries(["resumes", "resume_modules", "resume_versions", "interviews", "interview_turns", "notebook_entries"]
    .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
}

function corruptDuringReply(operation: Operation, mutate: (writer: DatabaseSync) => void) {
  let changed: ReturnType<typeof state>;
  model.safeChat.mockImplementationOnce(async () => {
    const writer = new DatabaseSync(path.join(directory, "resume-life.db"));
    try { writer.exec("PRAGMA foreign_keys=ON"); mutate(writer); } finally { writer.close(); }
    changed = state();
    return JSON.stringify(replies[operation]);
  });
  return () => changed;
}

async function submit(operation: Operation) {
  const route = operation === "retry" ? await import("@/app/api/interviews/[id]/turns/[tid]/retry/route")
    : operation === "reference" ? await import("@/app/api/interviews/[id]/turns/[tid]/reference/route")
      : operation === "reverse" ? await import("@/app/api/interviews/[id]/reverse/route")
        : operation === "finish" ? await import("@/app/api/interviews/[id]/finish/route")
          : await import("@/app/api/interviews/[id]/evaluator-report/route");
  return route.POST(new Request(`http://localhost/api/interviews/1/${operation}`, {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "12345678-1234-4234-8234-123456789abc" },
    ...(operation === "retry" ? { body: JSON.stringify({ answer: "本次仅参与接口测试，结果未统计。" }) }
      : operation === "reverse" ? { body: JSON.stringify({ question: "岗位如何划分验证和验收职责？" }) } : {}),
  }), { params: Promise.resolve({ id: "1", tid: "1" }) });
}

describe.each<Operation>(["retry", "reference", "reverse", "finish", "evaluator"])("%s 的简历材料完整性", operation => {
  it.each([false, true])("旧无发布版的职业模块损坏时不以空回退生成，其他材料存在 %s", async hasOtherMaterial => {
    db.prepare("UPDATE resume_modules SET content=? WHERE resume_id=1 AND module_key='summary'").run("{broken-career");
    if (hasOtherMaterial) db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,content,updated_at) VALUES (1,'skills','skills','技能',?,'')")
      .run(JSON.stringify({ items: ["仅了解 TypeScript，未独立交付"] }));
    const before = state(); model.safeChat.mockResolvedValue(JSON.stringify(replies[operation]));
    const response = await submit(operation);
    expect(response.status).toBe(422);
    expect(await response.text()).toMatch(/材料.*损坏|职业.*损坏/);
    expect(model.safeChat).not.toHaveBeenCalled();
    expect(state()).toEqual(before);
    db.prepare("UPDATE resume_modules SET content=? WHERE resume_id=1 AND module_key='summary'").run(JSON.stringify({ text: "修复后只参与验证，尚未上线。" }));
    expect((await submit(operation)).status).toBe(200);
    expect(model.safeChat).toHaveBeenCalledOnce();
  });

  it("生成期间空职业模块损坏，即使正文投影相等也拒绝提交", async () => {
    db.prepare("UPDATE resume_modules SET content=? WHERE resume_id=1").run(JSON.stringify({ text: "" }));
    const changed = corruptDuringReply(operation, writer => writer.prepare("UPDATE resume_modules SET content=? WHERE resume_id=1").run("{broken-career"));
    const response = await submit(operation);
    expect(response.status).toBe(409);
    expect(state()).toEqual(changed());
    expect(model.safeChat).toHaveBeenCalledOnce();
  });

  it.each(["{broken-snapshot", "null", '{"modules":null}'])("发布材料无法读取时明确拒绝：%s", async snapshot => {
    db.prepare("UPDATE interviews SET resume_version_id=? WHERE id=1").run(versionId);
    db.prepare("UPDATE resume_versions SET snapshot=? WHERE id=?").run(snapshot, versionId);
    const before = state(); model.safeChat.mockResolvedValue(JSON.stringify(replies[operation]));
    expect((await submit(operation)).status).toBe(422);
    expect(model.safeChat).not.toHaveBeenCalled(); expect(state()).toEqual(before);
  });

  it.each(["{broken-snapshot", "null"])("生成期间发布材料损坏不覆盖已有存档：%s", async snapshot => {
    db.prepare("UPDATE interviews SET resume_version_id=? WHERE id=1").run(versionId);
    const changed = corruptDuringReply(operation, writer => writer.prepare("UPDATE resume_versions SET snapshot=? WHERE id=?").run(snapshot, versionId));
    expect((await submit(operation)).status).toBe(409);
    expect(state()).toEqual(changed());
  });

  it("有效发布版不受草稿职业模块损坏影响", async () => {
    db.prepare("UPDATE interviews SET resume_version_id=? WHERE id=1").run(versionId);
    db.prepare("UPDATE resume_modules SET content=? WHERE resume_id=1").run("{broken-draft");
    model.safeChat.mockResolvedValue(JSON.stringify(replies[operation]));
    expect((await submit(operation)).status).toBe(200);
    const messages = JSON.stringify(model.safeChat.mock.calls[0]![3]);
    expect(messages).toContain("原职业材料：只参与接口校验，尚未上线。");
    expect(messages).not.toContain("broken-draft");
    expect(db.prepare("SELECT content FROM resume_modules WHERE resume_id=1").get()!.content).toBe("{broken-draft");
  });

  it("基本身份及排版损坏不影响旧记录实际使用的职业材料", async () => {
    db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,content,updated_at) VALUES (1,'basic','basic','身份',?,'')").run("{broken-identity");
    db.exec("UPDATE resumes SET style_overrides='{broken-style' WHERE id=1");
    model.safeChat.mockResolvedValue(JSON.stringify(replies[operation]));
    expect((await submit(operation)).status).toBe(200);
    const messages = JSON.stringify(model.safeChat.mock.calls[0]![3]);
    expect(messages).toContain("原职业材料：只参与接口校验，尚未上线。");
    expect(messages).not.toContain("broken-identity");
  });

  it("原已缺失的所选版本仍沿用明确缺失说明，不改用草稿", async () => {
    db.prepare("UPDATE interviews SET resume_version_id=? WHERE id=1").run(versionId);
    db.prepare("UPDATE resume_versions SET resume_id=2 WHERE id=?").run(versionId);
    model.safeChat.mockResolvedValue(JSON.stringify(replies[operation]));
    expect((await submit(operation)).status).toBe(200);
    const messages = JSON.stringify(model.safeChat.mock.calls[0]![3]);
    expect(messages).toContain(operation === "retry" || operation === "reference" ? "（简历未提供或已删除）" : "（简历已删除）");
    expect(messages).not.toContain("原职业材料");
  });
});

it.each(["retry", "evaluator"] as const)("%s 已完成结果的幂等回读不依赖后来损坏的材料", async operation => {
  model.safeChat.mockResolvedValue(JSON.stringify(replies[operation]));
  const original = await submit(operation);
  expect(original.status).toBe(200);
  const result = await original.json();
  model.safeChat.mockClear();
  db.prepare("UPDATE resume_modules SET content=? WHERE resume_id=1").run("{broken-after-save");
  const before = state();
  const response = await submit(operation);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(result);
  expect(model.safeChat).not.toHaveBeenCalled();
  expect(state()).toEqual(before);
});
