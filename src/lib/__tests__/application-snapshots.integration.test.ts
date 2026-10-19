import { normalizeContent } from "@/lib/modules";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tempDir: string;
let db: DatabaseSync;

beforeEach(async () => {
  vi.resetModules();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-application-snapshots-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", path.join(tempDir, "data"));
  db = (await import("@/lib/db")).getDb();
  db.exec("INSERT INTO resumes (id, title, created_at, updated_at) VALUES (1, '投递简历', '', ''), (2, '另一份简历', '', '')");
  db.prepare("INSERT INTO resume_modules (resume_id, module_key, type, label, sort, content, updated_at) VALUES (1, 'summary', 'summary', '个人介绍', 0, ?, '')")
    .run(JSON.stringify(normalizeContent("summary", { text: "投递时的经历" })));
  const { publishResumeVersion } = await import("@/lib/resume-versions");
  publishResumeVersion(1, { name: "测试发布版本" });
  publishResumeVersion(2, { name: "另一发布版本" });
});

afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (path.dirname(tempDir) !== os.tmpdir() || !path.basename(tempDir).startsWith("resume-life-application-snapshots-")) {
    throw new Error("Unsafe cleanup path");
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function editResume() {
  db.prepare("UPDATE resume_modules SET content = ? WHERE resume_id = 1").run(JSON.stringify(normalizeContent("summary", { text: "后来新增的经历" })));
  db.exec("UPDATE resumes SET title = '当前简历' WHERE id = 1");
}

const input = { company: "测试公司", role: "前端工程师", resume_id: 1, jd: "原始 JD" };

describe("投递时固定简历和 JD", () => {
  it("意向不生成快照，切换已投递后源简历和 JD 的编辑不会改变投递版", async () => {
    const apps = await import("@/lib/applications");
    const app = apps.createApplication(input);
    expect(apps.getApplicationVersions(app.id)?.submitted).toBeNull();
    const applied = apps.updateApplication(app.id, { stage: "applied" });
    expect(applied.submitted_at).toEqual(expect.any(String));
    editResume();
    apps.updateApplication(app.id, { jd: "当前 JD" });
    const versions = apps.getApplicationVersions(app.id)!;
    expect(versions.submitted?.resume?.title).toBe("投递简历");
    expect(versions.submitted?.resume?.modules[0]?.content).toEqual(normalizeContent("summary", { text: "投递时的经历" }));
    expect(versions.submitted?.jd).toBe("原始 JD");
    expect(versions.current.resume?.title).toBe("投递简历");
    expect(versions.current.resume?.modules[0]?.content).toEqual(normalizeContent("summary", { text: "投递时的经历" }));
    expect(versions.current.jd).toBe("当前 JD");
  });

  it("直接新建已投递时捕获，并使用同次提交的新简历与 JD", async () => {
    const apps = await import("@/lib/applications");
    const created = apps.createApplication({ ...input, stage: "applied" });
    expect(apps.getApplicationVersions(created.id)?.submitted?.resume?.id).toBe(1);
    const draft = apps.createApplication(input);
    apps.updateApplication(draft.id, { stage: "applied", resume_id: 2, jd: "新 JD" });
    const submitted = apps.getApplicationVersions(draft.id)?.submitted;
    expect(submitted?.resume?.id).toBe(2);
    expect(submitted?.jd).toBe("新 JD");
  });

  it("重复标记、回退再投递及重新关联都不能覆盖既有快照", async () => {
    const apps = await import("@/lib/applications");
    const app = apps.createApplication({ ...input, stage: "applied" });
    const original = apps.getApplicationVersions(app.id)?.submitted;
    editResume();
    apps.updateApplication(app.id, { stage: "applied", jd: "第二份 JD" });
    apps.updateApplication(app.id, { stage: "interested", resume_id: 2 });
    apps.updateApplication(app.id, { stage: "applied" });
    expect(apps.getApplicationVersions(app.id)?.submitted).toEqual(original);
    expect(apps.getApplicationVersions(app.id)?.current.resume?.id).toBe(2);
  });

  it("删除源简历后仍能完整回看投递版", async () => {
    const apps = await import("@/lib/applications");
    const app = apps.createApplication({ ...input, stage: "applied" });
    db.exec("DELETE FROM resumes WHERE id = 1");
    const versions = apps.getApplicationVersions(app.id)!;
    expect(versions.current.resume).toBeNull();
    expect(versions.submitted?.resume?.modules[0]?.content).toEqual(normalizeContent("summary", { text: "投递时的经历" }));
    expect(versions.submitted?.jd).toBe("原始 JD");
  });

  it("未关联简历时保留 JD 和时间，之后补关联不会伪造投递简历", async () => {
    const apps = await import("@/lib/applications");
    const app = apps.createApplication({ ...input, resume_id: null, stage: "applied" });
    apps.updateApplication(app.id, { resume_id: 1 });
    expect(apps.getApplicationVersions(app.id)?.submitted).toEqual({
      captured_at: expect.any(String), resume: null, jd: "原始 JD",
    });
  });

  it("草稿损坏不影响已发布版本的投递，损坏草稿不能重新发布", async () => {
    const apps = await import("@/lib/applications");
    const app = apps.createApplication(input);
    db.exec("UPDATE resume_modules SET content = 'broken-json' WHERE resume_id = 1");
    const { publishResumeVersion } = await import("@/lib/resume-versions");
    expect(() => publishResumeVersion(1, { name: "损坏草稿" })).toThrow(/损坏模块/);
    apps.updateApplication(app.id, { stage: "applied" });
    expect(apps.getApplicationVersions(app.id)?.submitted?.resume?.modules[0]?.content).toEqual(normalizeContent("summary", { text: "投递时的经历" }));
  });

  it("合法发布版本与 JD 合并后超过备份上限时回滚标记", async () => {
    const apps = await import("@/lib/applications");
    // 正文与列表各存一份，版本行约 2.05 MB；叠加最大合法 JD 后超过 2 MiB。
    const insert = db.prepare("INSERT INTO resume_modules (resume_id, module_key, type, label, sort, content, updated_at) VALUES (1, ?, 'summary', ?, ?, ?, '')");
    for (let index = 0; index < 17; index++) {
      insert.run(`extra-${index}`, `附加经历${index}`, index + 1, JSON.stringify(normalizeContent("summary", { text: "字".repeat(20_000) })));
    }
    (await import("@/lib/resume-versions")).publishResumeVersion(1, { name: "较大发布版本" });
    const app = apps.createApplication({ ...input, jd: "字".repeat(20_000) });
    expect(() => apps.updateApplication(app.id, { stage: "applied" })).toThrow(/备份容量/);
    expect(apps.getApplicationById(app.id)).toMatchObject({ stage: "interested", submitted_at: null });
  });

  it("列表不传输整份快照，删除投递记录也删除其快照", async () => {
    const apps = await import("@/lib/applications");
    const app = apps.createApplication({ ...input, stage: "applied" });
    const listed = apps.listApplications().items[0]!;
    expect(listed.submitted_at).toEqual(expect.any(String));
    expect(listed).not.toHaveProperty("submitted_resume");
    expect(listed).not.toHaveProperty("submitted_jd");
    apps.deleteApplication(app.id);
    expect(apps.getApplicationVersions(app.id)).toBeNull();
  });

  it("只读接口返回投递版和当前版，客户端不能通过 PATCH 覆盖快照", async () => {
    const apps = await import("@/lib/applications");
    const app = apps.createApplication({ ...input, stage: "applied" });
    const original = apps.getApplicationVersions(app.id);
    const route = await import("@/app/api/applications/[id]/route");
    const context = { params: Promise.resolve({ id: String(app.id) }) };
    const patched = await route.PATCH(new Request(`http://127.0.0.1/api/applications/${app.id}`, {
      method: "PATCH", headers: { "content-type": "application/json", origin: "http://127.0.0.1", host: "127.0.0.1" },
      body: JSON.stringify({ submitted_at: "forged", submitted_resume: "{}", submitted_jd: "forged" }),
    }), context);
    expect(patched.status).toBe(200);
    const versions = await import("@/app/api/applications/[id]/versions/route");
    const response = await versions.GET(new Request("http://127.0.0.1"), context);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(original);
    expect((await versions.GET(new Request("http://127.0.0.1"), { params: Promise.resolve({ id: "0" }) })).status).toBe(400);
    expect((await versions.GET(new Request("http://127.0.0.1"), { params: Promise.resolve({ id: "999" }) })).status).toBe(404);
  });

  it("备份恢复保留投递版并拒绝损坏快照", async () => {
    const apps = await import("@/lib/applications");
    const backup = await import("@/lib/__tests__/backup-fixture");
    const app = apps.createApplication({ ...input, stage: "applied" });
    editResume();
    const original = apps.getApplicationVersions(app.id);
    const payload = backup.exportAllData();
    expect(backup.validateBackupPayload(payload).valid).toBe(true);
    const corrupt = structuredClone(payload);
    corrupt.data.applications![0]!.submitted_resume = '{"modules":"broken"}';
    expect(backup.validateBackupPayload(corrupt)).toMatchObject({ valid: false, error: expect.stringContaining("submitted_resume") });

    const records: unknown[] = [{ kind: "manifest", appName: "resume-life", backupVersion: (await import("@/lib/backup-records")).BACKUP_CONTAINER_VERSION,
      dbVersion: payload.meta.dbVersion, createdAt: payload.meta.createdAt, tables: backup.TABLES_CLEAR_ORDER, sequences: payload.meta.sequences, files: [] }];
    for (const table of backup.TABLES_CLEAR_ORDER) {
      for (const data of payload.data[table]!) records.push({ kind: "row", table, data });
    }
    records.push({ kind: "end", stats: payload.meta.stats, totalRecords: Object.values(payload.meta.stats).reduce((sum, count) => sum + count, 0), files: 0 });
    async function* source() { yield Buffer.from(records.map((row) => JSON.stringify(row)).join("\n") + "\n"); }
    const { stageBackupRecordStream } = await import("@/lib/backup-staging");
    const staged = await stageBackupRecordStream(source(), db);
    try {
      apps.deleteApplication(app.id);
      backup.restoreAllData(staged, false);
      expect(apps.getApplicationVersions(app.id)).toEqual(original);
    } finally { staged.dispose(); }
  });
});
