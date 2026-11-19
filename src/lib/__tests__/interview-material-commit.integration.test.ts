import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const model = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock("@/lib/llm", async original => ({ ...await original<typeof import("@/lib/llm")>(), ...model }));
const PREFIX = "resume-life-material-commit-";
const scores = { depth: 7, structure: 7, authenticity: 8, completeness: 7 };
const evaluator = {
  recommendation: "Hire", level: "待核实", level_justification: "只依据本次原答，经验范围待核实。",
  summary_for_hr: "说明了参数校验任务。", hire_reasons: ["个人职责清楚"], concerns_and_risks: ["验收结果待核实"],
  placement_suggestion: "进一步核对任务范围。", evidence_quotes: [],
};
const results = {
  retry: { ...scores, comment: "本次重答点评", reference: "本次重答参考" },
  reference: { reference: "新原题参考" },
  finish: { jd_match: 7, strengths: "分工清楚", weaknesses: "结果待核实", suggestions: "核对记录", evaluator_report: evaluator },
  evaluator: evaluator,
};
type Operation = keyof typeof results;
const key = "37cc674b-8736-481f-9055-883829b55e73";
let directory: string;
let db: DatabaseSync;
let version: number;
let otherVersion: number;

beforeEach(async () => {
  vi.resetModules(); model.chat.mockReset();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX)); vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'原材料','',''),(2,'另一简历','','')");
  db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,content,updated_at) VALUES (1,'summary','summary','简介',?,'')").run(JSON.stringify({ text: "原职业材料：只参与校验，尚未上线。" }));
  const { publishResumeVersion } = await import("../resume-versions");
  version = publishResumeVersion(1, { name: "固定版" }).id;
  otherVersion = publishResumeVersion(1, { name: "另一版" }).id;
  db.prepare("INSERT INTO interviews (id,resume_id,resume_version_id,jd,rounds,created_at) VALUES (1,1,?,'参数校验',3,''),(2,2,NULL,'另一岗位',1,'')").run(version);
  db.prepare(`INSERT INTO interview_turns (id,interview_id,idx,question,answer,comment,scores,reference,answered_at)
    VALUES (1,1,1,'你负责哪些工作？','原答：只参与参数校验。','旧点评',?,'旧原题参考','已答'),
      (2,1,2,'如何验证？','','','','',''),(3,2,1,'另一场题','另一场原答','','','','已答')`).run(JSON.stringify(scores));
  db.exec(`INSERT INTO notebook_entries (id,source,source_id,question,answer,comment,reference,created_at,updated_at)
    VALUES (1,'interview',1,'你负责哪些工作？','','','','',''),(2,'interview',3,'独立题','独立原答','独立点评','独立参考','','');
    INSERT INTO review_cards (id,notebook_id,next_review_date,created_at) VALUES (1,1,'2026-10-29',''),(2,2,'2026-10-29','');
    INSERT INTO review_attempts (card_id,request_id,answer,grade,reviewed_at,review_date,interval_days,next_review_date)
      VALUES (1,'83ac674b-8736-481f-9055-883829b55e73','独立复习原答','good','2026-10-28T00:00:00Z','2026-10-28',1,'2026-10-29');`);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  db?.close(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(PREFIX)) throw new Error("Unsafe cleanup path");
  fs.rmSync(resolved, { recursive: true, force: true });
});
function state() {
  return Object.fromEntries(["resumes", "resume_modules", "resume_versions", "interviews", "interview_turns", "notebook_entries", "review_cards", "review_attempts", "runtime_state"]
    .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
}
function change(mutate: (writer: DatabaseSync) => void) {
  const writer = new DatabaseSync(path.join(directory, "resume-life.db"));
  try { writer.exec("PRAGMA foreign_keys=ON"); mutate(writer); } finally { writer.close(); }
  return state();
}
type MaterialSnapshot = { title: string; modules: { key: string; type: string; label: string; sort: number; content: Record<string, unknown> }[] };
function rewrite(writer: DatabaseSync, id: number, mutate: (snapshot: MaterialSnapshot) => void) {
  const snapshot = JSON.parse(writer.prepare("SELECT snapshot FROM resume_versions WHERE id=?").get(id)!.snapshot as string);
  mutate(snapshot); writer.prepare("UPDATE resume_versions SET snapshot=? WHERE id=?").run(JSON.stringify(snapshot), id);
}
async function submit(operation: Operation, signal?: AbortSignal) {
  const route = operation === "retry" ? await import("@/app/api/interviews/[id]/turns/[tid]/retry/route")
    : operation === "reference" ? await import("@/app/api/interviews/[id]/turns/[tid]/reference/route")
      : operation === "finish" ? await import("@/app/api/interviews/[id]/finish/route")
        : await import("@/app/api/interviews/[id]/evaluator-report/route");
  const endpoint = operation === "evaluator" ? "evaluator-report" : operation;
  return route.POST(new Request(`http://localhost/api/interviews/1/${endpoint}`, {
    method: "POST", signal, headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    ...(operation === "retry" ? { body: JSON.stringify({ answer: "本次重答：仅参与测试，结果待确认。" }) } : {}),
  }), { params: Promise.resolve({ id: "1", tid: "1" }) });
}
async function pause(operation: Operation, signal?: AbortSignal) {
  const entered = Promise.withResolvers<void>(); const completion = Promise.withResolvers<string>();
  model.chat.mockResolvedValue(JSON.stringify(results[operation])).mockImplementationOnce(() => { entered.resolve(); return completion.promise; });
  const response = submit(operation, signal); await entered.promise;
  return { response, release: () => completion.resolve(JSON.stringify(results[operation])) };
}

describe.each<Operation>(["retry", "reference", "finish", "evaluator"])("%s 保存时复核实际职业材料", operation => {
  it.each([
    { label: "固定版职业内容", mutate: (writer: DatabaseSync) => rewrite(writer, version, s => { s.modules[0]!.content.text = "更正后材料：未交付。"; }) },
    { label: "所选版本归属", mutate: (writer: DatabaseSync) => writer.prepare("UPDATE resume_versions SET resume_id=2 WHERE id=?").run(version) },
    { label: "所选版本删除", mutate: (writer: DatabaseSync) => writer.prepare("DELETE FROM resume_versions WHERE id=?").run(version) },
    { label: "参考简历删除", mutate: (writer: DatabaseSync) => writer.exec("DELETE FROM resumes WHERE id=1") },
    { label: "所选版本 JSON 损坏", mutate: (writer: DatabaseSync) => writer.prepare("UPDATE resume_versions SET snapshot='{' WHERE id=?").run(version) },
    { label: "所选版本模块结构损坏", mutate: (writer: DatabaseSync) => writer.prepare("UPDATE resume_versions SET snapshot=? WHERE id=?").run(JSON.stringify({ modules: null }), version) },
  ])("模型等待时$label变化拒绝旧结果，保留并发变更及完整存档", async ({ label, mutate }) => {
    const pending = await pause(operation);
    try {
      const changed = change(mutate); pending.release(); const response = await pending.response;
      expect(response.status).toBe(label === "参考简历删除" && (operation === "retry" || operation === "reference") ? 404 : 409);
      expect(response.headers.get("Cache-Control")).toContain("no-store");
      expect((await response.json()).error).toMatch(/资料|材料|状态|不存在/); expect(state()).toEqual(changed);
      expect(model.chat).toHaveBeenCalledOnce();
    } finally { pending.release(); await pending.response; }
  });
  it("旧未绑定场次草稿变化拒绝旧结果，原编号显式重试按新材料保存", async () => {
    db.exec("UPDATE interviews SET resume_version_id=NULL WHERE id=1");
    const pending = await pause(operation);
    try {
      const changed = change(writer => writer.prepare("UPDATE resume_modules SET content=? WHERE resume_id=1").run(JSON.stringify({ text: "更正后材料：只参与测试，未交付。" })));
      pending.release(); expect((await pending.response).status).toBe(409); expect(state()).toEqual(changed);
      const response = await submit(operation); expect(response.status, await response.text()).toBe(200);
      expect(model.chat).toHaveBeenCalledTimes(2); expect(JSON.stringify(model.chat.mock.calls[1]![1])).toContain("更正后材料：只参与测试，未交付。");
      assertSaved(operation, changed);
      if (operation === "retry") { expect((await submit(operation)).status).toBe(200); expect(model.chat).toHaveBeenCalledTimes(2); }
    } finally { pending.release(); await pending.response; }
  });
  it.each(["草稿", "新发布版", "其他版本", "标题排版身份"])("固定版不受%s变化影响，正常保存且保留其他存档", async label => {
    const pending = await pause(operation);
    try {
      if (label === "新发布版") (await import("../resume-versions")).publishResumeVersion(1, { name: "后来发布" });
      else change(writer => {
        if (label === "草稿") writer.prepare("UPDATE resume_modules SET content=? WHERE resume_id=1").run(JSON.stringify({ text: "未选草稿" }));
        if (label === "其他版本") rewrite(writer, otherVersion, s => { s.modules[0]!.content.text = "其他版本的新材料"; });
        if (label === "标题排版身份") {
          writer.exec("UPDATE resumes SET title='新标题',template='modern' WHERE id=1");
          rewrite(writer, version, s => { s.title = "新快照标题"; s.modules.push({ key: "basic", type: "basic", label: "身份", sort: 0, content: { name: "不传模型" } }); });
        }
      });
      const changed = state(); pending.release(); const response = await pending.response;
      expect(response.status, await response.text()).toBe(200); assertSaved(operation, changed);
    } finally { pending.release(); await pending.response; }
  });
  it("起始已缺失材料时沿用占位，不改用草稿", async () => {
    db.prepare("UPDATE resume_versions SET resume_id=2 WHERE id=?").run(version);
    model.chat.mockResolvedValue(JSON.stringify(results[operation]));
    const before = state(); const response = await submit(operation); expect(response.status, await response.text()).toBe(200);
    expect(JSON.stringify(model.chat.mock.calls[0]![1])).toContain(operation === "retry" || operation === "reference" ? "（简历未提供或已删除）" : "（简历已删除）");
    expect(JSON.stringify(model.chat.mock.calls[0]![1])).not.toContain("原职业材料"); assertSaved(operation, before);
  });
});
it("已保存重答按原编号回读，不因后来材料损坏再评分或改写历史", async () => {
  model.chat.mockResolvedValue(JSON.stringify(results.retry));
  const first = await submit("retry"); expect(first.status).toBe(200); const saved = await first.json();
  const changed = change(writer => writer.prepare("UPDATE resume_versions SET snapshot='{' WHERE id=?").run(version));
  const replay = await submit("retry"); expect(replay.status).toBe(200); expect(await replay.json()).toEqual(saved);
  expect(model.chat).toHaveBeenCalledOnce(); expect(state()).toEqual(changed);
});
function assertSaved(operation: Operation, before: ReturnType<typeof state>) {
  const after = state();
  for (const table of ["resumes", "resume_modules", "resume_versions", "review_cards", "review_attempts", "runtime_state"]) expect(after[table]).toEqual(before[table]);
  const originalTurns = before.interview_turns as { id: number }[];
  const originalInterviews = before.interviews as { id: number }[];
  expect(db.prepare("SELECT * FROM interview_turns WHERE id!=1 ORDER BY id").all()).toEqual(originalTurns.filter(row => row.id !== 1));
  expect(db.prepare("SELECT * FROM interviews WHERE id=2").all()).toEqual(originalInterviews.filter(row => row.id === 2));
  const savedTurn = db.prepare("SELECT * FROM interview_turns WHERE id=1").get()!;
  expect(savedTurn).toEqual({ ...originalTurns.find(row => row.id === 1),
    ...(operation === "retry" ? { retries: savedTurn.retries } : {}),
    ...(operation === "reference" ? { reference: results.reference.reference } : {}),
  });
  if (operation === "retry" || operation === "reference") expect(after.interviews).toEqual(before.interviews);
  if (operation === "reference") {
    expect(db.prepare("SELECT reference FROM interview_turns WHERE id=1").get()).toEqual({ reference: results.reference.reference });
    expect(db.prepare("SELECT answer,reference FROM notebook_entries WHERE id=1").get()).toEqual({ answer: "原答：只参与参数校验。", reference: results.reference.reference });
  } else expect(after.notebook_entries).toEqual(before.notebook_entries);
  if (operation === "retry") {
    const turn = db.prepare("SELECT retries,reference,answer FROM interview_turns WHERE id=1").get()!;
    expect(turn).toMatchObject({ answer: "原答：只参与参数校验。", reference: "旧原题参考" });
    expect(JSON.parse(turn.retries as string)).toEqual([expect.objectContaining({ id: `retry_${key}`, answer: "本次重答：仅参与测试，结果待确认。", scores, comment: results.retry.comment, reference: results.retry.reference })]);
  }
  if (operation === "finish") expect(db.prepare("SELECT status,report,evaluator_report FROM interviews WHERE id=1").get()).toMatchObject({ status: "finished", report: expect.stringContaining("分工清楚"), evaluator_report: expect.stringContaining("个人职责清楚") });
  if (operation === "evaluator") expect(db.prepare("SELECT report,evaluator_report FROM interviews WHERE id=1").get()).toMatchObject({ report: "", evaluator_report: expect.stringContaining("个人职责清楚") });
}
