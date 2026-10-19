import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-avatar-lifecycle-"));
process.env.RESUME_LIFE_DATA_DIR = directory;
const { getDb } = await import("../db");
const storage = await import("../upload-storage");
const { POST: copy } = await import("../../app/api/resumes/[id]/copy/route");
const { DELETE: remove, GET: readResume, PATCH: update } = await import("../../app/api/resumes/[id]/route");
const { GET: avatar } = await import("../../app/api/uploads/[name]/route");

afterAll(() => { getDb().close(); fs.rmSync(directory, { recursive: true, force: true }); });

function createResume(filename: string): number {
  const database = getDb();
  const time = new Date().toISOString();
  const result = database.prepare("INSERT INTO resumes (title, template, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run("私人标题", "default", time, time);
  const resumeId = Number(result.lastInsertRowid);
  database.prepare("INSERT INTO resume_modules (resume_id, module_key, type, label, sort, content, updated_at) VALUES (?, 'basic', 'basic', '', 0, ?, ?)")
    .run(resumeId, JSON.stringify({ avatar: `/api/uploads/${filename}` }), time);
  return resumeId;
}

const params = (resumeId: number) => ({ params: Promise.resolve({ id: String(resumeId) }) });

function addAvatarVersion(resumeId: number, url: string, version = 1): void {
  getDb().prepare("INSERT INTO resume_versions (resume_id, version, name, created_at, snapshot) VALUES (?, ?, '头像版本', '', ?)")
    .run(resumeId, version, JSON.stringify({ modules: [{ type: "basic", content: { avatar: url } }] }));
}

it("删除最后一份简历同时清除当前及仅历史引用的全部头像", async () => {
  const historical = await storage.saveUploadFile(Buffer.from("historical-only-photo"), ".png");
  const current = await storage.saveUploadFile(Buffer.from("current-only-photo"), ".png");
  const unrelated = await storage.saveUploadFile(Buffer.from("unrelated-orphan-photo"), ".png");
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(path.join(storage.UPLOADS_DIR, unrelated.filename), old, old);
  const original = createResume(current.filename);
  addAvatarVersion(original, `${historical.url}?v=8f130bae-f339-493b-a69b-b41d9f471323`);

  expect((await remove(new Request("http://localhost/resume", { method: "DELETE" }), params(original))).status).toBe(200);
  expect(getDb().prepare("SELECT id FROM resume_versions WHERE resume_id = ?").all(original)).toEqual([]);
  expect(storage.readUploadFile(current.filename)).toBeNull();
  expect(storage.readUploadFile(historical.filename)).toBeNull();
  expect(getDb().prepare("SELECT id FROM resumes").all()).toEqual([]);
  storage.sweepOrphanUploads(getDb());
  expect(storage.readUploadFile(unrelated.filename)).not.toBeNull();
});

it.each(["current", "historical"])("删除历史头像所属简历保留被其他简历 %s 引用的共享文件", async (reference) => {
  const shared = await storage.saveUploadFile(Buffer.from("shared-history-photo"), ".png");
  const original = createResume("unused-history.png");
  addAvatarVersion(original, shared.url);
  const other = createResume(reference === "current" ? shared.filename : "unused-other-history.png");
  if (reference === "historical") addAvatarVersion(other, `${shared.url}?v=8f130bae-f339-493b-a69b-b41d9f471323`);

  expect((await remove(new Request("http://localhost/resume", { method: "DELETE" }), params(original))).status).toBe(200);
  expect(storage.readUploadFile(shared.filename)).not.toBeNull();
  expect((await remove(new Request("http://localhost/resume", { method: "DELETE" }), params(other))).status).toBe(200);
  expect(storage.readUploadFile(shared.filename)).toBeNull();
});

it("领域删除直接调用也清理历史头像并保持布尔接口", async () => {
  const file = await storage.saveUploadFile(Buffer.from("domain-history-photo"), ".png");
  const original = createResume("unused-domain.png");
  addAvatarVersion(original, file.url);
  const { deleteResume } = await import("../resumes");
  expect(deleteResume(original)).toBe(true);
  expect(deleteResume(original)).toBe(false);
  expect(storage.readUploadFile(file.filename)).toBeNull();
});

it("删除事务失败时当前和历史头像文件都保留", async () => {
  const current = await storage.saveUploadFile(Buffer.from("rollback-current-photo"), ".png");
  const historical = await storage.saveUploadFile(Buffer.from("rollback-historical-photo"), ".png");
  const original = createResume(current.filename);
  addAvatarVersion(original, historical.url);
  const database = getDb();
  database.exec(`CREATE TEMP TRIGGER avatar_delete_failure BEFORE DELETE ON resumes WHEN OLD.id = ${original} BEGIN SELECT RAISE(ABORT, 'synthetic delete failure'); END`);
  try {
    expect((await remove(new Request("http://localhost/resume", { method: "DELETE" }), params(original))).status).toBe(500);
    expect(storage.readUploadFile(current.filename)).not.toBeNull();
    expect(storage.readUploadFile(historical.filename)).not.toBeNull();
    expect(database.prepare("SELECT id FROM resume_versions WHERE resume_id = ?").all(original)).toHaveLength(1);
  } finally {
    database.exec("DROP TRIGGER avatar_delete_failure");
  }
});

it("副本引用头像时原件替换头像不能删除共享文件", async () => {
  const file = await storage.saveUploadFile(Buffer.from("shared-photo"), ".png");
  const original = createResume(file.filename);
  const copied = await copy(new Request("http://localhost/copy", { method: "POST" }), params(original));
  expect(copied.status).toBe(201);
  const copyId = (await copied.json() as { id: number }).id;
  const current = await (await readResume(new Request("http://localhost/resume"), params(original))).json() as
    { modules: { key: string; revision: string }[] };
  const revision = current.modules.find((module) => module.key === "basic")!.revision;
  const updated = await update(new Request("http://localhost/resume", {
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ modules: { basic: { avatar: "" } }, moduleRevisions: { basic: revision } }),
  }), params(original));
  expect(updated.status).toBe(200);
  expect(Buffer.from(storage.readUploadFile(file.filename)!.bytes).toString()).toBe("shared-photo");
  expect((await remove(new Request("http://localhost/resume", { method: "DELETE" }), params(copyId))).status).toBe(200);
  expect(storage.readUploadFile(file.filename)).toBeNull();
});

it("最后一条引用删除后归档头像不可经 HTTP 回退读取", async () => {
  const file = await storage.saveUploadFile(Buffer.from("old-photo"), ".png");
  const archive = path.join(directory, "legacy-uploads");
  fs.mkdirSync(archive, { recursive: true });
  fs.writeFileSync(path.join(archive, file.filename), "old-photo");
  const original = createResume(file.filename);
  expect((await remove(new Request("http://localhost/resume", { method: "DELETE" }), params(original))).status).toBe(200);
  expect((await avatar(new Request("http://localhost/avatar"), { params: Promise.resolve({ name: file.filename }) })).status).toBe(404);
});

it("主头像读取故障时 HTTP 返回 500，不回退为旧图", async () => {
  const file = await storage.saveUploadFile(Buffer.from("current-photo"), ".png");
  createResume(file.filename);
  const archive = path.join(directory, "legacy-uploads");
  fs.mkdirSync(archive, { recursive: true });
  fs.writeFileSync(path.join(archive, file.filename), "stale-photo");
  const original = fs.readFileSync.bind(fs);
  const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((target: fs.PathLike, ...args: unknown[]) => {
    if (String(target) === path.join(storage.UPLOADS_DIR, file.filename)) {
      throw Object.assign(new Error("synthetic read failure"), { code: "EIO" });
    }
    return (original as (...args: unknown[]) => unknown)(target, ...args);
  }) as never);
  try {
    const response = await avatar(new Request(`http://localhost${file.url}`), { params: Promise.resolve({ name: file.filename }) });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("stale-photo");
  } finally {
    spy.mockRestore();
  }
});

it("删除原件后副本头像仍保持可读", async () => {
  const file = await storage.saveUploadFile(Buffer.from("copy-avatar"), ".png");
  const original = createResume(file.filename);
  const copied = await copy(new Request("http://localhost/copy", { method: "POST" }), params(original));
  const copyId = (await copied.json() as { id: number }).id;
  expect((await remove(new Request("http://localhost/resume", { method: "DELETE" }), params(original))).status).toBe(200);
  expect(Buffer.from(storage.readUploadFile(file.filename)!.bytes).toString()).toBe("copy-avatar");
  expect((await remove(new Request("http://localhost/resume", { method: "DELETE" }), params(copyId))).status).toBe(200);
  expect(storage.readUploadFile(file.filename)).toBeNull();
});

it("只有上传目录不存在才视作空清单，权限错误须中止备份", () => {
  const readDirectory = vi.spyOn(fs, "readdirSync").mockImplementation(() => {
    throw Object.assign(new Error("denied"), { code: "EACCES" });
  });
  try { expect(() => storage.listUploadFilenames()).toThrow("denied"); }
  finally { readDirectory.mockRestore(); }
});

it("删除简历同时清除计量日志及备份中的历史标题", async () => {
  const original = createResume("unused.png");
  const database = getDb();
  database.prepare(
    "INSERT INTO llm_call_logs (created_at, feature, entity_type, entity_id, entity_label, task, model, api_format, status) VALUES (?, '简历润色', 'resume', ?, '私人标题', 'summary', 'model', 'openai_chat', 'ok')",
  ).run(new Date().toISOString(), original);
  expect((await remove(new Request("http://localhost/resume", { method: "DELETE" }), params(original))).status).toBe(200);
  const { listLlmCalls } = await import("../llm-call-log");
  const page = listLlmCalls({ from: null, to: null, feature: null, cursor: null, limit: 10 });
  expect(JSON.stringify(page)).not.toContain("私人标题");
  const { exportAllData } = await import("./backup-fixture");
  expect(JSON.stringify(exportAllData().data.llm_call_logs)).not.toContain("私人标题");
});

it("删除简历擦除全部级联实体日志标题，保留用量与其他简历标题", async () => {
  const original = createResume("unused-cascade.png");
  const other = createResume("unused-other.png");
  const database = getDb();
  const time = new Date().toISOString();
  const series = Number(database.prepare("INSERT INTO interview_series (resume_id, jd, created_at) VALUES (?, '', ?)")
    .run(original, time).lastInsertRowid);
  const interview = Number(database.prepare("INSERT INTO interviews (resume_id, jd, series_id, round_no, created_at) VALUES (?, '', ?, 1, ?)")
    .run(original, series, time).lastInsertRowid);
  const cascadingInterview = Number(database.prepare("INSERT INTO interviews (resume_id, jd, series_id, round_no, created_at) VALUES (?, '', ?, 2, ?)")
    .run(other, series, time).lastInsertRowid);
  const intro = Number(database.prepare("INSERT INTO intros (resume_id, created_at) VALUES (?, ?)")
    .run(original, time).lastInsertRowid);
  const entities = [["resume", original], ["interview", interview], ["interview", cascadingInterview], ["interview_series", series], ["intro", intro]] as const;
  const log = database.prepare("INSERT INTO llm_call_logs (created_at, feature, entity_type, entity_id, entity_label, task, model, api_format, status, input_tokens, output_tokens) VALUES (?, 'audit', ?, ?, ?, 'summary', 'model', 'openai_chat', 'ok', 10, 20)");
  const logIds: number[] = [];
  for (const [type, id] of entities) {
    logIds.push(Number(log.run(time, type, id, "合成姓名-待删除").lastInsertRowid));
  }
  const unrelatedLog = Number(log.run(time, "resume", other, "其他简历").lastInsertRowid);

  expect((await remove(new Request("http://localhost/resume", { method: "DELETE" }), params(original))).status).toBe(200);
  for (const id of logIds) {
    expect(database.prepare("SELECT entity_label, input_tokens, output_tokens FROM llm_call_logs WHERE id = ?").get(id))
      .toEqual({ entity_label: "", input_tokens: 10, output_tokens: 20 });
  }
  expect(database.prepare("SELECT entity_label FROM llm_call_logs WHERE id = ?").get(unrelatedLog))
    .toEqual({ entity_label: "其他简历" });
  for (const table of ["interviews", "interview_series", "intros"]) {
    expect(database.prepare(`SELECT id FROM ${table} WHERE resume_id = ?`).all(original)).toEqual([]);
  }
  expect(database.prepare("SELECT id FROM interviews WHERE id = ?").get(cascadingInterview)).toBeUndefined();
  const { exportAllData } = await import("./backup-fixture");
  expect(JSON.stringify(exportAllData().data.llm_call_logs)).not.toContain("合成姓名-待删除");
});

it("简历删除失败时日志标题擦除和实体删除一并回滚", async () => {
  const original = createResume("unused-rollback.png");
  const database = getDb();
  const result = database.prepare("INSERT INTO llm_call_logs (created_at, feature, entity_type, entity_id, entity_label, task, model, api_format, status) VALUES (?, 'audit', 'resume', ?, '保留标题', 'summary', 'model', 'openai_chat', 'ok')")
    .run(new Date().toISOString(), original);
  database.exec(`CREATE TEMP TRIGGER audit_delete_failure BEFORE DELETE ON resumes WHEN OLD.id = ${original} BEGIN SELECT RAISE(ABORT, 'synthetic delete failure'); END`);
  try {
    expect((await remove(new Request("http://localhost/resume", { method: "DELETE" }), params(original))).status).toBe(500);
    expect(database.prepare("SELECT id FROM resumes WHERE id = ?").get(original)).toEqual({ id: original });
    expect(database.prepare("SELECT entity_label FROM llm_call_logs WHERE id = ?").get(result.lastInsertRowid))
      .toEqual({ entity_label: "保留标题" });
  } finally {
    database.exec("DROP TRIGGER audit_delete_failure");
  }
});
