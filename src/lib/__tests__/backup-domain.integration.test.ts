import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BackupPayload } from "./backup-fixture";

const llm = vi.hoisted(() => ({ chat: vi.fn(), chatStream: vi.fn() }));
vi.mock("@/lib/llm", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/llm")>(),
  ...llm,
}));

let directory: string;
let db: DatabaseSync;
beforeEach(async () => {
  vi.resetModules();
  llm.chat.mockReset();
  llm.chatStream.mockReset();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-backup-domain-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.exec("INSERT INTO projects (id,name,created_at,updated_at) VALUES (1,'保留项目','','')");
  const { writeSettings } = await import("../settings");
  writeSettings({ api_key: "test-only-saved-key", model_question: "saved-model" });
});
afterEach(() => {
  db?.close(); vi.unstubAllEnvs();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-backup-domain-")) throw new Error("Unsafe cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
});

async function* sourceOf(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

async function stagePayload(payload: BackupPayload) {
  const backup = await import("./backup-fixture");
  const records: Record<string, unknown>[] = [{
    kind: "manifest",
    appName: "resume-life",
    backupVersion: (await import("../backup-records")).BACKUP_CONTAINER_VERSION,
    dbVersion: payload.meta.dbVersion,
    createdAt: payload.meta.createdAt,
    tables: backup.TABLES_CLEAR_ORDER,
    sequences: payload.meta.sequences,
    files: [],
  }];
  for (const table of backup.TABLES_CLEAR_ORDER) {
    for (const data of payload.data[table]!) records.push({ kind: "row", table, data });
  }
  records.push({
    kind: "end",
    stats: payload.meta.stats,
    totalRecords: Object.values(payload.meta.stats).reduce((sum, count) => sum + count, 0),
    files: 0,
  });
  const bytes = Buffer.from(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  const { stageBackupRecordStream } = await import("../backup-staging");
  return stageBackupRecordStream(sourceOf(bytes), db);
}

async function validateStagedPayload(payload: BackupPayload): Promise<void> {
  const staged = await stagePayload(payload);
  staged.dispose();
}

async function restorePayload(payload: BackupPayload, preserveAiConfig: boolean) {
  const staged = await stagePayload(payload);
  try {
    const { restoreAllData } = await import("./backup-fixture");
    return restoreAllData(staged, preserveAiConfig);
  } finally {
    staged.dispose();
  }
}

it("登录后的备份排除认证序列，恢复不改变凭证、会话或序列", async () => {
  const auth = await import("../auth");
  auth.initializeCredentials("backup-user", "synthetic-password");
  const session = auth.createSession();
  const credentials = db.prepare("SELECT * FROM auth_users").get();
  const sequence = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'auth_sessions'").get();
  const { exportAllData } = await import("./backup-fixture");
  const payload = exportAllData();
  expect(payload.meta.sequences).not.toHaveProperty("auth_sessions");
  expect(payload.data).not.toHaveProperty("auth_users");
  expect(payload.data).not.toHaveProperty("auth_sessions");
  await restorePayload(payload, true);
  expect(auth.isInitialized()).toBe(true);
  expect(db.prepare("SELECT * FROM auth_users").get()).toEqual(credentials);
  expect(auth.resolveSession(session.token)).not.toBeNull();
  expect(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'auth_sessions'").get()).toEqual(sequence);
  const { validateBackupSequences } = await import("../backup");
  expect(() => validateBackupSequences({ auth_sessions: 1 })).toThrow(/未知表/);
});

it("导出仍拒绝认证表以外的未知序列", async () => {
  db.exec("CREATE TABLE unknown_runtime (id INTEGER PRIMARY KEY AUTOINCREMENT); INSERT INTO unknown_runtime DEFAULT VALUES");
  const { readBackupSequences } = await import("../backup");
  expect(() => readBackupSequences(db)).toThrow(/unknown_runtime/);
});

it("备份恢复保留投递批次、终止归因及完整阶段履历", async () => {
  const { createApplication, updateApplication, deleteApplication, getApplicationById } = await import("../applications");
  const { exportAllData } = await import("./backup-fixture");
  const app = createApplication({ company: "备份履历", role: "工程师", stage: "applied", batch_name: "春招" });
  updateApplication(app.id, { stage: "interview", hiring_stage: "technical_interview" });
  const terminated = updateApplication(app.id, { stage: "rejected", terminal_stage: "technical_interview", terminal_reason: "技术考核未通过" });
  const payload = exportAllData();
  deleteApplication(app.id);
  expect(db.prepare("SELECT COUNT(*) AS count FROM application_stage_history").get()).toEqual({ count: 0 });
  await restorePayload(payload, true);
  expect(getApplicationById(app.id)).toEqual(terminated);
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});

it("恢复事务提交失败时保留原头像字节和原数据库", async () => {
  const { saveUploadFile, UPLOADS_DIR } = await import("../upload-storage");
  const { exportAllData, restoreAllData } = await import("./backup-fixture");
  const file = await saveUploadFile(Buffer.from("original-avatar"), ".png");
  const staged = await stagePayload(exportAllData());
  const replacement = Buffer.from("replacement-avatar");
  const handle = {
    stats: staged.stats,
    sequences: staged.sequences,
    files: [{ name: file.filename, bytes: replacement.byteLength }],
    readTableBatch: staged.readTableBatch.bind(staged),
    readFileBytes: () => replacement,
  };
  const execute = db.exec.bind(db);
  const spy = vi.spyOn(db, "exec").mockImplementation((sql) => {
    if (sql === "COMMIT") throw new Error("injected commit failure");
    return execute(sql);
  });
  try {
    expect(() => restoreAllData(handle, false)).toThrow("injected commit failure");
    expect(fs.readFileSync(path.join(UPLOADS_DIR, file.filename)).toString()).toBe("original-avatar");
    expect((db.prepare("SELECT name FROM projects WHERE id = 1").get() as { name: string }).name).toBe("保留项目");
  } finally {
    spy.mockRestore();
    staged.dispose();
  }
});

it("生成恢复前快照时已持有跨连接写锁", async () => {
  const { exportAllData, restoreAllData } = await import("./backup-fixture");
  const staged = await stagePayload(exportAllData());
  const competing = new DatabaseSync(path.join(directory, "resume-life.db"));
  competing.exec("PRAGMA busy_timeout = 1");
  const mkdir = fs.mkdirSync.bind(fs);
  let blocked = false;
  const spy = vi.spyOn(fs, "mkdirSync").mockImplementation(((target: string, options?: object) => {
    if (target === path.join(directory, "backups")) {
      try { competing.prepare("INSERT INTO projects (name, created_at, updated_at) VALUES ('late', '', '')").run(); }
      catch { blocked = true; }
    }
    return mkdir(target, options);
  }) as typeof fs.mkdirSync);
  try {
    restoreAllData(staged, false);
    expect(blocked).toBe(true);
    expect(competing.prepare("SELECT name FROM projects WHERE name = 'late'").get()).toBeUndefined();
  } finally {
    spy.mockRestore();
    competing.close();
    staged.dispose();
  }
});

it.each(['{"overview":42}', '{"architecture":[]}', 'null', '[]', '{broken'])("rejects corrupt project summary without changing the existing database: %s", async (summary) => {
  const backup = await import("./backup-fixture");
  const original = backup.exportAllData();
  const payload = structuredClone(original);
  payload.data.projects![0]!.summary = summary;
  payload.data.projects![0]!.name = "不应导入";
  payload.data.settings![0]!.api_key = "test-only-replacement-key";
  await expect(validateStagedPayload(payload)).rejects.toThrow(/projects.*1.*summary/);
  expect(backup.exportAllData().data).toEqual(original.data);
  await expect(restorePayload(payload, false)).rejects.toThrow(/projects.*1.*summary/);
  expect(backup.exportAllData().data).toEqual(original.data);
  expect(fs.existsSync(path.join(directory, "backups"))).toBe(false);
});

it("reports corrupt stored project data rather than a nonexistent project or trim exception", async () => {
  db.exec(`UPDATE projects SET summary='{"overview":42}'`);
  const route = (await import("../../app/api/drills/route")).POST;
  const response = await route(new Request("http://localhost/drills", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: 1 }),
  }));
  expect(response.status).toBe(422);
  const body = await response.json();
  expect(body.error).toMatch(/数据|损坏/);
  expect(body.error).not.toMatch(/不存在|trim/);
});

it.each([
  ["无效 JSON", "{broken"],
  ["缺少评价字段", JSON.stringify({ defense_score: 80 })],
  ["分数越界", JSON.stringify({ defense_score: 101, interviewer_roast: "点评", defense_critique: "剖析", improved_answer: "示范回答" })],
])("defense drill rejects %s without inserting or overwriting records", async (_label, raw) => {
  db.prepare(
    `INSERT INTO resume_defenses (id, source_content, scanned_items, created_at)
     VALUES (1, '简历内容', ?, 'original')`,
  ).run(JSON.stringify([{
    id: "item_1",
    originalText: "优化性能",
    defensePlan: { standardDefense: "说明指标与权衡" },
  }]));
  db.exec(
    `INSERT INTO resume_defense_drills
      (id, defense_id, item_id, question, user_answer, interviewer_roast, defense_score, defense_critique, improved_answer, created_at, updated_at)
     VALUES (1, 1, 'item_1', '旧问题', '旧回答', '旧点评', 72, '旧剖析', '旧示范', 'original', 'original')`,
  );
  const original = db.prepare("SELECT * FROM resume_defense_drills WHERE id = 1").get();
  llm.chat.mockResolvedValueOnce(raw);
  const route = (await import("../../app/api/tools/resume-defenses/[id]/drill/route")).POST;

  const response = await route(new Request("http://localhost/api/tools/resume-defenses/1/drill", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      itemId: "item_1",
      question: "请说明优化指标",
      userAnswer: "我把延迟降低了一半",
    }),
  }), { params: Promise.resolve({ id: "1" }) });

  expect(response.status).toBe(502);
  expect((await response.json()).error).toMatch(/AI|模型|协议|格式|评价/);
  expect(db.prepare("SELECT COUNT(*) AS count FROM resume_defense_drills").get()).toEqual({ count: 1 });
  expect(db.prepare("SELECT * FROM resume_defense_drills WHERE id = 1").get()).toEqual(original);
});

it("round-trips an ungenerated project summary without altering the backup", async () => {
  const backup = await import("./backup-fixture");
  const payload = backup.exportAllData();
  expect(payload.data.projects![0]!.summary).toBe("{}");
  expect(backup.validateBackupPayload(payload).valid).toBe(true);
  await restorePayload(payload, false);
  expect(backup.exportAllData().data).toEqual(payload.data);
});

it("恢复备份时同步更新搜索索引", async () => {
  db.exec("INSERT INTO resumes (title,created_at,updated_at) VALUES ('helios archived','','')");
  const backup = await import("./backup-fixture");
  const payload = backup.exportAllData();
  expect(payload.meta.dbVersion).toBe((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
  db.exec("UPDATE resumes SET title='ordinary resume'");
  expect(db.prepare("SELECT rowid FROM search_fts_resumes WHERE search_fts_resumes MATCH 'lio'").all()).toEqual([]);

  await restorePayload(payload, false);
  expect(db.prepare("SELECT rowid FROM search_fts_resumes WHERE search_fts_resumes MATCH 'lio'").all()).toHaveLength(1);
  expect(backup.exportAllData().data).toEqual(payload.data);
});

it("导出→恢复把头像文件一并带回数据目录，含跨分块的大文件", async () => {
  const { saveUploadFile, UPLOADS_DIR } = await import("../upload-storage");
  const { defaultContent } = await import("../modules");
  const records = await import("../backup-records");
  const staging = await import("../backup-staging");
  const { restoreAllData } = await import("./backup-fixture");

  // 1 MiB 一块，这里给一个必须分成两块的文件，覆盖跨分块拼装这条路径
  const bigBytes = Buffer.alloc(1_500_000, 0x5a);
  const smallBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const big = await saveUploadFile(bigBytes, ".png");
  const small = await saveUploadFile(smallBytes, ".png");
  const orphan = await saveUploadFile(Buffer.from("unreferenced-photo"), ".png");

  const insert = (id: number, avatar: string) => {
    db.prepare("INSERT INTO resumes (id, title, created_at, updated_at) VALUES (?, ?, '', '')").run(id, `简历${id}`);
    db.prepare(
      "INSERT INTO resume_modules (resume_id, module_key, type, sort, content, updated_at) VALUES (?, 'basic', 'basic', 0, ?, '')",
    ).run(id, JSON.stringify({ ...defaultContent("basic"), avatar }));
  };
  insert(1, big.url);
  insert(2, small.url);

  const chunks: Buffer[] = [];
  for await (const chunk of records.createBackupRecordStream(db)) chunks.push(Buffer.from(chunk));
  const plaintext = Buffer.concat(chunks);
  const manifest = JSON.parse(plaintext.toString("utf8").split("\n")[0]!) as {
    files: { name: string; bytes: number; chunks: number }[];
  };
  expect(manifest.files.map((file) => file.name).sort()).toEqual([small.filename, big.filename].sort());
  expect(manifest.files.map((file) => file.name)).not.toContain(orphan.filename);
  expect(manifest.files.find((file) => file.name === big.filename)?.chunks).toBe(2);
  expect(manifest.files.find((file) => file.name === small.filename)?.chunks).toBe(1);

  // 模拟「备份已导出、本机文件随后丢失」：不删掉就无法区分「恢复写回了文件」与「文件本来就在」
  for (const name of [big.filename, small.filename]) {
    fs.rmSync(path.join(UPLOADS_DIR, name), { force: true });
  }

  const staged = await staging.stageBackupRecordStream(sourceOf(plaintext), db);
  try {
    restoreAllData(staged, false);
  } finally {
    staged.dispose();
  }

  // 按报告的建议遍历库里的 avatar 指针，逐个断言文件真实存在且内容一致
  const rows = db.prepare("SELECT content FROM resume_modules WHERE type = 'basic'").all() as { content: string }[];
  expect(rows).toHaveLength(2);
  const restored = rows.map((row) => (JSON.parse(row.content) as { avatar: string }).avatar).sort();
  expect(restored.map((url) => new URL(url, "http://localhost").pathname).sort())
    .toEqual([big.url, small.url].sort());
  for (const url of restored) {
    const { uploadPathFromUrl } = await import("../upload-storage");
    const target = uploadPathFromUrl(url)!;
    expect(fs.existsSync(target)).toBe(true);
  }
  expect(fs.readFileSync(path.join(UPLOADS_DIR, big.filename))).toEqual(bigBytes);
  expect(fs.readFileSync(path.join(UPLOADS_DIR, small.filename))).toEqual(smallBytes);
  // 单跑约 2.4 秒，但整套并行跑时加密 1.5 MiB 分块 + 落盘会挤到 5 秒默认超时之外，
  // 故显式放宽，避免这条覆盖跨分块拼装的用例在负载下随机变红。
}, 15_000);

it("恢复旧快照后隔离旧头像，旧 URL 不可读且后续导出不含旧文件", async () => {
  const { saveUploadFile, UPLOADS_DIR } = await import("../upload-storage");
  const records = await import("../backup-records");
  const staging = await import("../backup-staging");
  const { restoreAllData } = await import("./backup-fixture");

  const chunks: Buffer[] = [];
  for await (const chunk of records.createBackupRecordStream(db)) chunks.push(Buffer.from(chunk));
  const later = await saveUploadFile(Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3, 4, 5, 6, 7, 8, 9]), ".jpg");
  const archive = path.join(directory, "legacy-uploads");
  fs.mkdirSync(archive, { recursive: true });
  fs.writeFileSync(path.join(archive, later.filename), "archived-photo");
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'后来的简历','','')");
  db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,sort,content,updated_at) VALUES (1,'basic','basic',0,?,'')")
    .run(JSON.stringify({ avatar: later.url }));
  const avatarRoute = await import("@/app/api/uploads/[name]/route");
  const avatarRequest = new Request(`http://127.0.0.1${later.url}`);
  const context = { params: Promise.resolve({ name: later.filename }) };
  expect((await avatarRoute.GET(avatarRequest, context)).status).toBe(200);

  const staged = await staging.stageBackupRecordStream(sourceOf(Buffer.concat(chunks)), db);
  try {
    restoreAllData(staged, false);
  } finally {
    staged.dispose();
  }

  expect(fs.existsSync(path.join(UPLOADS_DIR, later.filename))).toBe(false);
  expect((await avatarRoute.GET(avatarRequest, context)).status).toBe(404);
  const next: Buffer[] = [];
  for await (const chunk of records.createBackupRecordStream(db)) next.push(Buffer.from(chunk));
  const manifest = JSON.parse(Buffer.concat(next).toString("utf8").split("\n")[0]!) as { files: { name: string }[] };
  expect(manifest.files.map((file) => file.name)).not.toContain(later.filename);
});

it("恢复前快照同时保留数据库引用和原头像字节，供手动回退", async () => {
  const { saveUploadFile, UPLOADS_DIR } = await import("../upload-storage");
  const { exportAllData } = await import("./backup-fixture");
  const incoming = exportAllData();
  const original = await saveUploadFile(Buffer.from("original-avatar"), ".png");
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'恢复前简历','','')");
  db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,sort,content,updated_at) VALUES (1,'basic','basic',0,?,'')")
    .run(JSON.stringify({ avatar: original.url }));

  const result = await restorePayload(incoming, false);
  expect(fs.existsSync(path.join(UPLOADS_DIR, original.filename))).toBe(false);
  const snapshot = new DatabaseSync(result.snapshotCreated!, { readOnly: true });
  try {
    const row = snapshot.prepare("SELECT content FROM resume_modules WHERE type = 'basic'").get() as { content: string };
    expect(JSON.parse(row.content).avatar).toBe(original.url);
    expect(fs.readFileSync(path.join(`${result.snapshotCreated}.uploads`, original.filename)))
      .toEqual(Buffer.from("original-avatar"));
  } finally {
    snapshot.close();
  }
});

it("同名头像被恢复内容覆盖时，快照保留覆盖前的字节", async () => {
  const { saveUploadFile, UPLOADS_DIR } = await import("../upload-storage");
  const { defaultContent } = await import("../modules");
  const { exportAllData, restoreAllData } = await import("./backup-fixture");
  const { GET: getAvatar } = await import("@/app/api/uploads/[name]/route");
  const original = await saveUploadFile(Buffer.from("before-restore"), ".png");
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'恢复前简历','','')");
  db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,sort,content,updated_at) VALUES (1,'basic','basic',0,?,'')")
    .run(JSON.stringify({ ...defaultContent("basic"), avatar: original.url }));
  const avatarRequest = new Request(`http://127.0.0.1${original.url}`);
  const avatarContext = { params: Promise.resolve({ name: original.filename }) };
  const before = await getAvatar(avatarRequest, avatarContext);
  expect(Buffer.from(await before.arrayBuffer()).toString()).toBe("before-restore");
  expect(before.headers.get("Cache-Control")).toBe("private, no-store");
  const staged = await stagePayload(exportAllData());
  const replacement = Buffer.from("after-restore");
  const handle = {
    stats: staged.stats,
    sequences: staged.sequences,
    files: [{ name: original.filename, bytes: replacement.byteLength }],
    readTableBatch: staged.readTableBatch.bind(staged),
    readFileBytes: () => replacement,
  };
  try {
    const result = restoreAllData(handle, false);
    expect(fs.readFileSync(path.join(UPLOADS_DIR, original.filename))).toEqual(replacement);
    expect(fs.readFileSync(path.join(`${result.snapshotCreated}.uploads`, original.filename)))
      .toEqual(Buffer.from("before-restore"));
    const restoredContent = (db.prepare("SELECT content FROM resume_modules WHERE type='basic'").get() as { content: string }).content;
    const restoredUrl = (JSON.parse(restoredContent) as { avatar: string }).avatar;
    expect(restoredUrl.startsWith(`${original.url}?v=`)).toBe(true);
    expect(new URL(restoredUrl, "http://localhost").searchParams.get("v"))
      .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(restoredUrl).not.toBe(original.url);
    expect((JSON.parse((db.prepare("SELECT content FROM resume_modules WHERE type='basic'").get() as { content: string }).content) as { avatar: string }).avatar)
      .toBe(restoredUrl);
    const { uploadPathFromUrl } = await import("../upload-storage");
    expect(uploadPathFromUrl(restoredUrl)).toBe(path.join(UPLOADS_DIR, original.filename));
    const { createBackupRecordStream } = await import("../backup-records");
    const exported: Buffer[] = [];
    for await (const chunk of createBackupRecordStream(db)) exported.push(Buffer.from(chunk));
    const manifest = JSON.parse(Buffer.concat(exported).toString("utf8").split("\n")[0]!) as { files: { name: string }[] };
    expect(manifest.files.map((file) => file.name)).toContain(original.filename);
    const after = await getAvatar(avatarRequest, avatarContext);
    expect(Buffer.from(await after.arrayBuffer())).toEqual(replacement);
    expect(after.headers.get("Cache-Control")).toBe("private, no-store");
  } finally {
    staged.dispose();
  }
});

it("恢复提交失败时将已隔离的旧头像放回原位置", async () => {
  const { saveUploadFile, UPLOADS_DIR } = await import("../upload-storage");
  const { exportAllData, restoreAllData } = await import("./backup-fixture");
  const staged = await stagePayload(exportAllData());
  const later = await saveUploadFile(Buffer.from("private-old-avatar"), ".png");
  const originalExec = db.exec.bind(db);
  const spy = vi.spyOn(db, "exec").mockImplementation((sql) => {
    if (sql === "COMMIT") throw new Error("injected commit failure");
    return originalExec(sql);
  });
  try {
    expect(() => restoreAllData(staged, false)).toThrow("injected commit failure");
    expect(fs.readFileSync(path.join(UPLOADS_DIR, later.filename)).toString()).toBe("private-old-avatar");
  } finally {
    spy.mockRestore();
    staged.dispose();
  }
});

it("恢复成功但清单清理失败后，连续恢复和重启不会回滚较早的已提交头像", async () => {
  const { saveUploadFile, UPLOADS_DIR } = await import("../upload-storage");
  const { defaultContent } = await import("../modules");
  const { exportAllData, restoreAllData } = await import("./backup-fixture");
  const original = await saveUploadFile(Buffer.from("original-photo"), ".png");
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'连续恢复','','')");
  db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,sort,content,updated_at) VALUES (1,'basic','basic',0,?,'')")
    .run(JSON.stringify({ ...defaultContent("basic"), avatar: original.url }));
  const staged = await stagePayload(exportAllData());
  const handle = (text: string) => ({
    stats: staged.stats, sequences: staged.sequences,
    files: [{ name: original.filename, bytes: Buffer.byteLength(text) }],
    readTableBatch: staged.readTableBatch.bind(staged), readFileBytes: () => Buffer.from(text),
  });
  const remove = fs.rmSync.bind(fs);
  let failOnce = true;
  const spy = vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
    if (failOnce && path.basename(String(target)) === "manifest.json") {
      failOnce = false;
      throw Object.assign(new Error("synthetic manifest cleanup failure"), { code: "EACCES" });
    }
    return remove(target, options);
  });
  try {
    expect(restoreAllData(handle("first-restored-photo"), true).success).toBe(true);
  } finally { spy.mockRestore(); }
  try {
    expect(restoreAllData(handle("second-restored-photo"), true).success).toBe(true);
  } finally { staged.dispose(); }
  db.close();
  vi.resetModules();
  db = (await import("../db")).getDb();
  expect(fs.readFileSync(path.join(UPLOADS_DIR, original.filename), "utf8")).toBe("second-restored-photo");
  expect(fs.readdirSync(UPLOADS_DIR).filter(name => name.startsWith(".restore-"))).toEqual([]);
});

it("备份里缺失分块的截断头像被拒绝，不会静默恢复出半张图", async () => {
  const { saveUploadFile } = await import("../upload-storage");
  const { defaultContent } = await import("../modules");
  const records = await import("../backup-records");
  const staging = await import("../backup-staging");

  const big = await saveUploadFile(Buffer.alloc(1_500_000, 0x5a), ".png");
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'合成简历','','')");
  db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,sort,content,updated_at) VALUES (1,'basic','basic',0,?,'')")
    .run(JSON.stringify({ ...defaultContent("basic"), avatar: big.url }));
  const chunks: Buffer[] = [];
  for await (const chunk of records.createBackupRecordStream(db)) chunks.push(Buffer.from(chunk));
  const lines = Buffer.concat(chunks).toString("utf8").trimEnd().split("\n");
  // 丢掉该文件的最后一个分块：文件仍然「存在」，只是尾部缺失
  const kept = lines.filter((line) => {
    const record = JSON.parse(line) as { kind: string; name?: string; index?: number };
    return !(record.kind === "file" && record.name === big.filename && record.index === 1);
  });

  await expect(
    staging.stageBackupRecordStream(sourceOf(Buffer.from(`${kept.join("\n")}\n`, "utf8")), db),
  ).rejects.toThrow(/头像文件不完整/);
});

async function seedDomainRecords() {
  const { defaultContent, normalizeContent } = await import("../modules");
  const { DEFAULT_STYLE } = await import("../templates");
  const { normalizeHrMindset, normalizeMentorAnalysis, normalizeNegotiationReport } = await import("../salary-negotiation");
  const { normalizeJargonDecoderResult } = await import("../jargon-decoder");
  const { normalizeJdPortrait } = await import("../jd-portrait");
  const { normalizeRemedyResult } = await import("../career-gap-remedy");
  const { normalizeScannedDefenseItem } = await import("../resume-defense");
  const scores = { depth: 8, structure: 7, authenticity: 9, completeness: 8 };
  const insert = (table: string, values: Record<string, string | number | null>) => {
    const columns = Object.keys(values);
    db.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...Object.values(values));
  };
  insert("resumes", { id: 1, title: "备份简历", created_at: "", updated_at: "" });
  for (const [i, type] of (["basic", "education", "work", "projects", "skills", "summary"] as const).entries()) {
    const content = ["education", "work", "projects"].includes(type) ? normalizeContent(type, [{ id: "item_1" }]) : defaultContent(type);
    insert("resume_modules", { resume_id: 1, module_key: type, type, sort: i, content: JSON.stringify(content), updated_at: "" });
  }
  insert("interview_series", { id: 1, resume_id: 1, jd: "JD", final_report: JSON.stringify({ overall: 8, verdict: "可录用", strengths: "", weaknesses: "", suggestions: "" }), created_at: "" });
  insert("interviews", {
    id: 1, resume_id: 1, jd: "JD", created_at: "",
    report: JSON.stringify({ ...scores, jd_match: 8, overall: 8, strengths: "", weaknesses: "", suggestions: "" }),
    reverse_interview: JSON.stringify({ question: "职责？", answer: "开发", evaluation: { score: 8, level: "良好", insight: "", feedback: "", suggestions: "" }, created_at: "" }),
    evaluator_report: JSON.stringify({ recommendation: "Hire", level: "P6", level_justification: "足够", summary_for_hr: "可录用", hire_reasons: [], concerns_and_risks: [], placement_suggestion: "开发", evidence_quotes: [{ turn_idx: 1, topic: "项目", observation: "清晰" }] }),
  });
  insert("interview_turns", { id: 1, interview_id: 1, idx: 1, question: "项目？", scores: JSON.stringify(scores), retries: JSON.stringify([{ id: "retry_1", answer: "回答", scores: null, comment: "", created_at: "" }, { id: "retry_2", answer: "回答", scores, comment: "", reference: "参考", created_at: "" }]) });
  insert("drills", { id: 1, project_id: 1, created_at: "" });
  insert("drill_questions", { id: 1, drill_id: 1, idx: 1, question: "题目", scores: JSON.stringify(scores) });
  insert("notebook_entries", { id: 1, source: "drill", source_id: 1, question: "题目", scores: JSON.stringify(scores), created_at: "", updated_at: "" });
  insert("resume_diagnoses", { resume_id: 1, jd: "JD", resume_snapshot: JSON.stringify({ title: "简历", modules: [] }), report: JSON.stringify({ match: 8, summary: "", modules: [{ moduleKey: "skills", label: "技能", scores, gaps: "", suggestions: [{ itemId: "", field: "items", reason: "", draft: ["TypeScript"] }] }] }), created_at: "" });
  insert("intros", { id: 1, resume_id: 1, created_at: "" });
  insert("intro_versions", { intro_id: 1, kind: "30s", sentences: JSON.stringify([{ text: "我是工程师", comment: "" }]), updated_at: "" });
  insert("resume_templates", { name: "模板", style: JSON.stringify(DEFAULT_STYLE), created_at: "", updated_at: "" });
  insert("jd_portraits", { jd: "JD", result: JSON.stringify(normalizeJdPortrait({ role: "开发", must_skills: [1, 2, 3].map((i) => ({ name: `技能${i}`, weight: 7 })), followups: [{ topic: "项目", questions: ["职责？"] }], company_style: { style: "务实", signals: [] } })), created_at: "" });
  insert("jargon_decodings", { source_text: "抗压", result: JSON.stringify(normalizeJargonDecoderResult({ items: [{ keyword: "抗压", counter_questions: ["加班？"] }] })), created_at: "" });
  insert("salary_negotiations", { id: 1, target_company_tier: "top_tech", target_role: "开发", expected_salary: "30k", report: JSON.stringify(normalizeNegotiationReport({ final_package_summary: "30k", mentor_summary: "稳健", turn_critiques: [{ turn_no: 1, summary: "好", key_point: "筹码" }] })), created_at: "" });
  insert("salary_negotiation_turns", { negotiation_id: 1, turn_no: 1, hr_response: "报价", hr_mindset: JSON.stringify(normalizeHrMindset({})), mentor_analysis: JSON.stringify(normalizeMentorAnalysis({})), created_at: "" });
  insert("resume_defenses", { source_content: "简历", scanned_items: JSON.stringify([normalizeScannedDefenseItem({ original_text: "优化性能", deadly_questions: ["多少？"], defense_plan: { taboo_mistakes: ["夸大"] } })]), created_at: "" });
  insert("resignation_gap_remedies", { raw_story: "离职", result: JSON.stringify(normalizeRemedyResult({ drills: [{ question: "为什么？" }] })), created_at: "" });
}

it.each([false, true])("普通/挖掘报告 mining=%s 经真实备份流完整恢复", async (mining) => {
  await seedDomainRecords();
  const { normalizeReport } = await import("../scores");
  const report = normalizeReport({
    depth: 8, structure: 7, authenticity: 9, completeness: 8, jd_match: 8,
    strengths: "优点", weaknesses: "不足", suggestions: "建议",
    ...(mining ? { mining_summary: {
      project_name: "订单项目", background: "背景", actions: "行动", tradeoffs: "取舍",
      results: "结果", contribution: "贡献",
      pending_confirmations: [{ category: "指标", item: "吞吐量", source_hint: "待确认" }],
      resume_bullets: ["实现订单服务"],
    } } : {}),
  });
  db.prepare("UPDATE interviews SET report = ? WHERE id = 1").run(JSON.stringify(report));
  const records = await import("../backup-records");
  const chunks: Buffer[] = [];
  for await (const chunk of records.createBackupRecordStream(db)) chunks.push(Buffer.from(chunk));
  const { stageBackupRecordStream } = await import("../backup-staging");
  const staged = await stageBackupRecordStream(sourceOf(Buffer.concat(chunks)), db);
  try {
    db.prepare("UPDATE interviews SET report = '' WHERE id = 1").run();
    (await import("../backup")).restoreAllData(staged, true);
    const saved = db.prepare("SELECT report FROM interviews WHERE id = 1").get() as { report: string };
    expect(JSON.parse(saved.report)).toEqual(report);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    staged.dispose();
  }
});

it.each([
  { project_name: "项目" },
  { project_name: 42, background: "", actions: "", tradeoffs: "", results: "", contribution: "", pending_confirmations: [], resume_bullets: [] },
  { project_name: "", background: "", actions: "", tradeoffs: "", results: "", contribution: "", pending_confirmations: [{ category: "", item: 1, source_hint: "" }], resume_bullets: [] },
  { project_name: "", background: "", actions: "", tradeoffs: "", results: "", contribution: "", pending_confirmations: [], resume_bullets: [42] },
  { project_name: "", background: "", actions: "", tradeoffs: "", results: "", contribution: "", pending_confirmations: [], resume_bullets: [], unknown: "字段" },
])("备份仍拒绝畸形挖掘报告 %j", async (mining_summary) => {
  await seedDomainRecords();
  const saved = db.prepare("SELECT report FROM interviews WHERE id = 1").get() as { report: string };
  db.prepare("UPDATE interviews SET report = ? WHERE id = 1").run(JSON.stringify({ ...JSON.parse(saved.report), mining_summary }));
  const { createBackupRecordStream } = await import("../backup-records");
  const consume = async () => { for await (const chunk of createBackupRecordStream(db)) void chunk; };
  await expect(consume()).rejects.toThrow(/interviews.*report/);
});

const corruptFields: [string, string, (string | number)[], unknown][] = [
  ["resume_modules", "content", ["name"], 42],
  ["drill_questions", "scores", ["depth"], "8"],
  ["interview_turns", "scores", ["structure"], 11],
  ["notebook_entries", "scores", ["completeness"], []],
  ["interviews", "report", ["suggestions"], []],
  ["interviews", "reverse_interview", ["evaluation", "score"], "8"],
  ["interviews", "evaluator_report", ["evidence_quotes", 0, "observation"], 42],
  ["interview_turns", "retries", [1, "scores", "depth"], {}],
  ["interview_series", "final_report", ["verdict"], []],
  ["resume_diagnoses", "report", ["modules", 0, "suggestions", 0, "draft"], [42]],
  ["intro_versions", "sentences", [0, "comment"], {}],
  ["resume_templates", "style", ["entrySubAccent"], "true"],
  ["jd_portraits", "result", ["followups", 0, "questions"], [42]],
  ["jargon_decodings", "result", ["items", 0, "counterQuestions"], [null]],
  ["salary_negotiations", "report", ["turn_critiques", 0, "summary"], []],
  ["salary_negotiation_turns", "hr_mindset", ["looseness"], -1],
  ["salary_negotiation_turns", "mentor_analysis", ["suggested_replies", 0, "content"], {}],
  ["resume_defenses", "scanned_items", [0, "defensePlan", "tabooMistakes"], [42]],
  ["resignation_gap_remedies", "result", ["scripts", "concise", "keyPoints"], [false]],
];

it.each(corruptFields)("rejects nested corruption in %s.%s through preflight and restore", async (table, field, keys, badValue) => {
  await seedDomainRecords();
  const backup = await import("./backup-fixture");
  const original = backup.exportAllData();
  const payload = structuredClone(original);
  const row = payload.data[table]![0];
  payload.data.settings![0]!.model_question = "must-not-be-restored";
  const content = JSON.parse(row![field] as string);
  let target = content;
  for (const key of keys.slice(0, -1)) target = target[key];
  const lastKey = keys.at(-1)!;
  target[lastKey] = badValue;
  row![field] = JSON.stringify(content);
  await expect(validateStagedPayload(payload)).rejects.toThrow(new RegExp(`${table}.*1.*${field}`));
  expect(backup.exportAllData().data).toEqual(original.data);
  await expect(restorePayload(payload, false)).rejects.toThrow(new RegExp(`${table}.*1.*${field}`));
  expect(backup.exportAllData().data).toEqual(original.data);
  expect(fs.existsSync(path.join(directory, "backups"))).toBe(false);
});

it.each(["education", "work", "projects", "skills", "summary"])("validates resume module content by its %s type", async (type) => {
  await seedDomainRecords();
  const backup = await import("./backup-fixture");
  const payload = backup.exportAllData();
  const row = payload.data.resume_modules!.find((row) => row.type === type);
  row!.content = type === "skills" ? '{"items":[42]}' : type === "summary" ? '{"text":[]}' : '[{"id":"a","description":42}]';
  expect(backup.validateBackupPayload(payload).valid).toBe(false);
});

it("round-trips all generated domain formats, including camelCase and nullable retry scores", async () => {
  await seedDomainRecords();
  const backup = await import("./backup-fixture");
  const payload = backup.exportAllData();
  expect(backup.validateBackupPayload(payload)).toMatchObject({ valid: true });
  await restorePayload(payload, false);
  expect(backup.exportAllData().data).toEqual(payload.data);
});

it("flags corrupt project GET data while preserving the 404 for missing projects", async () => {
  db.exec(`UPDATE projects SET summary='{"overview":42}'`);
  const { GET } = await import("../../app/api/projects/[id]/route");
  const response = await GET(new Request("http://localhost/projects/1"), { params: Promise.resolve({ id: "1" }) });
  if (response.status === 200) expect((await response.json()).summary_corrupt).toBe(true);
  else expect(response.status).toBe(422);
  const { POST } = await import("../../app/api/drills/route");
  const missing = await POST(new Request("http://localhost/drills", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project_id: 99 }),
  }));
  expect(missing.status).toBe(404);
});

it.each(corruptFields)("rejects malformed JSON and scalar roots in %s.%s", async (table, field) => {
  await seedDomainRecords();
  const backup = await import("./backup-fixture");
  const payload = backup.exportAllData();
  for (const raw of ["{broken", "null", "42", '"text"']) {
    payload.data[table]![0]![field] = raw;
    const result = backup.validateBackupPayload(payload);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toMatch(new RegExp(`${table}.*1.*${field}`));
  }
});

it("round-trips exactly the empty states declared by each database JSON column", async () => {
  await seedDomainRecords();
  const backup = await import("./backup-fixture");
  const payload = backup.exportAllData();
  for (const [table, field] of corruptFields) {
    const column = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; dflt_value: string | null }[]).find((column) => column.name === field);
    if (column!.dflt_value === null) continue;
    const defaultValue = (db.prepare(`SELECT ${column!.dflt_value} AS value`).get() as { value: string }).value;
    for (const row of payload.data[table]!) row[field] = defaultValue;
  }
  expect(backup.validateBackupPayload(payload)).toMatchObject({ valid: true });
  await restorePayload(payload, false);
  expect(backup.exportAllData().data).toEqual(payload.data);
});

it.each(corruptFields.filter(([table]) => !["resume_modules", "salary_negotiation_turns"].includes(table)))("does not interpret an empty object as an ungenerated %s.%s", async (table, field) => {
  await seedDomainRecords();
  const backup = await import("./backup-fixture");
  const payload = backup.exportAllData();
  payload.data[table]![0]![field] = "{}";
  expect(backup.validateBackupPayload(payload).valid).toBe(false);
});
