import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { normalizeContent } from "../modules";
import { remainingPlanMinutes, readPreparationPlan } from "../preparation-plan-types";

let directory: string;
let db: DatabaseSync;
let plans: typeof import("../preparation-plan");
let appId: number;
let versionId: number;

beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-plan-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'测试简历','','')");
  db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,content,updated_at) VALUES (1,'summary','summary','简介',?,'')")
    .run(JSON.stringify(normalizeContent("summary", { text: "前端开发经验" })));
  versionId = (await import("../resume-versions")).publishResumeVersion(1, { name: "岗位发布版" }).id;
  appId = (await import("../applications")).createApplication({ company: "甲公司", role: "前端工程师", jd: "熟悉 React 和 TypeScript", resume_id: 1, resume_version_id: versionId }).id;
  plans = await import("../preparation-plan");
});

afterEach(() => {
  vi.restoreAllMocks(); db?.close(); vi.unstubAllEnvs();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-plan-")) throw new Error("Unsafe cleanup path");
  fs.rmSync(directory, { recursive: true, force: true });
});

function generate(id = appId) { return plans.generatePreparationPlan(id, plans.getPreparationPlan(id).contextKey); }

it("缺资料也能生成有依赖、耗时与执行入口的清单，GET 不写入", async () => {
  const id = (await import("../applications")).createApplication({ company: "乙公司", role: "产品经理" }).id;
  expect(plans.getPreparationPlan(id)).toMatchObject({ generatedAt: null, steps: [] });
  expect(db.prepare("SELECT * FROM application_preparation_plans").all()).toHaveLength(0);
  const plan = generate(id);
  expect(plan.steps.filter(step => step.category === "material" && !step.done)).toHaveLength(5);
  expect(plan.steps.find(step => step.key === "jd")).toMatchObject({ action: "edit", blocked: null });
  expect(plan.steps.find(step => step.key === "portrait")).toMatchObject({ blocked: "先补充岗位 JD", action: "generate" });
  expect(remainingPlanMinutes(plan.steps)).toEqual([130, 205]);
  expect(readPreparationPlan(plan, id)).toEqual(plan);
});

it("手动训练进度持久化，重复生成幂等且两个同 JD 岗位相互独立", async () => {
  const first = generate();
  const secondId = (await import("../applications")).createApplication({ company: "乙公司", role: "前端工程师", jd: first.application.jd, resume_id: 1 }).id;
  generate(secondId);
  plans.completePreparationStep(appId, { contextKey: first.contextKey, key: "evidence", done: true });
  expect(generate().steps.find(step => step.key === "evidence")?.done).toBe(true);
  expect(generate(secondId).steps.find(step => step.key === "evidence")?.done).toBe(false);
  expect(db.prepare("SELECT * FROM application_preparation_plans").all()).toHaveLength(2);
  expect(plans.completePreparationStep(appId, { contextKey: first.contextKey, key: "evidence", done: false }).steps.find(step => step.key === "evidence")?.done).toBe(false);
});

it("旧 JD、旧简历版本及未关联资料不充当当前资料；候选不局限于前五条", async () => {
  const { linkPreparationResource } = await import("../application-preparation");
  const insert = db.prepare("INSERT INTO intros (id,resume_id,resume_version_id,jd,created_at) VALUES (?,1,?,?,'')");
  insert.run(1, versionId, "熟悉 React 和 TypeScript");
  db.prepare("INSERT INTO intro_versions (intro_id,kind,sentences,updated_at) VALUES (1,'30s',?,''),(1,'2min',?,'')")
    .run('[{"text":"短版开场","comment":""}]', '[{"text":"长版开场","comment":""}]');
  for (let id = 2; id <= 9; id++) { insert.run(id, versionId, "旧 JD"); linkPreparationResource(appId, "intro", id); }
  expect(generate().steps.find(step => step.key === "intro")?.done).toBe(false);
  linkPreparationResource(appId, "intro", 1);
  expect(generate().steps.find(step => step.key === "intro")).toMatchObject({ done: true, href: `/intros/1?applicationId=${appId}` });
  db.prepare("UPDATE intros SET resume_version_id = NULL WHERE id = 1").run();
  expect(generate().steps.find(step => step.key === "intro")?.done).toBe(false);
});

it("只在完成面试后更新进度，支持继续关联进阶面试", async () => {
  const { linkPreparationResource } = await import("../application-preparation");
  db.prepare("INSERT INTO interview_series (id,resume_id,resume_version_id,jd,created_at) VALUES (1,1,?,'熟悉 React 和 TypeScript','')").run(versionId);
  linkPreparationResource(appId, "series", 1);
  expect(generate().steps.find(step => step.key === "interview")).toMatchObject({ done: false, actionLabel: "继续面试", href: `/interviews/series/1?applicationId=${appId}` });
  db.exec("UPDATE interview_series SET status='finished' WHERE id=1");
  expect(plans.getPreparationPlan(appId).steps.find(step => step.key === "interview")).toMatchObject({ done: true, actionLabel: "查看面试报告" });
});

it("练习题沿用本岗位画像，错题存在时加入复习项，源资料删除后恢复缺项", async () => {
  const { linkPreparationResource } = await import("../application-preparation");
  db.prepare("INSERT INTO jd_portraits (id,jd,result,created_at) VALUES (1,'熟悉 React 和 TypeScript',?,'')").run(JSON.stringify({ role: "前端", mustSkills: [], followups: [{ topic: "React", questions: ["组件状态应放在哪里？"] }], companyStyle: { style: "未明确", signals: [] } }));
  linkPreparationResource(appId, "portrait", 1);
  db.exec("INSERT INTO notebook_entries (id,source,source_id,question,created_at,updated_at) VALUES (1,'drill',0,'待复习题','','')");
  linkPreparationResource(appId, "notebook", 1);
  const plan = generate();
  expect(plan.steps.find(step => step.key === "focus")?.instructions).toContain("React：组件状态应放在哪里？");
  expect(plan.steps.find(step => step.key === "review")).toMatchObject({ done: false, manual: true });
  db.exec("DELETE FROM jd_portraits WHERE id=1");
  expect(plans.getPreparationPlan(appId).steps.find(step => step.key === "portrait")?.done).toBe(false);
});

it("JD 或简历版本切换使旧清单失效，旧请求不能覆盖新岗位进度", async () => {
  const first = generate();
  plans.completePreparationStep(appId, { contextKey: first.contextKey, key: "questions", done: true });
  (await import("../applications")).updateApplication(appId, { jd: "新的岗位要求" });
  expect(plans.getPreparationPlan(appId)).toMatchObject({ stale: true, generatedAt: null, steps: [] });
  expect(() => plans.generatePreparationPlan(appId, first.contextKey)).toThrow(/资料已变化/);
  expect(() => plans.completePreparationStep(appId, { contextKey: first.contextKey, key: "questions", done: true })).toThrow(/资料已变化/);
  expect(generate().steps.find(step => step.key === "questions")?.done).toBe(false);
});

it("不能手动把缺失资料、尚未执行的面试或受阻训练标为完成", () => {
  const plan = generate();
  for (const key of ["portrait", "interview", "intro-practice", "unknown"]) {
    expect(() => plans.completePreparationStep(appId, { contextKey: plan.contextKey, key, done: true })).toThrow(/只能手动/);
  }
  expect(() => plans.completePreparationStep(appId, { contextKey: plan.contextKey, key: "focus", done: "true" })).toThrow();
});

it("损坏的报告与缺少长版的自我介绍保持待补，不把空记录当作齐备", async () => {
  const { linkPreparationResource } = await import("../application-preparation");
  db.prepare("INSERT INTO intros (id,resume_id,resume_version_id,jd,created_at) VALUES (1,1,?,'熟悉 React 和 TypeScript','')").run(versionId);
  db.exec("INSERT INTO intro_versions (intro_id,kind,sentences,updated_at) VALUES (1,'30s','[{\"text\":\"开场\",\"comment\":\"\"}]','')");
  db.exec("INSERT INTO jd_portraits (id,jd,result,created_at) VALUES (1,'熟悉 React 和 TypeScript','not-json','')");
  db.prepare("INSERT INTO resume_diagnoses (id,resume_id,resume_version_id,jd,report,resume_snapshot,created_at) VALUES (1,1,?,'熟悉 React 和 TypeScript','{}','{}','')").run(versionId);
  for (const kind of ["intro", "portrait", "diagnosis"] as const) linkPreparationResource(appId, kind, 1);
  const plan = generate();
  expect(plan.steps.filter(step => ["intro", "portrait", "diagnosis"].includes(step.key)).every(step => !step.done)).toBe(true);
  expect(plan.steps.find(step => step.key === "intro-practice")?.blocked).toBeTruthy();
});

it("API 拒绝无效编号、请求体与过期上下文，内部故障返回 requestId 且事务回滚", async () => {
  const route = await import("@/app/api/tools/preparation-plans/[id]/route");
  const context = (id: string) => ({ params: Promise.resolve({ id }) });
  const request = (body: unknown, method = "POST") => new Request("http://localhost/api/tools/preparation-plans/1", { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
  for (const id of ["0", "01", "1e0", "true", "9007199254740992"]) expect((await route.GET(new Request("http://localhost"), context(id))).status).toBe(400);
  expect((await route.GET(new Request("http://localhost"), context("999"))).status).toBe(404);
  for (const body of [null, [], { contextKey: "stale" }]) expect((await route.POST(request(body), context(String(appId)))).status).toBe(400);
  const initial = plans.getPreparationPlan(appId);
  const created = await route.POST(request({ contextKey: initial.contextKey }), context(String(appId)));
  expect(created.status).toBe(200);
  expect(readPreparationPlan(await created.json(), appId).steps).toHaveLength(10);
  const original = db.prepare.bind(db);
  vi.spyOn(db, "prepare").mockImplementation(sql => {
    if (sql.startsWith("UPDATE application_preparation_plans")) throw new Error("synthetic write failure");
    return original(sql);
  });
  const failed = await route.PATCH(request({ contextKey: initial.contextKey, key: "questions", done: true }, "PATCH"), context(String(appId)));
  expect(failed.status).toBe(500);
  expect(await failed.json()).toHaveProperty("requestId");
  expect(plans.getPreparationPlan(appId).steps.find(step => step.key === "questions")?.done).toBe(false);
});

it("v6 原子升级且保留旧数据，失败时表与版本一并回滚", async () => {
  const { initializeDatabase, validateDatabaseSchema, CURRENT_DB_VERSION } = await import("../db-schema");
  db.exec("DROP TABLE application_preparation_plans; DROP TABLE project_repository_evidence; DROP TABLE mcp_upload_chunks; DROP TABLE mcp_uploads; DROP TABLE mcp_jobs; DROP TABLE mcp_work_leases; DROP TABLE mcp_operation_results; DROP TABLE mcp_generation_progress; DROP TABLE notebook_notes; DROP TABLE mcp_generation_requests; DROP TABLE mcp_drafts; DROP TABLE mcp_creation_receipts; DROP TABLE mcp_operation_logs; DROP TABLE interview_question_graphs; PRAGMA user_version=6");
  expect(() => validateDatabaseSchema(db, 6)).not.toThrow();
  const original = db.exec.bind(db);
  const spy = vi.spyOn(db, "exec").mockImplementation(sql => {
    if (sql.startsWith("PRAGMA user_version =")) throw new Error("migration failure");
    original(sql);
  });
  expect(() => initializeDatabase(db)).toThrow("migration failure");
  expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 6 });
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name='application_preparation_plans'").get()).toBeUndefined();
  spy.mockRestore(); initializeDatabase(db);
  expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_DB_VERSION });
  expect(db.prepare("SELECT company FROM applications WHERE id=?").get(appId)).toMatchObject({ company: "甲公司" });
});

it("清单包含在备份中，旧备份恢复为空清单，删除岗位会级联清理进度", async () => {
  const plan = generate();
  plans.completePreparationStep(appId, { contextKey: plan.contextKey, key: "focus", done: true });
  const { exportAllData, validateBackupPayload } = await import("./backup-fixture");
  const payload = exportAllData();
  expect(validateBackupPayload(payload).valid).toBe(true);
  expect(payload.data.application_preparation_plans).toHaveLength(1);
  const damaged = structuredClone(payload);
  damaged.data.application_preparation_plans![0]!.completed_steps = '["interview"]';
  expect(validateBackupPayload(damaged).valid).toBe(false);
  const { createBackupRecordStream } = await import("../backup-records");
  const { stageBackupRecordStream } = await import("../backup-staging");
  const { restoreAllData, backupTablesForDbVersion } = await import("../backup");
  const staged = await stageBackupRecordStream(createBackupRecordStream(db), db);
  try {
    db.exec("DELETE FROM application_preparation_plans");
    restoreAllData(staged, true);
    expect(plans.getPreparationPlan(appId).steps.find(step => step.key === "focus")?.done).toBe(true);
  } finally { staged.dispose(); }
  expect(backupTablesForDbVersion(6)).not.toContain("application_preparation_plans");
  expect(backupTablesForDbVersion(6)).not.toContain("interview_question_graphs");
  const chunks: Buffer[] = [];
  for await (const chunk of createBackupRecordStream(db)) chunks.push(chunk);
  const records = Buffer.concat(chunks).toString("utf8").trim().split("\n").map(line => JSON.parse(line));
  const legacyRecords = records.filter(record => record.table !== "application_preparation_plans" && record.table !== "interview_question_graphs" && record.table !== "notebook_notes" && record.table !== "project_repository_evidence").map(record => {
    if (record.kind === "manifest") {
      const tables = backupTablesForDbVersion(6, record.tables);
      return { ...record, dbVersion: 6, tables, sequences: Object.fromEntries(Object.entries(record.sequences).filter(([table]) => tables.includes(table))) };
    }
    if (record.kind === "end") {
      const count = record.stats.application_preparation_plans;
      const graphCount = record.stats.interview_question_graphs;
      const noteCount = record.stats.notebook_notes;
      const evidenceCount = record.stats.project_repository_evidence;
      delete record.stats.application_preparation_plans;
      delete record.stats.interview_question_graphs;
      delete record.stats.notebook_notes;
      delete record.stats.project_repository_evidence;
      return { ...record, totalRecords: record.totalRecords - count - graphCount - noteCount - evidenceCount };
    }
    return record;
  });
  const old = await stageBackupRecordStream((async function* () { yield Buffer.from(legacyRecords.map(record => JSON.stringify(record)).join("\n") + "\n"); })(), db);
  try { restoreAllData(old, true); } finally { old.dispose(); }
  expect(plans.getPreparationPlan(appId)).toMatchObject({ generatedAt: null, steps: [] });
  generate();
  db.prepare("DELETE FROM applications WHERE id=?").run(appId);
  expect(db.prepare("SELECT * FROM application_preparation_plans").all()).toEqual([]);
});
