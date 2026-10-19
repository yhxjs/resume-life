import { normalizeContent } from "@/lib/modules";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PREFIX = "resume-life-query-counts-";
let directory: string;
let db: DatabaseSync;

beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.prepare("INSERT INTO resumes (id, title, created_at, updated_at) VALUES (1, '简历', '', '')").run();
  db.prepare("INSERT INTO applications (id, company, role, stage, created_at, updated_at) VALUES (1, '公司', '工程师', 'interested', '', '')").run();
  db.prepare("INSERT INTO application_interviews (id, application_id, round_name, created_at, updated_at) VALUES (1, 1, '技术面', '', '')").run();
});

afterEach(() => {
  vi.restoreAllMocks();
  db?.close();
  vi.unstubAllEnvs();
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(PREFIX)) {
    throw new Error("Unsafe cleanup path");
  }
  fs.rmSync(resolved, { recursive: true, force: true });
});

async function countSelects(action: () => unknown | Promise<unknown>): Promise<number> {
  const { dataGeneration } = await import("../db");
  const { withDataGenerationScope } = await import("../data-generation");
  const generation = dataGeneration(db);
  let count = 0;
  const prepare = db.prepare.bind(db);
  const restore: (() => void)[] = [];
  const spy = vi.spyOn(db, "prepare").mockImplementation((sql) => {
    const statement = prepare(sql);
    if (/^\s*(SELECT|WITH)\b/i.test(sql)) {
      const get = statement.get.bind(statement);
      const all = statement.all.bind(statement);
      const getSpy = vi.spyOn(statement, "get").mockImplementation((...args) => { count++; return get(...args); });
      const allSpy = vi.spyOn(statement, "all").mockImplementation((...args) => { count++; return all(...args); });
      restore.push(() => getSpy.mockRestore(), () => allSpy.mockRestore());
    }
    return statement;
  });
  try {
    await withDataGenerationScope(action, generation);
    return count;
  } finally {
    spy.mockRestore();
    restore.forEach((undo) => undo());
  }
}

function addModules(from: number, count: number) {
  const insert = db.prepare("INSERT INTO resume_modules (resume_id, module_key, type, label, content, updated_at) VALUES (1, ?, 'summary', '简介', ?, '')");
  for (let index = from; index < from + count; index++) insert.run(`module-${index}`, JSON.stringify(normalizeContent("summary", { text: `内容 ${index}` })));
}

it("自我介绍详情的 SELECT 数不随版本数增长，返回的修订仍可保存且绑定当前世代", async () => {
  const { GET } = await import("@/app/api/intros/[id]/route");
  const { introVersionRevision, saveIntroVersion } = await import("../intro-versions");
  const sentences = [{ text: "自我介绍", comment: "" }];
  db.prepare("INSERT INTO intros (id, resume_id, jd, created_at) VALUES (1, 1, '', '')").run();
  const insert = db.prepare("INSERT INTO intro_versions (intro_id, kind, sentences, updated_at) VALUES (1, ?, ?, '')");
  insert.run("30s", JSON.stringify(sentences));
  const read = () => GET(new Request("http://localhost/api/intros/1"), { params: Promise.resolve({ id: "1" }) });
  const one = await countSelects(read);
  insert.run("2min", JSON.stringify(sentences));
  expect(await countSelects(read)).toBe(one);

  const response = await read();
  expect(response.status).toBe(200);
  const { versions } = await response.json() as { versions: { kind: "30s" | "2min"; revision: string }[] };
  expect(versions).toHaveLength(2);
  for (const version of versions) {
    const row = db.prepare("SELECT id, sentences, updated_at FROM intro_versions WHERE intro_id = 1 AND kind = ?")
      .get(version.kind) as { id: number; sentences: string; updated_at: string };
    expect(version.revision).toBe(introVersionRevision(row));
    expect(saveIntroVersion(1, version.kind, version.revision, sentences).status).toBe(200);
  }

  const latest = await (await read()).json() as { versions: { kind: "30s" | "2min"; revision: string }[] };
  db.prepare("INSERT INTO runtime_state (id, data_generation) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data_generation = excluded.data_generation")
    .run("restored-generation");
  for (const version of latest.versions) {
    expect(saveIntroVersion(1, version.kind, version.revision, sentences).status).toBe(409);
  }
});

it("加载和批量保存简历的 SELECT 数不随模块数增长，令牌仍绑定当前世代", async () => {
  const { loadResume, revisionOf } = await import("../resumes");
  const { PATCH } = await import("@/app/api/resumes/[id]/route");
  const measure = async () => {
    const reads = await countSelects(() => loadResume(1));
    const state = loadResume(1)!;
    for (const item of state.modules) {
      expect(item.revision).toBe(revisionOf(JSON.stringify(item.content), 1, `module:${item.key}`));
    }
    const writes = await countSelects(async () => {
      const response = await PATCH(new Request("http://localhost/api/resumes/1", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modules: Object.fromEntries(state.modules.map((module) => [module.key, normalizeContent("summary", { text: "已保存" })])),
          moduleRevisions: Object.fromEntries(state.modules.map((module) => [module.key, module.revision])),
        }),
      }), { params: Promise.resolve({ id: "1" }) });
      expect(response.status).toBe(200);
      expect((await response.json()).modules).toHaveLength(state.modules.length);
    });
    return { reads, writes };
  };
  addModules(0, 1);
  const small = await measure();
  addModules(1, 19);
  expect(await measure()).toEqual(small);
});

it.each(["mistakes", "resume_suggestions"] as const)("复盘 %s 首次导出及重复导出的 SELECT 数不随条目数增长", async (action) => {
  const { exportInterviewReview } = await import("../application-interview-review");
  const measure = async (size: number) => {
    const questions = Array.from({ length: size }, (_, index) => ({ question: `问题 ${index}`, answer: "回答", stuck: "", feedback: "" }));
    const result = {
      mistakes: questions.map((_, index) => ({ question_index: index + 1, gap: "不足", improved_answer: "改进" })),
      resume_suggestions: questions.map((_, index) => ({ question_index: index + 1, suggestion: "建议".repeat(150) })),
      drills: [],
    };
    const recapId = Number(db.prepare("INSERT INTO application_interview_recaps (interview_id, input_hash, questions, result, created_at) VALUES (1, ?, ?, ?, '')")
      .run("a".repeat(64), JSON.stringify(questions), JSON.stringify(result)).lastInsertRowid);
    const run = () => exportInterviewReview(1, 1, recapId, action);
    const first = await countSelects(run);
    const repeated = await countSelects(run);
    const targets = db.prepare("SELECT target_id FROM application_interview_recap_exports WHERE recap_id = ? AND kind = ?").all(recapId, action) as { target_id: number }[];
    expect(targets).toHaveLength(size);
    if (action === "mistakes") {
      for (const target of targets) expect(db.prepare("SELECT id FROM review_cards WHERE notebook_id = ?").get(target.target_id)).toBeDefined();
    }
    const table = action === "mistakes" ? "notebook_entries" : "application_preparation_tasks";
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(targets[0]!.target_id);
    const recreated = await countSelects(run);
    expect(db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(targets[0]!.target_id)).toBeUndefined();
    expect(run().selected?.exports[action]).toBe(true);
    return { first, repeated, recreated };
  };
  expect(await measure(20)).toEqual(await measure(1));
});

it("删除简历的 SELECT 数不随历史头像数增长，并保留其他简历共享的头像", async () => {
  const storage = await import("../upload-storage");
  const { deleteResume } = await import("../resumes");
  db.prepare("INSERT INTO resume_versions (resume_id, version, name, created_at, snapshot) VALUES (1, 1, '损坏历史', '', '{')").run();
  const measure = async (size: number) => {
    const resumeId = Number(db.prepare("INSERT INTO resumes (title, created_at, updated_at) VALUES ('头像简历', '', '')").run().lastInsertRowid);
    const files = await Promise.all(Array.from({ length: size }, () => storage.saveUploadFile(Buffer.from("avatar"), ".png")));
    const insert = db.prepare("INSERT INTO resume_versions (resume_id, version, name, created_at, snapshot) VALUES (?, ?, '头像', '', ?)");
    files.forEach((file, index) => insert.run(resumeId, index + 1, JSON.stringify({ modules: [{ type: "basic", content: { avatar: file.url } }] })));
    db.prepare("INSERT INTO resume_modules (resume_id, module_key, type, label, content, updated_at) VALUES (1, ?, 'basic', '', ?, '')")
      .run(`shared-${resumeId}`, JSON.stringify({ avatar: `${files[0]!.url}?v=8f130bae-f339-493b-a69b-b41d9f471323` }));
    const count = await countSelects(() => expect(deleteResume(resumeId)).toBe(true));
    expect(storage.readUploadFile(files[0]!.filename)).not.toBeNull();
    for (const file of files.slice(1)) expect(storage.readUploadFile(file.filename)).toBeNull();
    return count;
  };
  expect(await measure(20)).toBe(await measure(1));
});
