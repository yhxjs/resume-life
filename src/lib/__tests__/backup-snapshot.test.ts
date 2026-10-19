import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let directory: string;
let backupDir: string;
let db: DatabaseSync;

beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-snapshot-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  backupDir = path.join(directory, "backups");
  fs.mkdirSync(backupDir, { recursive: true });
});

afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-snapshot-")) {
    throw new Error("Unsafe cleanup");
  }
  fs.rmSync(directory, { recursive: true, force: true });
});
const PREFIX = "resume-life.db.pre-restore-";


function snapshotFiles(): string[] {
  return fs.readdirSync(backupDir).filter((name) => name.startsWith(PREFIX));
}

it("VACUUM INTO 中途失败会清理本次半成品快照", async () => {
  const existing = path.join(backupDir, `${PREFIX}existing`);
  fs.writeFileSync(existing, "existing snapshot");
  const originalPrepare = DatabaseSync.prototype.prepare;
  const prepareSpy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql: string) {
    const statement = originalPrepare.call(this, sql);
    if (sql !== "VACUUM INTO ?") return statement;
    return new Proxy(statement, {
      get(target, property) {
        if (property === "run") return (destination: string) => {
          fs.writeFileSync(destination, "incomplete snapshot");
          throw new Error("synthetic VACUUM failure");
        };
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  });
  try {
    const { createPreRestoreSnapshot } = await import("../backup-snapshot");
    expect(() => createPreRestoreSnapshot()).toThrow("synthetic VACUUM failure");
  } finally {
    prepareSpy.mockRestore();
  }
  expect(snapshotFiles()).toEqual([path.basename(existing)]);
  expect(fs.readFileSync(existing, "utf8")).toBe("existing snapshot");
});

it("复制头像失败时同时清理半成品数据库与头像目录", async () => {
  const { saveUploadFile } = await import("../upload-storage");
  const avatar = await saveUploadFile(Buffer.from("avatar"), ".png");
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'快照','','')");
  db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,sort,content,updated_at) VALUES (1,'basic','basic',0,?,'')")
    .run(JSON.stringify({ avatar: avatar.url }));
  const originalWrite = fs.writeFileSync.bind(fs);
  const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementation(((target: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: unknown) => {
    if (String(target).includes(".uploads")) {
      originalWrite(target, data, options as fs.WriteFileOptions);
      throw new Error("synthetic avatar copy failure");
    }
    return originalWrite(target, data, options as fs.WriteFileOptions);
  }) as typeof fs.writeFileSync);
  try {
    const { createPreRestoreSnapshot } = await import("../backup-snapshot");
    expect(() => createPreRestoreSnapshot()).toThrow("synthetic avatar copy failure");
  } finally {
    writeSpy.mockRestore();
  }
  expect(snapshotFiles()).toEqual([]);
});

it("已引用头像读取失败时取消快照，而真正缺失的头像允许跳过", async () => {
  const { saveUploadFile } = await import("../upload-storage");
  const avatar = await saveUploadFile(Buffer.from("avatar"), ".png");
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'快照','','')");
  db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,sort,content,updated_at) VALUES (1,'basic','basic',0,?,'')")
    .run(JSON.stringify({ avatar: avatar.url }));

  const originalRead = fs.readFileSync.bind(fs);
  const readSpy = vi.spyOn(fs, "readFileSync").mockImplementation(((target: fs.PathOrFileDescriptor, options?: unknown) => {
    if (String(target).endsWith(avatar.filename)) {
      throw Object.assign(new Error("synthetic avatar read failure"), { code: "EACCES" });
    }
    return originalRead(target, options as BufferEncoding);
  }) as typeof fs.readFileSync);
  try {
    const { createPreRestoreSnapshot } = await import("../backup-snapshot");
    expect(() => createPreRestoreSnapshot()).toThrow("synthetic avatar read failure");
  } finally {
    readSpy.mockRestore();
  }
  expect(snapshotFiles()).toEqual([]);

  fs.unlinkSync(path.join(directory, "uploads", avatar.filename));
  const { createPreRestoreSnapshot } = await import("../backup-snapshot");
  const snapshot = createPreRestoreSnapshot();
  expect(fs.existsSync(snapshot.path)).toBe(true);
  expect(fs.readdirSync(`${snapshot.path}.uploads`)).toEqual([]);
});

it("丢弃快照时数据库删除失败仍保留配套头像供下轮轮转", async () => {
  const { saveUploadFile } = await import("../upload-storage");
  const avatar = await saveUploadFile(Buffer.from("private-avatar"), ".png");
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'快照','','')");
  db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,sort,content,updated_at) VALUES (1,'basic','basic',0,?,'')")
    .run(JSON.stringify({ avatar: avatar.url }));
  const { createPreRestoreSnapshot, discardFailedPreRestoreSnapshot, rotatePreRestoreSnapshots } = await import("../backup-snapshot");
  const created = createPreRestoreSnapshot();
  const current = createPreRestoreSnapshot();
  const identity = fs.lstatSync(created.path, { bigint: true });
  const originalLstat = fs.lstatSync.bind(fs);
  const originalUnlink = fs.unlinkSync.bind(fs);
  const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation((target) => {
    const stats = originalLstat(target, { bigint: true });
    if (stats.dev === identity.dev && stats.ino === identity.ino) {
      throw new Error("synthetic snapshot delete failure");
    }
    return originalUnlink(target);
  });
  const logSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    expect(() => discardFailedPreRestoreSnapshot(created)).toThrow("synthetic snapshot delete failure");
    rotatePreRestoreSnapshots(db, current.path);
  } finally {
    unlinkSpy.mockRestore();
    logSpy.mockRestore();
  }

  const surviving = fs.readdirSync(backupDir)
    .map((name) => path.join(backupDir, name))
    .find((file) => {
      const stats = fs.lstatSync(file, { bigint: true });
      return stats.isFile() && stats.dev === identity.dev && stats.ino === identity.ino;
    });
  expect(surviving).toBeDefined();
  expect(fs.readFileSync(path.join(`${surviving}.uploads`, avatar.filename)).toString()).toBe("private-avatar");
});

it("轮转旧快照时同步清理其头像目录", async () => {
  const snapshots = Array.from({ length: 6 }, (_, index) => {
    const file = path.join(backupDir, `${PREFIX}${index}`);
    fs.writeFileSync(file, `snapshot-${index}`);
    fs.mkdirSync(`${file}.uploads`);
    fs.writeFileSync(path.join(`${file}.uploads`, "avatar.png"), `avatar-${index}`);
    const modifiedAt = new Date(Date.now() - (6 - index) * 1000);
    fs.utimesSync(file, modifiedAt, modifiedAt);
    return file;
  });
  const { rotatePreRestoreSnapshots } = await import("../backup-snapshot");
  rotatePreRestoreSnapshots(db, snapshots[5]!);
  expect(fs.existsSync(snapshots[0]!)).toBe(false);
  expect(fs.existsSync(`${snapshots[0]}.uploads`)).toBe(false);
  expect(fs.existsSync(`${snapshots[5]}.uploads`)).toBe(true);
});

it("头像隔离和硬链接恢复失败时仍把旧数据库放回头像旁", async () => {
  const snapshots = Array.from({ length: 6 }, (_, index) => {
    const file = path.join(backupDir, `${PREFIX}${index}`);
    fs.writeFileSync(file, `snapshot-${index}`);
    fs.mkdirSync(`${file}.uploads`);
    fs.writeFileSync(path.join(`${file}.uploads`, "avatar.png"), `avatar-${index}`);
    const modifiedAt = new Date(Date.now() - (6 - index) * 1000);
    fs.utimesSync(file, modifiedAt, modifiedAt);
    return file;
  });
  const oldest = snapshots[0]!;
  const originalRename = fs.renameSync.bind(fs);
  const originalLink = fs.linkSync.bind(fs);
  const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(from) === `${oldest}.uploads`) throw Object.assign(new Error("locked avatar"), { code: "EACCES" });
    return originalRename(from, to);
  });
  const linkSpy = vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
    if (String(to) === oldest) throw Object.assign(new Error("hard links unsupported"), { code: "ENOTSUP" });
    return originalLink(from, to);
  });
  const logSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const { rotatePreRestoreSnapshots } = await import("../backup-snapshot");
    rotatePreRestoreSnapshots(db, snapshots[5]!);
  } finally {
    renameSpy.mockRestore();
    linkSpy.mockRestore();
    logSpy.mockRestore();
  }
  expect(fs.existsSync(oldest)).toBe(true);
  expect(fs.readFileSync(path.join(`${oldest}.uploads`, "avatar.png"), "utf8")).toBe("avatar-0");
});

it("旧数据库无法放回原位时，下一轮保留与隔离数据库配套的头像", async () => {
  const snapshots = Array.from({ length: 6 }, (_, index) => {
    const file = path.join(backupDir, `${PREFIX}${index}`);
    fs.writeFileSync(file, `snapshot-${index}`);
    fs.mkdirSync(`${file}.uploads`);
    fs.writeFileSync(path.join(`${file}.uploads`, "avatar.png"), `avatar-${index}`);
    const modifiedAt = new Date(Date.now() - (6 - index) * 1000);
    fs.utimesSync(file, modifiedAt, modifiedAt);
    return file;
  });
  const oldest = snapshots[0]!;
  const originalRename = fs.renameSync.bind(fs);
  const originalLink = fs.linkSync.bind(fs);
  const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    if (String(from) === `${oldest}.uploads` ||
        (String(from).includes("quarantine-") && String(to) === oldest)) {
      throw Object.assign(new Error("snapshot path locked"), { code: "EACCES" });
    }
    return originalRename(from, to);
  });
  const linkSpy = vi.spyOn(fs, "linkSync").mockImplementation((from, to) => {
    if (String(to) === oldest) throw Object.assign(new Error("hard links unsupported"), { code: "ENOTSUP" });
    return originalLink(from, to);
  });
  const logSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const { rotatePreRestoreSnapshots } = await import("../backup-snapshot");
  try {
    rotatePreRestoreSnapshots(db, snapshots[5]!);
  } finally {
    renameSpy.mockRestore();
    linkSpy.mockRestore();
    logSpy.mockRestore();
  }
  expect(fs.existsSync(oldest)).toBe(false);
  expect(fs.existsSync(`${oldest}.uploads`)).toBe(true);
  const quarantined = snapshotFiles().find((name) => name.startsWith(`${path.basename(oldest)}.quarantine-`));
  expect(quarantined).toBeDefined();
  rotatePreRestoreSnapshots(db, snapshots[5]!);
  expect(fs.existsSync(path.join(backupDir, quarantined!))).toBe(true);
  expect(fs.readFileSync(path.join(`${oldest}.uploads`, "avatar.png"), "utf8")).toBe("avatar-0");
});

it("头像删除失败后下一轮仍会发现并清理孤立目录", async () => {
  const snapshots = Array.from({ length: 6 }, (_, index) => {
    const file = path.join(backupDir, `${PREFIX}${index}`);
    fs.writeFileSync(file, `snapshot-${index}`);
    fs.mkdirSync(`${file}.uploads`);
    fs.writeFileSync(path.join(`${file}.uploads`, "avatar.png"), `avatar-${index}`);
    const modifiedAt = new Date(Date.now() - (6 - index) * 1000);
    fs.utimesSync(file, modifiedAt, modifiedAt);
    return file;
  });
  const originalUnlink = fs.unlinkSync.bind(fs);
  let failOnce = true;
  const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation((target) => {
    if (failOnce && String(target).includes(".uploads") && path.basename(String(target)) === "avatar.png") {
      failOnce = false;
      throw Object.assign(new Error("synthetic avatar deletion failure"), { code: "EACCES" });
    }
    return originalUnlink(target);
  });
  const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const { rotatePreRestoreSnapshots } = await import("../backup-snapshot");
    rotatePreRestoreSnapshots(db, snapshots[5]!);
    expect(fs.existsSync(snapshots[0]!)).toBe(false);
    expect(fs.readdirSync(backupDir).filter((name) => name.endsWith(".uploads"))).toHaveLength(6);
    unlinkSpy.mockRestore();
    rotatePreRestoreSnapshots(db, snapshots[5]!);
    expect(fs.readdirSync(backupDir).filter((name) => name.endsWith(".uploads"))).toHaveLength(5);
  } finally {
    unlinkSpy.mockRestore();
    logSpy.mockRestore();
  }
});

it("孤立头像暂时无法删除时仍计入轮转字节预算", async () => {
  const orphan = path.join(backupDir, `${PREFIX}orphan.uploads`);
  fs.mkdirSync(orphan);
  fs.writeFileSync(path.join(orphan, "avatar.png"), "avatar");
  const old = path.join(backupDir, `${PREFIX}old`);
  const current = path.join(backupDir, `${PREFIX}current`);
  fs.writeFileSync(old, "old");
  fs.writeFileSync(current, "current");
  fs.utimesSync(old, new Date(Date.now() - 10_000), new Date(Date.now() - 10_000));

  const originalLstat = fs.lstatSync.bind(fs);
  const lstatSpy = vi.spyOn(fs, "lstatSync").mockImplementation(((target: fs.PathLike, options?: object) => {
    const stats = originalLstat(target, options as { bigint: true });
    if (String(target).includes(".uploads") && path.basename(String(target)) === "avatar.png" && typeof stats.size === "bigint") {
      return Object.assign(stats, { size: BigInt(300 * 1024 * 1024) });
    }
    return stats;
  }) as typeof fs.lstatSync);
  const originalUnlink = fs.unlinkSync.bind(fs);
  const unlinkSpy = vi.spyOn(fs, "unlinkSync").mockImplementation((target) => {
    if (String(target).includes(".uploads") && path.basename(String(target)) === "avatar.png") {
      throw Object.assign(new Error("synthetic avatar deletion failure"), { code: "EACCES" });
    }
    return originalUnlink(target);
  });
  const logSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const { rotatePreRestoreSnapshots } = await import("../backup-snapshot");
    rotatePreRestoreSnapshots(db, current);
  } finally {
    lstatSpy.mockRestore();
    unlinkSpy.mockRestore();
    logSpy.mockRestore();
  }
  expect(fs.existsSync(old)).toBe(false);
  expect(fs.existsSync(current)).toBe(true);
  expect(fs.readdirSync(backupDir).some((name) => name.endsWith(".uploads"))).toBe(true);
});

it("隔离数据库配套的头像仍计入轮转字节预算", async () => {
  const quarantined = path.join(backupDir, `${PREFIX}failed.quarantine-test`);
  const old = path.join(backupDir, `${PREFIX}old`);
  const current = path.join(backupDir, `${PREFIX}current`);
  fs.writeFileSync(quarantined, "isolated");
  fs.mkdirSync(`${quarantined}.uploads`);
  const avatar = path.join(`${quarantined}.uploads`, "avatar.png");
  fs.writeFileSync(avatar, "avatar");
  fs.writeFileSync(old, "old");
  fs.writeFileSync(current, "current");
  fs.utimesSync(old, new Date(Date.now() - 10_000), new Date(Date.now() - 10_000));

  const originalLstat = fs.lstatSync.bind(fs);
  const lstatSpy = vi.spyOn(fs, "lstatSync").mockImplementation(((target: fs.PathLike, options?: object) => {
    const stats = originalLstat(target, options as { bigint: true });
    if (String(target) === avatar && typeof stats.size === "bigint") {
      return Object.assign(stats, { size: BigInt(300 * 1024 * 1024) });
    }
    return stats;
  }) as typeof fs.lstatSync);
  try {
    const { rotatePreRestoreSnapshots } = await import("../backup-snapshot");
    rotatePreRestoreSnapshots(db, current);
  } finally {
    lstatSpy.mockRestore();
  }
  expect(fs.existsSync(old)).toBe(false);
  expect(fs.existsSync(quarantined)).toBe(true);
  expect(fs.existsSync(avatar)).toBe(true);
});

it("头像字节计入快照预算，超限时先删除旧快照及其头像", async () => {
  const old = path.join(backupDir, `${PREFIX}old`);
  const current = path.join(backupDir, `${PREFIX}current`);
  for (const snapshot of [old, current]) {
    fs.writeFileSync(snapshot, "db");
    fs.mkdirSync(`${snapshot}.uploads`);
    fs.writeFileSync(path.join(`${snapshot}.uploads`, "avatar.png"), "avatar");
  }
  const older = new Date(Date.now() - 10_000);
  fs.utimesSync(old, older, older);
  const largeFiles = new Set([old, current].map((snapshot) => path.join(`${snapshot}.uploads`, "avatar.png")));
  const originalLstat = fs.lstatSync.bind(fs);
  const lstatSpy = vi.spyOn(fs, "lstatSync").mockImplementation(((target: fs.PathLike, options?: object) => {
    const stats = originalLstat(target, options as { bigint: true });
    if (largeFiles.has(String(target)) && typeof stats.size === "bigint") {
      return Object.assign(stats, { size: BigInt(150 * 1024 * 1024) });
    }
    return stats;
  }) as typeof fs.lstatSync);
  try {
    const { rotatePreRestoreSnapshots } = await import("../backup-snapshot");
    rotatePreRestoreSnapshots(db, current);
  } finally {
    lstatSpy.mockRestore();
  }
  expect(fs.existsSync(old)).toBe(false);
  expect(fs.existsSync(`${old}.uploads`)).toBe(false);
  expect(fs.existsSync(current)).toBe(true);
});
