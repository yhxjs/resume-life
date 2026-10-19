import { normalizeContent } from "@/lib/modules";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let directory: string;
let db: DatabaseSync;

beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-versions-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
});

afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-versions-")) {
    throw new Error("Unsafe cleanup path");
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

function resume(title = "后端简历") {
  const ts = new Date().toISOString();
  const id = Number(db.prepare("INSERT INTO resumes (title, created_at, updated_at) VALUES (?, ?, ?)").run(title, ts, ts).lastInsertRowid);
  db.prepare("INSERT INTO resume_modules (resume_id, module_key, type, label, content, updated_at) VALUES (?, 'summary', 'summary', '简介', ?, ?)")
    .run(id, JSON.stringify(normalizeContent("summary", { text: "发布内容" })), ts);
  return id;
}

describe("简历发布版本", () => {
  it("创建版本表并为所有简历消费者添加固定版本引用", () => {
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='resume_versions'").get()).toBeDefined();
    for (const table of ["applications", "interviews", "interview_series", "intros", "resume_diagnoses", "resume_defenses"]) {
      expect(db.prepare(`PRAGMA table_info(${table})`).all()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "resume_version_id" })]));
    }
  });

  it("发布后的内容与样式不受草稿修改影响且不保存草稿 revision", async () => {
    const id = resume();
    const { publishResumeVersion, getResumeVersion } = await import("../resume-versions");
    const { loadResume, loadResumeContext } = await import("../resumes");
    db.prepare("UPDATE resumes SET style_overrides = ? WHERE id = ?").run('{"entryGap":8}', id);
    const version = publishResumeVersion(id, { name: "投递版", description: "A 公司" });
    db.prepare("UPDATE resumes SET title = '新草稿', style_overrides = '{}' WHERE id = ?").run(id);
    db.prepare("UPDATE resume_modules SET content = ? WHERE resume_id = ?").run('{"text":"未发布内容"}', id);
    expect(getResumeVersion(id, version.id)?.snapshot).toEqual(version.snapshot);
    expect(version.snapshot.modules[0]).not.toHaveProperty("revision");
    expect(loadResume(id, version.id)?.resume).toMatchObject({ title: "后端简历", style_overrides: { entryGap: 8 } });
    expect(loadResumeContext(id, version.id)).toContain("发布内容");
    expect(loadResumeContext(id, version.id)).not.toContain("未发布内容");
  });

  it("历史分叉保留已有节点并把后续发布父节点设为所选历史版本", async () => {
    const id = resume();
    const { publishResumeVersion, branchResumeVersion, listResumeVersions } = await import("../resume-versions");
    const { loadResume } = await import("../resumes");
    const first = publishResumeVersion(id, { name: "第一版" });
    db.prepare("UPDATE resume_modules SET content = ? WHERE resume_id = ?").run('{"text":"第二版内容"}', id);
    const second = publishResumeVersion(id, { name: "第二版" });
    const draft = branchResumeVersion(id, first.id);
    expect(draft.modules[0]?.content).toEqual(normalizeContent("summary", { text: "发布内容" }));
    expect(draft.modules[0]?.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(loadResume(id)?.resume.base_version_id).toBe(first.id);
    const branch = publishResumeVersion(id, { name: "分叉版" });
    expect(branch).toMatchObject({ version: 3, parent_id: first.id });
    expect(second.parent_id).toBe(first.id);
    expect(listResumeVersions(id).versions.map((version) => version.id)).toEqual([branch.id, second.id, first.id]);
    for (const version of listResumeVersions(id).versions) expect(version).not.toHaveProperty("snapshot");
  });

  it("拒绝未发布简历和其他简历的版本引用", async () => {
    const id = resume();
    const other = resume("其他简历");
    const { publishResumeVersion, resolveResumeVersionId, branchResumeVersion } = await import("../resume-versions");
    expect(() => resolveResumeVersionId(id)).toThrow("发布");
    const version = publishResumeVersion(id, { name: "发布版" });
    expect(resolveResumeVersionId(id)).toBe(version.id);
    expect(() => resolveResumeVersionId(other, version.id)).toThrow("不属于");
    expect(() => branchResumeVersion(other, version.id)).toThrow();
  });

  it("拒绝覆盖其他页面已修改的草稿", async () => {
    const id = resume();
    const { publishResumeVersion, branchResumeVersion, listResumeVersions } = await import("../resume-versions");
    const version = publishResumeVersion(id, { name: "第一版" });
    const { draft_revision } = listResumeVersions(id);
    db.prepare("UPDATE resume_modules SET content = ? WHERE resume_id = ?").run('{"text":"其他页面的修改"}', id);
    expect(() => branchResumeVersion(id, version.id, draft_revision)).toThrow("已在其他页面修改");
    expect(() => publishResumeVersion(id, { name: "过期发布", draft_revision })).toThrow("已在其他页面修改");
    expect(listResumeVersions(id).versions).toHaveLength(1);
  });

  it("版本持有的旧头像继续可读取且纳入备份", async () => {
    const id = resume();
    const upload = await import("../upload-storage");
    const file = await upload.saveUploadFile(Buffer.from("historical-avatar"), ".png");
    const content = { name: "", phone: "", email: "", location: "", links: "", avatar: file.url };
    db.prepare("INSERT INTO resume_modules (resume_id, module_key, type, content, updated_at) VALUES (?, 'basic', 'basic', ?, '')").run(id, JSON.stringify(content));
    const { publishResumeVersion } = await import("../resume-versions");
    publishResumeVersion(id, { name: "带头像版" });
    db.prepare("DELETE FROM resume_modules WHERE resume_id = ? AND type = 'basic'").run(id);
    upload.removeUnreferencedUploadByUrl(file.url);
    expect(upload.listReferencedUploadFilenames(db)).toContain(file.filename);
    expect(upload.readUploadFile(file.filename)?.bytes).toEqual(new Uint8Array(Buffer.from("historical-avatar")));
    const backup = await import("./backup-fixture");
    const payload = backup.exportAllData();
    expect(payload.data.resume_versions).toHaveLength(1);
    const validated = backup.validateBackupPayload(payload);
    expect(validated).toMatchObject({ valid: true });
  });

  it("冻结自定义模板样式并在模板变化后分叉恢复原有外观", async () => {
    const id = resume();
    const { DEFAULT_STYLE, resolveStyle } = await import("../templates");
    const style = { ...DEFAULT_STYLE, accent: "#ff0000" };
    const templateId = Number(db.prepare("INSERT INTO resume_templates (name, style, created_at, updated_at) VALUES ('原模板', ?, '', '')").run(JSON.stringify(style)).lastInsertRowid);
    db.prepare("UPDATE resumes SET template = ? WHERE id = ?").run(`custom:${templateId}`, id);
    const { publishResumeVersion, branchResumeVersion } = await import("../resume-versions");
    const version = publishResumeVersion(id, { name: "样式版" });
    expect(version.snapshot.resolved_style?.accent).toBe("#ff0000");
    db.prepare("UPDATE resume_templates SET style = ? WHERE id = ?").run(JSON.stringify({ ...style, accent: "#0000ff" }), templateId);
    const branched = branchResumeVersion(id, version.id);
    const customs = (db.prepare("SELECT * FROM resume_templates").all() as { id: number; name: string; style: string; created_at: string; updated_at: string }[])
      .map((row) => ({ ...row, style: JSON.parse(row.style) }));
    expect(resolveStyle(branched.resume.template, customs, branched.resume.style_overrides).accent).toBe("#ff0000");
  });

  it.each(["{broken", "null", "[]"])("当前模板损坏 %s 时，历史分支仍从冻结样式恢复且保留原始坏记录", async (broken) => {
    const id = resume();
    const { DEFAULT_STYLE } = await import("../templates");
    const style = { ...DEFAULT_STYLE, accent: "#ff0000" };
    const templateId = Number(db.prepare("INSERT INTO resume_templates(name,style,created_at,updated_at) VALUES('原模板',?,'','')")
      .run(JSON.stringify(style)).lastInsertRowid);
    db.prepare("UPDATE resumes SET template=? WHERE id=?").run(`custom:${templateId}`, id);
    const { publishResumeVersion, branchResumeVersion } = await import("../resume-versions");
    const version = publishResumeVersion(id, { name: "冻结版" });
    db.prepare("UPDATE resume_templates SET style=? WHERE id=?").run(broken, templateId);
    expect(() => publishResumeVersion(id, { name: "坏模板不能发布" })).toThrow(/模板.*损坏/);
    const restored = branchResumeVersion(id, version.id);
    expect(restored.resume.template).not.toBe(`custom:${templateId}`);
    const { loadCustomTemplate } = await import("../custom-templates");
    expect(loadCustomTemplate(Number(restored.resume.template.slice("custom:".length))).style).toEqual(style);
    expect(db.prepare("SELECT style FROM resume_templates WHERE id=?").get(templateId)).toEqual({ style: broken });
  });

  it("拒绝备份中损坏的版本快照与跨简历父节点", async () => {
    const id = resume();
    const otherId = resume("另一个简历");
    const { publishResumeVersion } = await import("../resume-versions");
    publishResumeVersion(id, { name: "第一版" });
    const otherVersion = publishResumeVersion(otherId, { name: "另一版" });
    const backup = await import("./backup-fixture");
    const payload = backup.exportAllData();
    const damaged = structuredClone(payload);
    damaged.data.resume_versions![0]!.snapshot = '{"modules":[]}';
    expect(backup.validateBackupPayload(damaged)).toMatchObject({ valid: false });
    payload.data.resume_versions![0]!.parent_id = otherVersion.id;
    expect(backup.validateBackupPayload(payload)).toMatchObject({ valid: false });
  });

  it("发布超出备份记录上限的快照时回滚版本与来源指针", async () => {
    const id = resume();
    const { MAX_BACKUP_RECORD_BYTES } = await import("../backup-limits");
    db.prepare("UPDATE resume_modules SET content = ? WHERE resume_id = ?").run(JSON.stringify(normalizeContent("summary", { text: "x".repeat(MAX_BACKUP_RECORD_BYTES) })), id);
    const { publishResumeVersion, listResumeVersions } = await import("../resume-versions");
    expect(() => publishResumeVersion(id, { name: "超大快照" })).toThrow("过大");
    expect(listResumeVersions(id)).toMatchObject({ versions: [], base_version_id: null });
  });

  it("流式备份恢复保留版本树和仅被历史版本引用的头像", async () => {
    const id = resume();
    const upload = await import("../upload-storage");
    const file = await upload.saveUploadFile(Buffer.from("version-avatar"), ".png");
    db.prepare("INSERT INTO resume_modules (resume_id, module_key, type, content, updated_at) VALUES (?, 'basic', 'basic', ?, '')")
      .run(id, JSON.stringify({ name: "", phone: "", email: "", location: "", links: "", avatar: file.url }));
    const { publishResumeVersion, getResumeVersion, branchResumeVersion } = await import("../resume-versions");
    const first = publishResumeVersion(id, { name: "版本一" });
    db.prepare("DELETE FROM resume_modules WHERE resume_id = ? AND type = 'basic'").run(id);
    const second = publishResumeVersion(id, { name: "版本二" });
    branchResumeVersion(id, first.id);
    const { createBackupRecordStream } = await import("../backup-records");
    const chunks: Buffer[] = [];
    for await (const chunk of createBackupRecordStream(db)) chunks.push(chunk);
    const source = (async function* () { yield Buffer.concat(chunks); })();
    const { stageBackupRecordStream } = await import("../backup-staging");
    const staged = await stageBackupRecordStream(source, db);
    try {
      const { restoreAllData } = await import("./backup-fixture");
      restoreAllData(staged, false);
      expect(getResumeVersion(id, first.id)).toEqual(first);
      expect(getResumeVersion(id, second.id)).toEqual(second);
      expect(upload.listReferencedUploadFilenames(db)).toContain(file.filename);
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { staged.dispose(); }
  });

  it("历史版本头像文件丢失时拒绝生成不完整备份", async () => {
    const id = resume();
    db.prepare("INSERT INTO resume_modules (resume_id, module_key, type, content, updated_at) VALUES (?, 'basic', 'basic', ?, '')")
      .run(id, JSON.stringify({ name: "", phone: "", email: "", location: "", links: "", avatar: "/api/uploads/missing.png" }));
    const { publishResumeVersion } = await import("../resume-versions");
    publishResumeVersion(id, { name: "历史头像" });
    db.prepare("DELETE FROM resume_modules WHERE resume_id = ? AND type = 'basic'").run(id);
    const { createBackupRecordStream } = await import("../backup-records");
    const consume = async () => { for await (const chunk of createBackupRecordStream(db)) void chunk; };
    await expect(consume()).rejects.toThrow("头像");
  });

  it("版本接口返回发布记录、版本摘要并拒绝过期分叉", async () => {
    const id = resume();
    const routes = await import("@/app/api/resumes/[id]/versions/route");
    const ctx = { params: Promise.resolve({ id: String(id) }) };
    const request = (body: unknown) => new Request("http://localhost/api/resumes/1/versions", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const listing = await (await routes.GET(new Request("http://localhost"), ctx)).json();
    expect((await routes.POST(request({ name: "没有草稿指纹" }), ctx)).status).toBe(409);
    const response = await routes.POST(request({ name: "接口版", draft_revision: listing.draft_revision }), ctx);
    expect(response.status).toBe(201);
    const version = await response.json();
    const listRoute = await import("@/app/api/resumes/route");
    expect(await (await listRoute.GET(new Request("http://localhost"))).json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id, versions: [{ id: version.id, version: 1, name: "接口版" }] }),
    ]));
    const branchRoute = await import("@/app/api/resumes/[id]/versions/[versionId]/branch/route");
    const branchCtx = { params: Promise.resolve({ id: String(id), versionId: String(version.id) }) };
    expect((await branchRoute.POST(request({ draft_revision: listing.draft_revision }), branchCtx)).status).toBe(409);
    const latest = await (await routes.GET(new Request("http://localhost"), ctx)).json();
    expect((await branchRoute.POST(request({ draft_revision: latest.draft_revision }), branchCtx)).status).toBe(200);
  });
});
