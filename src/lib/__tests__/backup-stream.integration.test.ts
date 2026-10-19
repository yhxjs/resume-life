import { normalizeContent } from "@/lib/modules";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-backup-stream-test-"));
process.env.RESUME_LIFE_DATA_DIR = TEST_DATA_DIR;

let backup: typeof import("@/lib/backup");
let container: typeof import("@/lib/backup-container");
let databaseModule: typeof import("@/lib/db");
let limits: typeof import("@/lib/backup-limits");
let records: typeof import("@/lib/backup-records");
let staging: typeof import("@/lib/backup-staging");
let stagingStorage: typeof import("@/lib/backup-staging-storage");
let sourceDatabase: DatabaseSync;
let routeDatabase: DatabaseSync;
let databaseSequence = 0;

const ROUTE_PASSWORD = "correct horse battery staple";

type JsonRecord = Record<string, unknown>;

type CleanupFailure = {
  operation: string;
  target: string;
  message: string;
};

type ErrorWithCleanupFailures = Error & {
  cleanupFailures?: CleanupFailure[];
};

async function* chunksOf(buffer: Uint8Array, widths = [1, 2, 7, 3, 11, 5, 13]): AsyncIterable<Uint8Array> {
  let offset = 0;
  let index = 0;
  while (offset < buffer.byteLength) {
    const width = widths[index % widths.length];
    yield buffer.subarray(offset, Math.min(offset + width!, buffer.byteLength));
    offset += width!;
    index += 1;
  }
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const output: Buffer[] = [];
  for await (const chunk of source) output.push(Buffer.from(chunk));
  return Buffer.concat(output);
}

async function postExport(
  password = ROUTE_PASSWORD,
  confirmation: unknown = password,
  headers: Record<string, string> = {},
): Promise<Response> {
  return postExportPayload({ password, confirmation }, headers);
}

function backupRoute(name: "export" | "validate" | "restore") {
  if (name === "export") return import("@/app/api/backup/export/route");
  if (name === "validate") return import("@/app/api/backup/validate/route");
  return import("@/app/api/backup/restore/route");
}

async function postExportPayload(
  input: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const route = await import("@/app/api/backup/export/route") as unknown as {
    POST(request: Request): Promise<Response>;
  };
  return route.POST(new Request("http://localhost/api/backup/export", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(input),
  }));
}

function encryptedUploadRequest(
  pathname: "validate" | "restore",
  body: BodyInit | Uint8Array,
  password = ROUTE_PASSWORD,
  headers: Record<string, string> = {},
): Request {
  return new Request(`http://localhost/api/backup/${pathname}`, {
    method: "POST",
    headers: {
      "X-Resume-Life-Backup-Password": container.encodeBackupPasswordHeader(password),
      ...headers,
    },
    body: body as BodyInit,
  });
}

function streamedEncryptedUploadRequest(
  pathname: "validate" | "restore",
  body: ReadableStream<Uint8Array>,
  headers: Record<string, string> = {},
): Request {
  return {
    body,
    headers: new Headers({
      "X-Resume-Life-Backup-Password": container.encodeBackupPasswordHeader(ROUTE_PASSWORD),
      ...headers,
    }),
    url: `http://localhost/api/backup/${pathname}`,
    method: "POST",
  } as Request;
}

function uploadBodyWithReleaseFailure(
  bytes: Uint8Array,
  releaseError: Error,
  onRelease: () => void = () => undefined,
): ReadableStream<Uint8Array> {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const getReader = body.getReader.bind(body);
  Object.defineProperty(body, "getReader", {
    configurable: true,
    value() {
      const reader = getReader();
      return new Proxy(reader, {
        get(target, property) {
          if (property === "releaseLock") {
            return () => {
              target.releaseLock();
              onRelease();
              throw releaseError;
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  });
  return body;
}

type ControlledCancelUpload = {
  body: ReadableStream<Uint8Array>;
  cancel: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
  cancelStarted: Promise<void>;
  releaseCancel(): void;
};

function controlledCancelUpload(
  bytes: Uint8Array,
  options: {
    cancelError?: Error;
    releaseError?: Error;
    closeAfterEnqueue?: boolean;
  } = {},
): ControlledCancelUpload {
  let markCancelStarted!: () => void;
  let releaseCancel!: () => void;
  const cancelStarted = new Promise<void>((resolve) => { markCancelStarted = resolve; });
  const cancelReleased = new Promise<void>((resolve) => { releaseCancel = resolve; });
  const cancel = vi.fn(async () => {
    markCancelStarted();
    await cancelReleased;
    if (options.cancelError) throw options.cancelError;
  });
  const read = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      if (options.closeAfterEnqueue !== false) controller.close();
    },
    cancel,
  });
  const getReader = body.getReader.bind(body);
  Object.defineProperty(body, "getReader", {
    configurable: true,
    value() {
      const reader = getReader();
      return new Proxy(reader, {
        get(target, property) {
          if (property === "read") {
            return async () => {
              read();
              return target.read();
            };
          }
          if (property === "releaseLock") {
            return () => {
              target.releaseLock();
              if (options.releaseError) throw options.releaseError;
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  });
  return { body, cancel, read, cancelStarted, releaseCancel };
}

async function expectRouteAwaitsUploadCancel(
  responsePromise: Promise<Response>,
  upload: ControlledCancelUpload,
  expectedStatus: number,
  expectedReadCalls = 0,
): Promise<Response> {
  let responseSettled = false;
  const trackedResponse = responsePromise.then((response) => {
    responseSettled = true;
    return response;
  });
  const first = await Promise.race([
    upload.cancelStarted.then(() => "cancel" as const),
    trackedResponse.then(() => "response" as const),
  ]);
  const settledBeforeRelease = responseSettled;
  const lockedBeforeRelease = upload.body.locked;
  const cancelCallsBeforeRelease = upload.cancel.mock.calls.length;

  upload.releaseCancel();
  const response = await trackedResponse;
  if (first === "response" && !upload.body.locked) await upload.body.cancel();

  expect(first).toBe("cancel");
  expect(settledBeforeRelease).toBe(false);
  expect(lockedBeforeRelease).toBe(true);
  expect(cancelCallsBeforeRelease).toBe(1);
  expect(response.status).toBe(expectedStatus);
  expect(upload.cancel).toHaveBeenCalledOnce();
  expect(upload.read).toHaveBeenCalledTimes(expectedReadCalls);
  expect(upload.body.locked).toBe(false);
  return response;
}

function observeExportConnection(): {
  assertQueryOnlyAndClosed(): void;
  restore(): void;
} {
  const originalExec = DatabaseSync.prototype.exec;
  const originalClose = DatabaseSync.prototype.close;
  const connections = new WeakSet<DatabaseSync>();
  let connectionCount = 0;
  let connectionWasRouteDatabase = false;
  let queryOnly: unknown;
  let closeCalls = 0;
  const execSpy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
    const result = originalExec.call(this, sql);
    if (sql === "PRAGMA query_only = ON") {
      if (!connections.has(this)) connectionCount += 1;
      connections.add(this);
      connectionWasRouteDatabase ||= this === routeDatabase;
      queryOnly = this.prepare("PRAGMA query_only").get();
    }
    return result;
  });
  const closeSpy = vi.spyOn(DatabaseSync.prototype, "close").mockImplementation(function (this: DatabaseSync) {
    if (connections.has(this)) closeCalls += 1;
    return originalClose.call(this);
  });
  return {
    assertQueryOnlyAndClosed() {
      expect(connectionCount).toBe(1);
      expect(connectionWasRouteDatabase).toBe(false);
      expect(queryOnly).toEqual({ query_only: 1 });
      expect(closeCalls).toBe(1);
    },
    restore() {
      closeSpy.mockRestore();
      execSpy.mockRestore();
    },
  };
}

async function routeBackupBytes(): Promise<Buffer> {
  const response = await postExport();
  expect(response.status).toBe(200);
  return Buffer.from(await response.arrayBuffer());
}

function clearAndSeedRouteDatabase(): void {
  routeDatabase.exec("PRAGMA foreign_keys = OFF");
  routeDatabase.exec("BEGIN");
  try {
    for (const table of backup.TABLES_CLEAR_ORDER) routeDatabase.prepare(`DELETE FROM "${table}"`).run();
    routeDatabase.prepare(
      "INSERT INTO settings (id, base_url, api_key, updated_at) VALUES (1, 'https://backup.invalid', 'sk-backup-sentinel', '')",
    ).run();
    routeDatabase.prepare(
      "INSERT INTO resumes (id, title, template, created_at, updated_at) VALUES (1, 'sk-backup-sentinel', 'classic', '', '')",
    ).run();
    routeDatabase.exec("DELETE FROM sqlite_sequence");
    routeDatabase.exec("COMMIT");
  } catch (error) {
    routeDatabase.exec("ROLLBACK");
    throw error;
  } finally {
    routeDatabase.exec("PRAGMA foreign_keys = ON");
  }
}

function recreateTable(table: string, createSql: string): void {
  const schemaObjects = routeDatabase.prepare("SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index', 'trigger') AND sql IS NOT NULL").all(table) as { sql: string }[];
  const tableIdentifier = `"${table.replaceAll('"', '""')}"`;
  const backupIdentifier = `"__${table.replaceAll('"', '""')}_schema_backup"`;
  const sourceColumns = (routeDatabase.prepare(`PRAGMA table_info(${tableIdentifier})`).all() as Array<{ name: string }>)
    .map(({ name }) => name);
  routeDatabase.exec("PRAGMA foreign_keys = OFF");
  routeDatabase.exec("PRAGMA legacy_alter_table = ON");
  routeDatabase.exec("BEGIN");
  try {
    routeDatabase.exec(`ALTER TABLE ${tableIdentifier} RENAME TO ${backupIdentifier}`);
    routeDatabase.exec(createSql);
    const targetColumns = new Set(
      (routeDatabase.prepare(`PRAGMA table_info(${tableIdentifier})`).all() as Array<{ name: string }>)
        .map(({ name }) => name),
    );
    const columns = sourceColumns
      .filter((name) => targetColumns.has(name))
      .map((name) => `"${name.replaceAll('"', '""')}"`)
      .join(", ");
    routeDatabase.exec(`INSERT INTO ${tableIdentifier} (${columns}) SELECT ${columns} FROM ${backupIdentifier}`);
    routeDatabase.exec(`DROP TABLE ${backupIdentifier}`);
    for (const { sql } of schemaObjects) routeDatabase.exec(sql);
    routeDatabase.exec("COMMIT");
  } catch (error) {
    routeDatabase.exec("ROLLBACK");
    throw error;
  } finally {
    routeDatabase.exec("PRAGMA legacy_alter_table = OFF");
    routeDatabase.exec("PRAGMA foreign_keys = ON");
  }
}

function recreateSettingsTable(createSql: string): void {
  recreateTable("settings", createSql);
}

async function* sourceOf(...chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  yield* chunks;
}

function oversizedPlaintextChunk(): Uint8Array {
  const chunk = new Uint8Array(0);
  Object.defineProperty(chunk, "byteLength", {
    get: () => 4_294_967_297,
  });
  return chunk;
}

async function* injectAfterFirstChunk(
  source: AsyncIterable<Uint8Array>,
  injected: Uint8Array,
): AsyncIterable<Uint8Array> {
  let injectedChunk = false;
  for await (const chunk of source) {
    yield chunk;
    if (!injectedChunk) {
      injectedChunk = true;
      yield injected;
    }
  }
}

async function* oneByteChunksWithEmpties(buffer: Uint8Array): AsyncIterable<Uint8Array> {
  yield new Uint8Array(0);
  for (let index = 0; index < buffer.byteLength; index += 1) {
    yield buffer.subarray(index, index + 1);
    if (index % 17 === 0) yield new Uint8Array(0);
  }
  yield new Uint8Array(0);
}

async function captureError(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error("expected action to reject");
}

async function expectSanitizedServerError(
  response: Response,
  consoleCalls: unknown[][],
  forbiddenValues: readonly string[],
): Promise<void> {
  expect(response.status).toBe(500);
  expect(response.headers.get("Cache-Control")).toContain("no-store");
  const responseText = await response.text();
  const payload = JSON.parse(responseText) as { requestId?: unknown };
  const logs = JSON.stringify(consoleCalls);
  for (const forbidden of forbiddenValues) {
    expect(responseText).not.toContain(forbidden);
    expect(logs).not.toContain(forbidden);
  }
  expect(payload.requestId).toEqual(expect.stringMatching(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
  ));
  expect(logs).toContain(payload.requestId as string);
}

function seedSourceDatabase(database: DatabaseSync): void {
  database.exec("BEGIN");
  try {
    database.prepare(
      "INSERT INTO settings (id, base_url, api_key, updated_at) VALUES (1, 'https://backup.invalid', 'sk-backup-sentinel', '')",
    ).run();
    const insertResume = database.prepare(
      "INSERT INTO resumes (title, template, created_at, updated_at) VALUES (?, 'classic', '', '')",
    );
    for (let index = 1; index <= 201; index += 1) {
      insertResume.run(index === 1 ? "sk-backup-sentinel" : `resume-${index}`);
    }
    database.prepare(
      "INSERT INTO resume_modules (resume_id, module_key, type, label, sort, content, updated_at) VALUES (1, 'summary', 'summary', '', 0, ?, '')",
    ).run(JSON.stringify(normalizeContent("summary", { text: "sk-backup-sentinel" })));
    const insertBankEntry = database.prepare(
      "INSERT INTO bank_entries (id, direction, kind, question, created_at) VALUES (?, '', 'tech', ?, '')",
    );
    insertBankEntry.run(-1, "负数行 中文😀");
    insertBankEntry.run(0, "零行 中文😀");
    insertBankEntry.run(1, "正数行 中文😀");
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

async function exportedBytes(): Promise<Buffer> {
  return collect(records.createBackupRecordStream(sourceDatabase, new Date("2026-09-17T00:00:00.000Z")));
}

async function exportedJsonRecords(): Promise<JsonRecord[]> {
  const text = (await exportedBytes()).toString("utf8");
  expect(text.endsWith("\n")).toBe(true);
  return text.trimEnd().split("\n").map((line) => JSON.parse(line) as JsonRecord);
}

function serializeJsonRecords(input: JsonRecord[]): Buffer {
  return Buffer.from(`${input.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
}

function restoreDirectories(): string[] {
  return fs.readdirSync(os.tmpdir(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("resume-life-restore-"))
    .map((entry) => entry.name)
    .sort();
}

function backupSnapshotFiles(): string[] {
  const directory = path.join(TEST_DATA_DIR, "backups");
  return fs.existsSync(directory) ? fs.readdirSync(directory).sort() : [];
}

async function expectRestoreDirectoriesToClear(): Promise<void> {
  // 只关心本次测试新产生的暂存目录：并行执行时其它测试文件也会在全局 tmpdir
  // 下创建同前缀目录，按「全量清空」断言会互相误判。
  const preexisting = new Set(restoreDirectories());
  await vi.waitFor(() => {
    expect(restoreDirectories().filter((name) => !preexisting.has(name))).toEqual([]);
  }, { timeout: 5_000, interval: 20 });
}

async function expectRejectedAndClean(source: AsyncIterable<Uint8Array>, message: RegExp): Promise<void> {
  const promise = staging.stageBackupRecordStream(source, sourceDatabase).then((result) => {
    result.dispose();
    return result;
  });
  await expect(promise).rejects.toThrow(message);
  await expectRestoreDirectoriesToClear();
}

async function expectLimitRejectedAndClean(source: AsyncIterable<Uint8Array>): Promise<void> {
  const promise = staging.stageBackupRecordStream(source, sourceDatabase).then((result) => {
    result.dispose();
    return result;
  });
  await expect(promise)
    .rejects.toBeInstanceOf(limits.BackupLimitError);
  await expectRestoreDirectoriesToClear();
}

async function expectAuthenticationRejectedAndClean(source: AsyncIterable<Uint8Array>): Promise<void> {
  const promise = staging.stageBackupRecordStream(source, sourceDatabase).then((result) => {
    result.dispose();
    return result;
  });
  await expect(promise).rejects.toBeInstanceOf(container.BackupAuthenticationError);
  await expectRestoreDirectoriesToClear();
}

function cloneRecords(input: JsonRecord[]): JsonRecord[] {
  return structuredClone(input) as JsonRecord[];
}

function endRecord(input: JsonRecord[]): { stats: Record<string, number>; totalRecords: number } {
  return input.at(-1) as unknown as { stats: Record<string, number>; totalRecords: number };
}

function firstRow(input: JsonRecord[], table: string): JsonRecord {
  const row = input.find((record) => record.kind === "row" && record.table === table);
  if (!row) throw new Error(`missing fixture row for ${table}`);
  return row;
}

function addRow(input: JsonRecord[], row: JsonRecord): void {
  input.splice(input.length - 1, 0, row);
  const end = endRecord(input);
  const table = row.table as string;
  end.stats[table]! += 1;
  end.totalRecords += 1;
}

beforeAll(async () => {
  [backup, container, databaseModule, limits, records, staging, stagingStorage] = await Promise.all([
    import("@/lib/backup"),
    import("@/lib/backup-container"),
    import("@/lib/db"),
    import("@/lib/backup-limits"),
    import("@/lib/backup-records"),
    import("@/lib/backup-staging"),
    import("@/lib/backup-staging-storage"),
  ]);
  routeDatabase = databaseModule.getDb();
});

beforeEach(() => {
  const databasePath = path.join(TEST_DATA_DIR, `source-${databaseSequence += 1}.db`);
  sourceDatabase = new DatabaseSync(databasePath);
  databaseModule.initializeDatabase(sourceDatabase);
  seedSourceDatabase(sourceDatabase);
});

afterEach(() => {
  sourceDatabase.close();
});

afterAll(() => {
  routeDatabase.close();
  const resolved = path.resolve(TEST_DATA_DIR);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("resume-life-backup-stream-test-")) {
    throw new Error("refusing to remove an unsafe test directory");
  }
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
  delete process.env.RESUME_LIFE_DATA_DIR;
});

describe("真实加密备份 Route Handler", () => {
  beforeEach(() => {
    clearAndSeedRouteDatabase();
  });

  it("三个入口在共享名额耗尽时返回 429，不创建导出连接或暂存", async () => {
    const budgets = await import("@/lib/shared-budgets");
    const token = budgets.acquireBackupLease({ maxConcurrent: 1, leaseMs: 60_000 });
    expect(token).not.toBeNull();
    const open = vi.spyOn(databaseModule, "openReadOnlyDatabase");
    const stage = vi.spyOn(staging, "stageBackupRecordStream");
    try {
      for (const name of ["export", "validate", "restore"] as const) {
        const route = await backupRoute(name);
        const response = await route.POST(new Request(`http://localhost/api/backup/${name}`, { method: "POST" }));
        expect(response.status).toBe(429);
        expect(response.headers.get("Retry-After")).toBe("1");
        expect(response.headers.get("Cache-Control")).toContain("no-store");
      }
      expect(open).not.toHaveBeenCalled();
      expect(stage).not.toHaveBeenCalled();
    } finally {
      open.mockRestore(); stage.mockRestore();
      if (token) budgets.releaseBackupLease(token);
    }
  });

  it("恢复在提交前预算失效时回滚数据和世代", async () => {
    const staged = await staging.stageBackupRecordStream(records.createBackupRecordStream(sourceDatabase), routeDatabase);
    const original = routeDatabase.prepare("SELECT title FROM resumes WHERE id = 1").get();
    const generation = routeDatabase.prepare("SELECT data_generation FROM runtime_state WHERE id = 1").get();
    const timeout = new (await import("@/lib/backup-operation")).BackupOperationError("test deadline", 408);
    const check = vi.fn().mockImplementationOnce(() => {}).mockImplementation(() => { throw timeout; });
    try {
      expect(() => backup.restoreAllData(staged, true, check)).toThrow(timeout);
      expect(check).toHaveBeenCalledTimes(2);
      expect(routeDatabase.prepare("SELECT title FROM resumes WHERE id = 1").get()).toEqual(original);
      expect(routeDatabase.prepare("SELECT data_generation FROM runtime_state WHERE id = 1").get()).toEqual(generation);
      expect(routeDatabase.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    } finally { staged.dispose(); }
  });

  it.each(["validate", "restore"] as const)("%s 停滞上传收到取消后清理暂存并释放名额", async (name) => {
    const route = await backupRoute(name);
    const controller = new AbortController();
    const cancel = vi.fn();
    let bodyController: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(value) { bodyController = value; }, cancel });
    const pending = route.POST(new Request(`http://localhost/api/backup/${name}`, {
      method: "POST", body, duplex: "half", signal: controller.signal,
      headers: { "X-Resume-Life-Backup-Password": container.encodeBackupPasswordHeader(ROUTE_PASSWORD) },
    } as RequestInit));
    await vi.waitFor(() => expect(body.locked).toBe(true));
    controller.abort();
    // 旧实现只认 EOF，主动结束以便失败测试也能清理隔离资源。
    await Promise.resolve();
    if (!cancel.mock.calls.length) bodyController!.close();
    const response = await pending;
    expect(response.status).toBe(499);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    await expectRestoreDirectoriesToClear();
    const next = await postExport();
    expect(next.status).toBe(200);
    await next.body?.cancel();
  });

  it("停止消费的导出在 idle 截止后退出快照事务，随后可再次导出", async () => {
    const connection = observeExportConnection();
    const response = await postExport();
    const reader = response.body!.getReader();
    try {
      await reader.read(); await reader.read();
      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await reader.read().then(() => null, (error: unknown) => error);
      expect(result).toMatchObject({ status: 408 });
      connection.assertQueryOnlyAndClosed();
    } finally {
      vi.useRealTimers();
      await reader.cancel().catch(() => undefined);
      reader.releaseLock(); connection.restore();
    }
    const next = await postExport();
    expect(next.status).toBe(200);
    await next.body?.cancel();
  });

  it("POST 流式导出加密容器并返回下载与禁缓存响应头", async () => {
    const connection = observeExportConnection();
    let encrypted: Buffer;
    try {
      const response = await postExport();

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe(container.BACKUP_MEDIA_TYPE);
      expect(response.headers.get("Content-Disposition")).toMatch(/\.rlbackup(?:"|;|$)/);
      expect(response.headers.get("Cache-Control")).toContain("no-store");

      encrypted = Buffer.from(await response.arrayBuffer());
      connection.assertQueryOnlyAndClosed();
    } finally {
      connection.restore();
    }
    expect(encrypted.includes(Buffer.from("sk-backup-sentinel", "utf8"))).toBe(false);
    const staged = await staging.stageBackupRecordStream(
      container.decryptBackupStream(ROUTE_PASSWORD, chunksOf(encrypted)),
      routeDatabase,
    );
    try {
      expect(staged.manifest.dbVersion).toBe(databaseModule.CURRENT_DB_VERSION);
      expect(staged.stats.resumes).toBe(1);
      expect(staged.readTableBatch("settings")[0]!.data.api_key).toBe("");
    } finally {
      staged.dispose();
    }
  });

  it("恢复时保留已删除源题的自增高水位并允许再次收藏", async () => {
    routeDatabase.prepare(
      "INSERT INTO interviews (id, resume_id, jd, created_at) VALUES (10, 1, '历史 JD', '')",
    ).run();
    routeDatabase.prepare(
      "INSERT INTO interview_turns (id, interview_id, idx, question) VALUES (20, 10, 1, '历史题')",
    ).run();
    routeDatabase.prepare(
      "INSERT INTO notebook_entries (source, source_id, question, created_at, updated_at) VALUES ('interview', 20, '历史题', '', '')",
    ).run();
    routeDatabase.prepare(
      "INSERT INTO notebook_entries (source, source_id, question, created_at, updated_at) VALUES ('application_interview', 40, '已删除复盘的错题', '', '')",
    ).run();
    routeDatabase.prepare("DELETE FROM interview_turns WHERE id = 20").run();
    routeDatabase.prepare("DELETE FROM interviews WHERE id = 10").run();

    const encrypted = await routeBackupBytes();
    const restoreRoute = await import("@/app/api/backup/restore/route");
    const response = await restoreRoute.POST(encryptedUploadRequest("restore", encrypted));
    expect(response.status).toBe(200);

    const newInterview = routeDatabase.prepare(
      "INSERT INTO interviews (resume_id, jd, created_at) VALUES (1, '新 JD', '')",
    ).run();
    const newInterviewId = Number(newInterview.lastInsertRowid);
    const newTurn = routeDatabase.prepare(
      "INSERT INTO interview_turns (interview_id, idx, question) VALUES (?, 1, '新题')",
    ).run(newInterviewId);
    const newTurnId = Number(newTurn.lastInsertRowid);
    expect(newInterviewId).toBeGreaterThan(10);
    expect(newTurnId).toBeGreaterThan(20);
    expect(routeDatabase.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'application_interview_recap_exports'").get())
      .toEqual({ seq: 40 });

    expect(() => routeDatabase.prepare(
      "INSERT INTO notebook_entries (source, source_id, question, created_at, updated_at) VALUES ('interview', ?, '新题', '', '')",
    ).run(newTurnId)).not.toThrow();
  });

  it("取消已开始的导出不会回滚同期间的正常业务写入并会关闭独立连接", async () => {
    const connection = observeExportConnection();
    try {
      const response = await postExport();
      const reader = response.body!.getReader();
      try {
        expect((await reader.read()).done).toBe(false);
        expect((await reader.read()).done).toBe(false);
        routeDatabase.prepare(
          "INSERT INTO projects (name, created_at, updated_at) VALUES ('concurrent-after-manifest', '', '')",
        ).run();
        await reader.cancel();
      } finally {
        reader.releaseLock();
      }

      expect(routeDatabase.prepare("SELECT name FROM projects WHERE name = 'concurrent-after-manifest'").get())
        .toEqual({ name: "concurrent-after-manifest" });
      connection.assertQueryOnlyAndClosed();
    } finally {
      connection.restore();
    }
  });

  it("导出快照不包含事务开始后的并发业务写入", async () => {
    const response = await postExport();
    const reader = response.body!.getReader();
    const encryptedChunks: Buffer[] = [];
    try {
      for (let index = 0; index < 2; index += 1) {
        const chunk = await reader.read();
        expect(chunk.done).toBe(false);
        encryptedChunks.push(Buffer.from(chunk.value!));
      }
      routeDatabase.prepare(
        "INSERT INTO projects (name, created_at, updated_at) VALUES ('snapshot-late-write', '', '')",
      ).run();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        encryptedChunks.push(Buffer.from(chunk.value));
      }
    } finally {
      reader.releaseLock();
    }

    const plaintext = await collect(container.decryptBackupStream(
      ROUTE_PASSWORD,
      chunksOf(Buffer.concat(encryptedChunks)),
    ));
    const exported = plaintext.toString("utf8").trimEnd().split("\n")
      .map((line) => JSON.parse(line) as JsonRecord);
    expect(exported.some((record) =>
      record.kind === "row" && record.table === "projects" &&
      (record.data as JsonRecord).name === "snapshot-late-write")).toBe(false);
    expect(routeDatabase.prepare("SELECT name FROM projects WHERE name = 'snapshot-late-write'").get())
      .toEqual({ name: "snapshot-late-write" });
  });

  it("导出请求包含额外字段时返回 400 与禁缓存响应头", async () => {
    const response = await postExportPayload({
      password: ROUTE_PASSWORD,
      confirmation: ROUTE_PASSWORD,
      unexpected: true,
    });
    try {
      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toContain("no-store");
      expect(await response.json()).toMatchObject({ ok: false, error: expect.any(String) });
    } finally {
      if (response.status === 200) await response.body?.cancel().catch(() => undefined);
    }
  });

  it("导出请求体媒体类型错误时返回 415 并取消未读请求流", async () => {
    const cancel = vi.fn(async () => undefined);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from(JSON.stringify({
          password: ROUTE_PASSWORD,
          confirmation: ROUTE_PASSWORD,
        }), "utf8"));
      },
      cancel,
    });
    const request = {
      body,
      headers: new Headers({ "Content-Type": "text/plain" }),
      json: vi.fn(async () => ({ password: ROUTE_PASSWORD, confirmation: ROUTE_PASSWORD })),
    } as unknown as Request;
    const route = await import("@/app/api/backup/export/route");

    const response = await route.POST(request);
    const cancelCallsBeforeCleanup = cancel.mock.calls.length;
    if (response.status === 200) await response.body?.cancel().catch(() => undefined);
    if (cancelCallsBeforeCleanup === 0) await body.cancel().catch(() => undefined);

    expect(response.status).toBe(415);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(cancelCallsBeforeCleanup).toBe(1);
    expect(request.json).not.toHaveBeenCalled();
  });

  it("无 Content-Length 的超限导出请求体返回 413 并取消请求流", async () => {
    const cancel = vi.fn(async () => undefined);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4_097));
      },
      cancel,
    });
    const request = {
      body,
      headers: new Headers({ "Content-Type": "application/json" }),
      json: vi.fn(async () => ({ password: ROUTE_PASSWORD, confirmation: ROUTE_PASSWORD })),
    } as unknown as Request;
    const route = await import("@/app/api/backup/export/route");

    const response = await route.POST(request);
    const cancelCallsBeforeCleanup = cancel.mock.calls.length;
    if (response.status === 200) await response.body?.cancel().catch(() => undefined);
    if (cancelCallsBeforeCleanup === 0) await body.cancel().catch(() => undefined);

    expect(response.status).toBe(413);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(cancelCallsBeforeCleanup).toBe(1);
    expect(request.json).not.toHaveBeenCalled();
  });

  it.each([
    ["415", "text/plain", Buffer.from(JSON.stringify({
      password: ROUTE_PASSWORD,
      confirmation: ROUTE_PASSWORD,
    }), "utf8"), 415],
    ["413", "application/json", new Uint8Array(4_097), 413],
  ] as const)("导出 JSON %s 主错误不被 reader releaseLock 失败覆盖", async (
    _name,
    contentType,
    bytes,
    expectedStatus,
  ) => {
    const releaseError = new Error(`release failed ${ROUTE_PASSWORD} sk-backup-sentinel`);
    let releaseCalls = 0;
    const body = uploadBodyWithReleaseFailure(bytes, releaseError, () => { releaseCalls += 1; });
    const request = {
      body,
      headers: new Headers({ "Content-Type": contentType }),
      json: vi.fn(async () => ({ password: ROUTE_PASSWORD, confirmation: ROUTE_PASSWORD })),
    } as unknown as Request;
    const route = await import("@/app/api/backup/export/route");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let response: Response;
    let consoleCalls: unknown[][] = [];
    try {
      response = await route.POST(request);
      consoleCalls = consoleSpy.mock.calls.map((call) => [...call]);
    } finally {
      consoleSpy.mockRestore();
    }

    expect(response.status).toBe(expectedStatus);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(await response.json()).toMatchObject({ ok: false, error: expect.any(String) });
    expect(request.json).not.toHaveBeenCalled();
    expect(releaseCalls).toBe(1);
    expect(body.locked).toBe(false);
    const logOutput = JSON.stringify(consoleCalls);
    expect(logOutput).toContain('\\"operation\\":\\"releaseLock\\"');
    expect(logOutput).not.toContain(ROUTE_PASSWORD);
    expect(logOutput).not.toContain("sk-backup-sentinel");
    expect(logOutput).not.toContain(releaseError.message);
  });

  it("导出 JSON 读取失败时 releaseLock 异常不覆盖读取主错误且不泄漏异常名称", async () => {
    const readError = new Error("export body read failed");
    const releaseError = new Error("release message must stay private");
    releaseError.name = `release-name-${ROUTE_PASSWORD}-sk-backup-sentinel`;
    const body = new ReadableStream<Uint8Array>();
    const getReader = body.getReader.bind(body);
    Object.defineProperty(body, "getReader", {
      configurable: true,
      value() {
        const reader = getReader();
        return new Proxy(reader, {
          get(target, property) {
            if (property === "read") return async () => { throw readError; };
            if (property === "releaseLock") {
              return () => {
                target.releaseLock();
                throw releaseError;
              };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    });
    const request = {
      body,
      headers: new Headers({ "Content-Type": "application/json" }),
    } as Request;
    const { readExportRequestJson } = await import("@/lib/backup-request");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let rejected: unknown;
    let logOutput = "";
    try {
      rejected = await readExportRequestJson(request).catch((error: unknown) => error);
      logOutput = JSON.stringify(consoleSpy.mock.calls);
    } finally {
      consoleSpy.mockRestore();
    }

    expect(rejected).toBe(readError);
    expect(body.locked).toBe(false);
    expect(logOutput).toContain('\\"operation\\":\\"releaseLock\\"');
    expect(logOutput).not.toContain(ROUTE_PASSWORD);
    expect(logOutput).not.toContain("sk-backup-sentinel");
    expect(logOutput).not.toContain(releaseError.name);
    expect(logOutput).not.toContain(releaseError.message);
  });

  it("带 charset 的 application/json 导出请求体保持合法", async () => {
    const response = await postExportPayload(
      { password: ROUTE_PASSWORD, confirmation: ROUTE_PASSWORD },
      { "Content-Type": "application/json; charset=utf-8" },
    );
    try {
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toContain("no-store");
    } finally {
      await response.body?.cancel().catch(() => undefined);
    }
  });

  it("application/json 坏 JSON 导出请求体返回 400 与禁缓存响应头", async () => {
    const route = await import("@/app/api/backup/export/route");
    const response = await route.POST(new Request("http://localhost/api/backup/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    }));

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("较后序业务表缺失时在消费响应体前返回脱敏 500", async () => {
    const encodedPassword = container.encodeBackupPasswordHeader(ROUTE_PASSWORD);
    const tableSql = (routeDatabase.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notebook_entries'",
    ).get() as { sql: string }).sql;
    const indexSql = (routeDatabase.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'notebook_entries' AND sql IS NOT NULL",
    ).all() as Array<{ sql: string }>).map(({ sql }) => sql);
    const connection = observeExportConnection();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let response: Response | undefined;
    let consoleCalls: unknown[][] = [];
    try {
      routeDatabase.exec("DROP TABLE notebook_entries");
      response = await postExport(ROUTE_PASSWORD, ROUTE_PASSWORD, {
        "x-request-id": encodedPassword,
      });
      consoleCalls = consoleSpy.mock.calls.map((call) => [...call]);
    } finally {
      if (response?.status === 200) await response.body?.cancel().catch(() => undefined);
      routeDatabase.exec(tableSql);
      for (const sql of indexSql) routeDatabase.exec(sql);
      consoleSpy.mockRestore();
      connection.restore();
    }

    await expectSanitizedServerError(response, consoleCalls, [
      ROUTE_PASSWORD,
      encodedPassword,
      "sk-backup-sentinel",
      "no such table: notebook_entries",
      "源数据库缺少表结构：notebook_entries",
      "数据库结构校验失败：缺少表 notebook_entries",
    ]);
    connection.assertQueryOnlyAndClosed();
  });

  it("数据库版本当前但普通业务列缺失时在消费响应体前返回脱敏 500", async () => {
    const encodedPassword = container.encodeBackupPasswordHeader(ROUTE_PASSWORD);
    const originalSql = (routeDatabase.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'resumes'",
    ).get() as { sql: string }).sql;
    const driftedSql = originalSql.replace(
      /\s+template TEXT NOT NULL DEFAULT 'classic',/u,
      "",
    );
    expect(driftedSql).not.toBe(originalSql);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let response: Response | undefined;
    let consoleCalls: unknown[][] = [];
    try {
      recreateTable("resumes", driftedSql);
      expect(routeDatabase.prepare("PRAGMA user_version").get()).toEqual({
        user_version: databaseModule.CURRENT_DB_VERSION,
      });
      response = await postExport(ROUTE_PASSWORD, ROUTE_PASSWORD, {
        "x-request-id": encodedPassword,
      });
      consoleCalls = consoleSpy.mock.calls.map((call) => [...call]);
    } finally {
      if (response?.status === 200) await response.body?.cancel().catch(() => undefined);
      recreateTable("resumes", originalSql);
      consoleSpy.mockRestore();
    }

    await expectSanitizedServerError(response, consoleCalls, [
      ROUTE_PASSWORD,
      encodedPassword,
      "sk-backup-sentinel",
      "数据库结构校验失败：缺少列 resumes.template",
    ]);
  });

  it("真正晚期的行数据异常保留 200，并在读取流式响应体时失败", async () => {
    routeDatabase.prepare(
      "INSERT INTO resume_modules (resume_id, module_key, type, label, sort, content, updated_at) VALUES (1, 'late-invalid', 'summary', '', 0, 'not-json', '')",
    ).run();

    const connection = observeExportConnection();
    try {
      const response = await postExport();

      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toContain("no-store");
      await expect(response.arrayBuffer()).rejects.toThrow(/resume_modules|领域 JSON/u);
      connection.assertQueryOnlyAndClosed();
    } finally {
      connection.restore();
    }
  });

  it.each([
    ["密码过短", "too-short", "too-short"],
    ["确认值类型错误", ROUTE_PASSWORD, 42],
    ["两次密码不一致", ROUTE_PASSWORD, `${ROUTE_PASSWORD}!`],
  ])("导出严格拒绝%s", async (_name, password, confirmation) => {
    const response = await postExport(password as string, confirmation);
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(await response.json()).toMatchObject({ ok: false, error: expect.any(String) });
  });

  it("validate 完整认证独立上传并返回 manifest、统计与总记录数", async () => {
    const encrypted = await routeBackupBytes();
    const route = await import("@/app/api/backup/validate/route");
    const request = encryptedUploadRequest("validate", encrypted);
    Object.defineProperty(request, "arrayBuffer", { value: () => { throw new Error("must stream request.body"); } });
    Object.defineProperty(request, "json", { value: () => { throw new Error("must not parse encrypted body as JSON"); } });

    const response = await route.POST(request);

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(await response.json()).toMatchObject({
      ok: true,
      manifest: { dbVersion: databaseModule.CURRENT_DB_VERSION },
      stats: { resumes: 1, settings: 1 },
      totalRecords: 2,
    });
  });

  it("错误密码、篡改密文、普通 JSON 与未知容器版本均由 validate 返回 400", async () => {
    const encrypted = await routeBackupBytes();
    const tampered = Buffer.from(encrypted);
    tampered[tampered.length - 1]! ^= 0x01;
    const unknownVersion = Buffer.from(encrypted);
    unknownVersion[6] = 0x03;
    const route = await import("@/app/api/backup/validate/route");
    const cases: Array<[Buffer, string]> = [
      [encrypted, "different correct-length password"],
      [tampered, ROUTE_PASSWORD],
      [Buffer.from('{"meta":{}}', "utf8"), ROUTE_PASSWORD],
      [unknownVersion, ROUTE_PASSWORD],
    ];

    for (const [bytes, password] of cases) {
      const response = await route.POST(encryptedUploadRequest("validate", bytes, password));
      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toContain("no-store");
      expect(await response.json()).toMatchObject({ ok: false, error: expect.any(String) });
    }
    expect(routeDatabase.prepare("SELECT title FROM resumes WHERE id = 1").get())
      .toEqual({ title: "sk-backup-sentinel" });
  });

  it("validate 在消费 request.body 时执行 2GiB 硬上限并返回 413", async () => {
    const oversized = new Uint8Array(0);
    Object.defineProperty(oversized, "byteLength", {
      get: () => limits.MAX_ENCRYPTED_BACKUP_BYTES + 1,
    });
    const upload = controlledCancelUpload(oversized, {
      cancelError: new Error("limit cancel failed"),
      releaseError: new Error("limit release failed"),
      closeAfterEnqueue: false,
    });
    const arrayBuffer = vi.fn(() => { throw new Error("must not buffer the request"); });
    const request = {
      body: upload.body,
      headers: new Headers({
        "X-Resume-Life-Backup-Password": container.encodeBackupPasswordHeader(ROUTE_PASSWORD),
      }),
      arrayBuffer,
    } as unknown as Request;
    const route = await import("@/app/api/backup/validate/route");

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let response: Response;
    try {
      response = await expectRouteAwaitsUploadCancel(route.POST(request), upload, 413, 1);
    } finally {
      consoleSpy.mockRestore();
    }

    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it.each([
    ["validate", { "X-Resume-Life-Backup-Password": "not-base64!" }],
    ["restore", { "X-Resume-Life-Preserve-Ai-Config": "sometimes" }],
  ] as const)("%s header 预检失败时等待上传流 cancel 并释放 reader", async (pathname, headers) => {
    const upload = controlledCancelUpload(Buffer.from("unread encrypted body", "utf8"), {
      cancelError: new Error("header cancel failed"),
      releaseError: new Error("header release failed"),
    });
    const route = pathname === "validate"
      ? await import("@/app/api/backup/validate/route")
      : await import("@/app/api/backup/restore/route");

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let response: Response;
    try {
      response = await expectRouteAwaitsUploadCancel(
        route.POST(streamedEncryptedUploadRequest(pathname, upload.body, headers)),
        upload,
        400,
      );
    } finally {
      consoleSpy.mockRestore();
    }

    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it.each(["validate", "restore"] as const)("%s 在正式库普通列缺失时返回 500 并取消未读上传", async (pathname) => {
    const encrypted = await routeBackupBytes();
    const originalRows = routeDatabase.prepare(
      "SELECT id, title, created_at, updated_at FROM resumes ORDER BY id",
    ).all();
    const originalSql = (routeDatabase.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'resumes'",
    ).get() as { sql: string }).sql;
    const driftedSql = originalSql.replace(
      /\s+template TEXT NOT NULL DEFAULT 'classic',/u,
      "",
    );
    expect(driftedSql).not.toBe(originalSql);
    const snapshotsBefore = backupSnapshotFiles();
    const upload = controlledCancelUpload(encrypted, {
      cancelError: new Error("schema cancel failed"),
      releaseError: new Error("schema release failed"),
    });
    let response: Response;

    recreateTable("resumes", driftedSql);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const route = pathname === "validate"
        ? await import("@/app/api/backup/validate/route")
        : await import("@/app/api/backup/restore/route");
      response = await expectRouteAwaitsUploadCancel(
        route.POST(streamedEncryptedUploadRequest(pathname, upload.body)),
        upload,
        500,
      );

      expect(response.headers.get("Cache-Control")).toContain("no-store");
      expect(routeDatabase.prepare(
        "SELECT id, title, created_at, updated_at FROM resumes ORDER BY id",
      ).all()).toEqual(originalRows);
      expect(backupSnapshotFiles()).toEqual(snapshotsBefore);
    } finally {
      consoleSpy.mockRestore();
      recreateTable("resumes", originalSql);
    }

    expect(routeDatabase.prepare("SELECT template FROM resumes WHERE id = 1").get())
      .toEqual({ template: "classic" });
  });

  it.each(["validate", "restore"] as const)("%s 在正式库列类型漂移时返回 500 且不创建暂存或快照", async (pathname) => {
    const encrypted = await routeBackupBytes();
    const originalRows = routeDatabase.prepare("SELECT * FROM settings ORDER BY id").all();
    const originalSql = (routeDatabase.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'settings'",
    ).get() as { sql: string }).sql;
    const driftedSql = originalSql.replace(/\bapi_key TEXT\b/u, "api_key BLOB");
    expect(driftedSql).not.toBe(originalSql);
    const snapshotsBefore = backupSnapshotFiles();
    const upload = controlledCancelUpload(encrypted);
    const mkdtempSpy = vi.spyOn(fs, "mkdtempSync");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let response: Response;

    recreateSettingsTable(driftedSql);
    try {
      const route = pathname === "validate"
        ? await import("@/app/api/backup/validate/route")
        : await import("@/app/api/backup/restore/route");
      response = await expectRouteAwaitsUploadCancel(
        route.POST(streamedEncryptedUploadRequest(pathname, upload.body)),
        upload,
        500,
      );

      expect(response.headers.get("Cache-Control")).toContain("no-store");
      expect(routeDatabase.prepare("SELECT * FROM settings ORDER BY id").all()).toEqual(originalRows);
      expect(backupSnapshotFiles()).toEqual(snapshotsBefore);
      expect(mkdtempSpy.mock.calls.filter(([prefix]) =>
        path.basename(String(prefix)).startsWith("resume-life-restore-"))).toHaveLength(0);
    } finally {
      consoleSpy.mockRestore();
      mkdtempSpy.mockRestore();
      recreateSettingsTable(originalSql);
    }

    expect(routeDatabase.prepare("PRAGMA table_info(settings)").all())
      .toContainEqual(expect.objectContaining({ name: "api_key", type: "TEXT" }));
    expect(routeDatabase.prepare("SELECT * FROM settings ORDER BY id").all()).toEqual(originalRows);
  });

  it.each(["validate", "restore"] as const)("%s 在正式库存在额外业务表时返回 500 且不创建暂存或快照", async (pathname) => {
    const encrypted = await routeBackupBytes();
    const originalRows = routeDatabase.prepare("SELECT * FROM settings ORDER BY id").all();
    const snapshotsBefore = backupSnapshotFiles();
    const upload = controlledCancelUpload(encrypted);
    const mkdtempSpy = vi.spyOn(fs, "mkdtempSync");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let response: Response;

    routeDatabase.exec("CREATE TABLE unexpected_backup_schema_table (id INTEGER PRIMARY KEY)");
    try {
      const route = pathname === "validate"
        ? await import("@/app/api/backup/validate/route")
        : await import("@/app/api/backup/restore/route");
      response = await expectRouteAwaitsUploadCancel(
        route.POST(streamedEncryptedUploadRequest(pathname, upload.body)),
        upload,
        500,
      );

      expect(response.headers.get("Cache-Control")).toContain("no-store");
      expect(routeDatabase.prepare("SELECT * FROM settings ORDER BY id").all()).toEqual(originalRows);
      expect(backupSnapshotFiles()).toEqual(snapshotsBefore);
      expect(mkdtempSpy.mock.calls.filter(([prefix]) =>
        path.basename(String(prefix)).startsWith("resume-life-restore-"))).toHaveLength(0);
    } finally {
      routeDatabase.exec("DROP TABLE IF EXISTS unexpected_backup_schema_table");
      consoleSpy.mockRestore();
      mkdtempSpy.mockRestore();
    }

    expect(routeDatabase.prepare("SELECT * FROM settings ORDER BY id").all()).toEqual(originalRows);
  });

  it.each(["validate", "restore"] as const)("%s 在正式库列约束漂移时返回 500 且不创建暂存或快照", async (pathname) => {
    const encrypted = await routeBackupBytes();
    const originalRows = routeDatabase.prepare("SELECT * FROM settings ORDER BY id").all();
    const originalSql = (routeDatabase.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'settings'",
    ).get() as { sql: string }).sql;
    const driftedSql = originalSql.replace(
      "api_key TEXT NOT NULL DEFAULT ''",
      "api_key TEXT DEFAULT ''",
    );
    expect(driftedSql).not.toBe(originalSql);
    const snapshotsBefore = backupSnapshotFiles();
    const upload = controlledCancelUpload(encrypted);
    const mkdtempSpy = vi.spyOn(fs, "mkdtempSync");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let response: Response;

    recreateSettingsTable(driftedSql);
    try {
      const route = pathname === "validate"
        ? await import("@/app/api/backup/validate/route")
        : await import("@/app/api/backup/restore/route");
      response = await expectRouteAwaitsUploadCancel(
        route.POST(streamedEncryptedUploadRequest(pathname, upload.body)),
        upload,
        500,
      );

      expect(response.headers.get("Cache-Control")).toContain("no-store");
      expect(routeDatabase.prepare("SELECT * FROM settings ORDER BY id").all()).toEqual(originalRows);
      expect(backupSnapshotFiles()).toEqual(snapshotsBefore);
      expect(mkdtempSpy.mock.calls.filter(([prefix]) =>
        path.basename(String(prefix)).startsWith("resume-life-restore-"))).toHaveLength(0);
    } finally {
      recreateSettingsTable(originalSql);
      consoleSpy.mockRestore();
      mkdtempSpy.mockRestore();
    }

    expect(routeDatabase.prepare("PRAGMA table_info(settings)").all())
      .toContainEqual(expect.objectContaining({ name: "api_key", notnull: 1, dflt_value: "''" }));
    expect(routeDatabase.prepare("SELECT * FROM settings ORDER BY id").all()).toEqual(originalRows);
  });

  it.each(["validate", "restore"] as const)("%s 对非法容器早退时在响应前取消上传流", async (pathname) => {
    const cancel = vi.fn(async () => undefined);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("invalid backup container bytes", "utf8"));
      },
      cancel,
    });
    const route = pathname === "validate"
      ? await import("@/app/api/backup/validate/route")
      : await import("@/app/api/backup/restore/route");

    const response = await route.POST(streamedEncryptedUploadRequest(pathname, body));

    expect(response.status).toBe(400);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it.each(["validate", "restore"] as const)("%s 自然消费完整上传流时不调用 cancel", async (pathname) => {
    const encrypted = await routeBackupBytes();
    const cancel = vi.fn(async () => undefined);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encrypted);
        controller.close();
      },
      cancel,
    });
    const route = pathname === "validate"
      ? await import("@/app/api/backup/validate/route")
      : await import("@/app/api/backup/restore/route");

    const response = await route.POST(streamedEncryptedUploadRequest(pathname, body));

    expect(response.status).toBe(200);
    expect(cancel).not.toHaveBeenCalled();
    expect(body.locked).toBe(false);
  });

  it("上传流 cancel 失败不覆盖格式主错误且 cleanup 日志脱敏", async () => {
    const cleanupError = new Error(`cancel failed ${ROUTE_PASSWORD} sk-backup-sentinel`);
    const cancel = vi.fn(async () => { throw cleanupError; });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("invalid backup container bytes", "utf8"));
      },
      cancel,
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let response: Response;
    let logOutput = "";
    try {
      const route = await import("@/app/api/backup/validate/route");
      response = await route.POST(streamedEncryptedUploadRequest("validate", body));
      logOutput = JSON.stringify(consoleSpy.mock.calls);
    } finally {
      consoleSpy.mockRestore();
    }

    expect(response.status).toBe(400);
    expect(cancel).toHaveBeenCalledOnce();
    expect(logOutput).toContain('\\"operation\\":\\"cancel\\"');
    expect(logOutput).not.toContain(ROUTE_PASSWORD);
    expect(logOutput).not.toContain("sk-backup-sentinel");
    expect(logOutput).not.toContain(cleanupError.message);
  });

  it("reader releaseLock 失败不覆盖认证主错误", async () => {
    const encrypted = await routeBackupBytes();
    const releaseError = new Error("release lock failed");
    const body = uploadBodyWithReleaseFailure(encrypted, releaseError);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let response: Response;
    let consoleCalls: unknown[][] = [];
    try {
      const route = await import("@/app/api/backup/validate/route");
      response = await route.POST(streamedEncryptedUploadRequest("validate", body, {
        "X-Resume-Life-Backup-Password": container.encodeBackupPasswordHeader("different correct-length password"),
      }));
      consoleCalls = consoleSpy.mock.calls.map((call) => [...call]);
    } finally {
      consoleSpy.mockRestore();
    }

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: "密码错误或备份已损坏",
    });
    expect(JSON.stringify(consoleCalls)).toContain('\\"operation\\":\\"releaseLock\\"');
    expect(body.locked).toBe(false);
  });

  it("restore 已提交后 reader releaseLock 失败仍返回成功并记录脱敏诊断", async () => {
    const encrypted = await routeBackupBytes();
    routeDatabase.prepare("UPDATE resumes SET title = 'before-valid-restore' WHERE id = 1").run();
    const releaseError = new Error(`release failed ${ROUTE_PASSWORD} sk-backup-sentinel`);
    releaseError.name = `release-name-${ROUTE_PASSWORD}-sk-backup-sentinel`;
    let releaseCalls = 0;
    const body = uploadBodyWithReleaseFailure(encrypted, releaseError, () => { releaseCalls += 1; });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let response: Response;
    let consoleCalls: unknown[][] = [];
    try {
      const route = await import("@/app/api/backup/restore/route");
      response = await route.POST(streamedEncryptedUploadRequest("restore", body));
      consoleCalls = consoleSpy.mock.calls.map((call) => [...call]);
    } finally {
      consoleSpy.mockRestore();
    }

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, snapshotCreated: expect.any(String) });
    expect(routeDatabase.prepare("SELECT title FROM resumes WHERE id = 1").get())
      .toEqual({ title: "sk-backup-sentinel" });
    expect(releaseCalls).toBe(1);
    expect(body.locked).toBe(false);
    const logOutput = JSON.stringify(consoleCalls);
    expect(logOutput).toContain('\\"operation\\":\\"releaseLock\\"');
    expect(logOutput).not.toContain(ROUTE_PASSWORD);
    expect(logOutput).not.toContain("sk-backup-sentinel");
    expect(logOutput).not.toContain(releaseError.name);
    expect(logOutput).not.toContain(releaseError.message);
  });

  it.each(["validate", "restore"] as const)("%s 清理失败保留名额，自动清理成功后恢复准入（包含认证失败）", async (name) => {
    const encrypted = await routeBackupBytes();
    for (const invalidPassword of [false, true]) {
      const before = restoreDirectories();
      const pendingDirectories = new Set<string>();
      const originalRm = fs.rmSync;
      const rmSpy = vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
        const directory = path.resolve(String(target));
        if (path.basename(directory).startsWith("resume-life-restore-") && !before.includes(path.basename(directory))) {
          pendingDirectories.add(directory);
          throw new Error("cleanup temporarily blocked");
        }
        return Reflect.apply(originalRm, fs, [target, options]);
      });
      try {
        const route = await backupRoute(name);
        const response = await route.POST(encryptedUploadRequest(name, encrypted, invalidPassword ? "incorrect password" : ROUTE_PASSWORD));
        expect(response.status).toBe(invalidPassword ? 400 : name === "restore" ? 200 : 500);
        expect(pendingDirectories.size).toBe(1);
        expect([...pendingDirectories].every((directory) => fs.existsSync(directory))).toBe(true);
        expect((await postExport()).status).toBe(429);
      } finally {
        rmSpy.mockRestore();
        await vi.waitFor(() => {
          for (const directory of pendingDirectories) expect(fs.existsSync(directory)).toBe(false);
        }, { timeout: 3_000 });
      }
      const next = await postExport();
      expect(next.status).toBe(200);
      await next.arrayBuffer();
    }
  });

  it("validate dispose 失败返回脱敏 500 且不信任客户端 requestId", async () => {
    const encrypted = await routeBackupBytes();
    const encodedPassword = container.encodeBackupPasswordHeader(ROUTE_PASSWORD);
    const ciphertextFragment = encrypted.subarray(0, 18).toString("base64url");
    const exceptionMessage = `dispose failed ${ROUTE_PASSWORD} ${encodedPassword} ${ciphertextFragment} sk-backup-sentinel`;
    const cleanupError = new Error(exceptionMessage);
    cleanupError.name = `dispose-name-${ROUTE_PASSWORD}-sk-backup-sentinel`;
    const releaseError = new Error(`release failed ${ROUTE_PASSWORD} sk-backup-sentinel`);
    const body = uploadBodyWithReleaseFailure(encrypted, releaseError);
    const originalRmSync = fs.rmSync;
    let residualDirectory: string | undefined;
    const rmSpy = vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
      const resolved = path.resolve(String(target));
      if (path.basename(resolved).startsWith("resume-life-restore-")) {
        residualDirectory = resolved;
        throw cleanupError;
      }
      return Reflect.apply(originalRmSync, fs, [target, options]);
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let response: Response | undefined;
    let consoleCalls: unknown[][] = [];
    try {
      const route = await import("@/app/api/backup/validate/route");
      response = await route.POST(streamedEncryptedUploadRequest("validate", body, {
        "x-request-id": "sk-backup-sentinel",
      }));
      consoleCalls = consoleSpy.mock.calls.map((call) => [...call]);
    } finally {
      rmSpy.mockRestore();
      consoleSpy.mockRestore();
    }

    try {
      expect(residualDirectory).toBeTruthy();
      await expectSanitizedServerError(response, consoleCalls, [
        ROUTE_PASSWORD,
        encodedPassword,
        ciphertextFragment,
        "sk-backup-sentinel",
        exceptionMessage,
        cleanupError.name,
        releaseError.message,
      ]);
      expect(JSON.stringify(consoleCalls)).toContain('\\"operation\\":\\"releaseLock\\"');
      expect(body.locked).toBe(false);
    } finally {
      if (residualDirectory) {
        const resolved = path.resolve(residualDirectory);
        if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("resume-life-restore-")) {
          throw new Error("refusing to remove an unsafe restore test directory");
        }
        fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      }
    }
    expect(fs.existsSync(residualDirectory!)).toBe(false);
    // 即使目录由测试收尾，操作仍须完成自身幂等清理后才释放名额。
    await vi.waitFor(async () => {
      const response = await postExport();
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    }, { timeout: 3_000 });
  });

  it("restore 代表性 500 不反射敏感客户端 requestId 或异常 message", async () => {
    const encrypted = await routeBackupBytes();
    const encodedPassword = container.encodeBackupPasswordHeader(ROUTE_PASSWORD);
    const ciphertextFragment = encrypted.subarray(0, 18).toString("base64url");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let response: Response | undefined;
    let consoleCalls: unknown[][] = [];
    routeDatabase.exec("BEGIN");
    try {
      routeDatabase.exec("DROP TABLE notebook_entries");
      const route = await import("@/app/api/backup/restore/route");
      response = await route.POST(encryptedUploadRequest("restore", encrypted, ROUTE_PASSWORD, {
        "x-request-id": ciphertextFragment,
      }));
      consoleCalls = consoleSpy.mock.calls.map((call) => [...call]);
    } finally {
      routeDatabase.exec("ROLLBACK");
      consoleSpy.mockRestore();
    }

    await expectSanitizedServerError(response, consoleCalls, [
      ROUTE_PASSWORD,
      encodedPassword,
      ciphertextFragment,
      "sk-backup-sentinel",
      "源数据库缺少表结构：notebook_entries",
    ]);
    await expectRestoreDirectoriesToClear();
  });
});

describe("有界 NDJSON 备份记录流", () => {
  it("首次写头像失败时关闭已打开的句柄，保留原错误并清除暂存", async () => {
    const fixture = cloneRecords(await exportedJsonRecords());
    fixture[0]!.files = [{ name: "write-failure.png", bytes: 3, chunks: 1 }];
    fixture.splice(-1, 0, { kind: "file", name: "write-failure.png", index: 0, data: Buffer.from("abc").toString("base64") });
    fixture.at(-1)!.files = 1;
    const diskError = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    let stagedHandle: number | undefined;
    let stagedPath: string | undefined;
    let closed = false;
    const originalOpen = fs.openSync;
    const open = vi.spyOn(fs, "openSync").mockImplementation((...args) => {
      const handle = Reflect.apply(originalOpen, fs, args);
      if (path.basename(String(args[0])) === "write-failure.png") {
        stagedHandle = handle; stagedPath = String(args[0]);
      }
      return handle;
    });
    const originalClose = fs.closeSync;
    const close = vi.spyOn(fs, "closeSync").mockImplementation((handle) => {
      originalClose(handle); if (handle === stagedHandle) closed = true;
    });
    const originalWrite = fs.writeSync;
    const write = vi.spyOn(fs, "writeSync").mockImplementation((...args) => {
      if (args[0] === stagedHandle) throw diskError;
      return Reflect.apply(originalWrite, fs, args);
    });
    let error: unknown;
    try {
      error = await captureError(() => staging.stageBackupRecordStream(sourceOf(serializeJsonRecords(fixture)), sourceDatabase));
      expect(error).toBe(diskError);
      expect(stagedHandle).toBeDefined();
      expect(closed).toBe(true);
      expect(fs.existsSync(path.resolve(stagedPath!, "../.."))).toBe(false);
    } finally {
      // 红灯运行也关闭泄漏的测试句柄，避免污染 Windows 临时目录。
      if (stagedHandle !== undefined && !closed) originalClose(stagedHandle);
      write.mockRestore(); close.mockRestore(); open.mockRestore();
      if (stagedPath) {
        const directory = path.resolve(stagedPath, "../..");
        if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("resume-life-restore-")) throw new Error("unsafe test cleanup");
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it("流开始消费前更新的头像引用必须进入同一数据库快照的文件清单", async () => {
    const stream = records.createBackupRecordStream(sourceDatabase);
    const name = `pre-stream-${databaseSequence}.png`;
    const uploads = path.join(TEST_DATA_DIR, "uploads");
    fs.mkdirSync(uploads, { recursive: true });
    fs.writeFileSync(path.join(uploads, name), Buffer.from("avatar-bytes"));
    const { defaultContent } = await import("../modules");
    sourceDatabase.prepare(
      "INSERT INTO resume_modules (resume_id, module_key, type, label, sort, content, updated_at) VALUES (1, 'basic', 'basic', '', 1, ?, '')",
    ).run(JSON.stringify({ ...defaultContent("basic"), avatar: `/api/uploads/${name}` }));
    try {
      const lines = (await collect(stream)).toString("utf8").trimEnd().split("\n");
      const manifest = JSON.parse(lines[0]!) as { files: { name: string }[] };
      expect(manifest.files.map((file) => file.name)).toContain(name);
      expect(lines.some((line) => line.includes(`"name":"${name}"`))).toBe(true);
    } finally {
      fs.rmSync(path.join(uploads, name), { force: true });
    }
  });

  it("按 manifest、游标分页 row、end 顺序导出完整明文", async () => {
    const bytes = await exportedBytes();
    const parsed = bytes.toString("utf8").trimEnd().split("\n").map((line) => JSON.parse(line) as JsonRecord);
    const manifest = parsed[0];
    const rowRecords = parsed.slice(1, -1);
    const end = parsed.at(-1) as JsonRecord;

    expect(bytes.includes(Buffer.from("sk-backup-sentinel", "utf8"))).toBe(true);
    expect(manifest).toEqual({
      kind: "manifest",
      appName: "resume-life",
      backupVersion: records.BACKUP_CONTAINER_VERSION,
      dbVersion: databaseModule.CURRENT_DB_VERSION,
      createdAt: "2026-09-17T00:00:00.000Z",
      tables: backup.TABLES_CLEAR_ORDER,
      sequences: expect.objectContaining({
        resumes: expect.any(Number),
        bank_entries: expect.any(Number),
      }),
      files: [],
    });
    expect(rowRecords.every((record) => record.kind === "row")).toBe(true);
    expect(parsed.filter((record) => record.kind === "manifest")).toHaveLength(1);
    expect(parsed.filter((record) => record.kind === "end")).toHaveLength(1);
    expect(rowRecords.filter((record) => record.table === "resumes")).toHaveLength(201);
    expect(rowRecords.filter((record) => record.table === "resumes").map((record) => (record.data as JsonRecord).id))
      .toEqual(Array.from({ length: 201 }, (_, index) => index + 1));
    expect(rowRecords.filter((record) => record.table === "bank_entries").map((record) => (record.data as JsonRecord).id))
      .toEqual([-1, 0, 1]);
    expect((firstRow(rowRecords, "settings").data as JsonRecord).api_key).toBe("sk-backup-sentinel");
    expect(end.kind).toBe("end");
    expect(end.totalRecords).toBe(rowRecords.length);
    expect(end.stats).toEqual(Object.fromEntries(backup.TABLES_CLEAR_ORDER.map((table) => [
      table,
      rowRecords.filter((record) => record.table === table).length,
    ])));
  });

  it("用数值断言精确覆盖所有资源限制边界", () => {
    expect(limits.BACKUP_BATCH_SIZE).toBe(200);
    expect(limits.MAX_ENCRYPTED_BACKUP_BYTES).toBe(2_147_483_648);
    expect(limits.MAX_BACKUP_PLAINTEXT_BYTES).toBe(4_294_967_296);
    expect(limits.MAX_BACKUP_FIELD_BYTES).toBe(2_097_152);
    expect(limits.MAX_BACKUP_ROWS_PER_TABLE).toBe(1_000_000);
    expect(limits.MAX_BACKUP_TOTAL_ROWS).toBe(2_000_000);

    const assertions: Array<[assertion: (value: number) => void, maximum: number]> = [
      [limits.assertEncryptedBackupBytes, 2_147_483_648],
      [limits.assertBackupPlaintextBytes, 4_294_967_296],
      [limits.assertBackupFieldBytes, 2_097_152],
      [limits.assertBackupRecordBytes, 2_097_152],
      [limits.assertBackupTableRows, 1_000_000],
      [limits.assertBackupTotalRows, 2_000_000],
    ];

    for (const [assertion, maximum] of assertions) {
      expect(() => assertion(maximum)).not.toThrow();
      expect(() => assertion(maximum + 1)).toThrow(limits.BackupLimitError);
    }
  });

  it("字段超限时保留 BackupLimitError 类型", async () => {
    sourceDatabase.prepare("UPDATE resumes SET title = ? WHERE id = 1")
      .run("x".repeat(limits.MAX_BACKUP_FIELD_BYTES + 1));

    await expect(collect(records.createBackupRecordStream(sourceDatabase)))
      .rejects.toBeInstanceOf(limits.BackupLimitError);
  });

  it("manifest 缺少序列清单时拒绝暂存", async () => {
    const fixture = cloneRecords(await exportedJsonRecords());
    delete (fixture[0] as { sequences?: unknown }).sequences;
    await expect(staging.stageBackupRecordStream(
      sourceOf(serializeJsonRecords(fixture)), sourceDatabase,
    )).rejects.toThrow(/manifest/);
  });

  it.each([
    ["负数", -1],
    ["低于现存 ID", 0],
  ])("拒绝%s的序列高水位", async (_label, sequence) => {
    const fixture = cloneRecords(await exportedJsonRecords());
    const manifest = fixture[0] as { sequences: Record<string, number> };
    manifest.sequences.resumes = sequence;
    await expectRejectedAndClean(
      sourceOf(serializeJsonRecords(fixture)),
      /序列|高水位|安全整数/,
    );
  });

  it("拒绝超出 JS 安全整数的 64 位 rowid，且主错误明确", async () => {
    sourceDatabase.exec(
      "INSERT INTO bank_entries (id, direction, kind, question, created_at) VALUES (9007199254740992, '', 'tech', 'unsafe-rowid', '')",
    );
    try {
      const error = await captureError(() => collect(records.createBackupRecordStream(sourceDatabase)));
      expect(error).toBeInstanceOf(records.BackupRecordError);
      expect((error as Error).message).toMatch(/安全整数|游标/);
    } finally {
      sourceDatabase.exec("DELETE FROM bank_entries WHERE id = 9007199254740992");
    }
  });

  it("导出主错误不被 ROLLBACK 失败覆盖", async () => {
    const rollbackError = new Error("injected rollback failure sk-backup-sentinel");
    const adapter = {
      exec(sql: string) {
        if (sql === "ROLLBACK") throw rollbackError;
        sourceDatabase.exec(sql);
      },
      prepare(sql: string) {
        return sourceDatabase.prepare(sql);
      },
    } as unknown as DatabaseSync;

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let consoleCalls: unknown[][] = [];
    let error: unknown;
    try {
      error = await captureError(() => collect(records.createBackupRecordStream(adapter, new Date(Number.NaN))));
    } finally {
      consoleCalls = consoleSpy.mock.calls.map((call) => [...call]);
      consoleSpy.mockRestore();
      sourceDatabase.exec("ROLLBACK");
    }
    expect(error).toBeInstanceOf(RangeError);
    expect(error).not.toBe(rollbackError);
    expect((error as Error).message).toMatch(/Invalid time value/);
    const errorWithCleanup = error as ErrorWithCleanupFailures;
    expect(errorWithCleanup.cleanupFailures).toEqual([
      expect.objectContaining({
        operation: "ROLLBACK",
        message: expect.not.stringContaining("sk-backup-sentinel"),
      }),
    ]);
    expect(Object.getOwnPropertyDescriptor(errorWithCleanup, "cleanupFailures")?.enumerable).toBe(false);
    const logOutput = JSON.stringify(consoleCalls);
    expect(logOutput).toContain("ROLLBACK");
    expect(logOutput).not.toContain("sk-backup-sentinel");
  });

  it("201 条 resumes 确实执行首批无 WHERE 和后续游标批次", async () => {
    const calls: Array<{ sql: string; args: unknown[] }> = [];
    const adapter = {
      exec(sql: string) {
        sourceDatabase.exec(sql);
      },
      prepare(sql: string) {
        const statement = sourceDatabase.prepare(sql);
        return new Proxy(statement, {
          get(target, property) {
            if (property === "all") {
              return (...args: unknown[]) => {
                calls.push({ sql, args });
                return target.all(...args as []);
              };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    } as unknown as DatabaseSync;

    await collect(records.createBackupRecordStream(adapter));
    expect(calls.filter((call) => call.sql.includes('FROM "resumes"'))).toEqual([
      {
        sql: 'SELECT rowid AS __backup_cursor__, * FROM "resumes" ORDER BY rowid LIMIT 200',
        args: [],
      },
      {
        sql: 'SELECT rowid AS __backup_cursor__, * FROM "resumes" WHERE rowid > ? ORDER BY rowid LIMIT 200',
        args: [200],
      },
    ]);
  });
});

describe("隔离 SQLite 暂存", () => {
  it("跨任意 chunk 暂存完整数据并按最多 200 行的游标批次读回", async () => {
    const staged = await staging.stageBackupRecordStream(chunksOf(await exportedBytes()), sourceDatabase);

    try {
    expect(path.dirname(staged.temporaryDirectory)).toBe(path.resolve(os.tmpdir()));
    expect(path.basename(staged.temporaryDirectory)).toMatch(/^resume-life-restore-/);
    expect(JSON.parse(fs.readFileSync(path.join(staged.temporaryDirectory, ".owner"), "utf8")))
      .toMatchObject({ pid: process.pid, createdAt: expect.any(Number) });
    expect(staged.manifest.tables).toEqual(backup.TABLES_CLEAR_ORDER);
    expect(staged.stats.resumes).toBe(201);
    expect(staged.totalRecords).toBe(206);
    expect(Object.isFrozen(staged.manifest)).toBe(true);
    expect(Object.isFrozen(staged.manifest.tables)).toBe(true);
    expect(Object.isFrozen(staged.stats)).toBe(true);
    expect(() => {
      (staged.manifest as { appName: string }).appName = "changed";
    }).toThrow(TypeError);
    expect(() => {
      (staged.manifest.tables as string[])[0] = "changed";
    }).toThrow(TypeError);
    expect(() => {
      (staged.stats as Record<string, number>).resumes = 0;
    }).toThrow(TypeError);
    expect(staged.manifest.appName).toBe("resume-life");
    expect(staged.stats.resumes).toBe(201);

    const firstBatch = staged.readTableBatch("resumes");
    const secondBatch = staged.readTableBatch("resumes", firstBatch.at(-1)?.cursor, 200);
    expect(firstBatch).toHaveLength(200);
    expect(secondBatch).toHaveLength(1);
    expect(firstBatch[0]).toEqual({
      cursor: 1,
      data: { id: 1, title: "sk-backup-sentinel", template: "classic", style_overrides: "{}", created_at: "", updated_at: "", base_version_id: null },
    });
    expect(secondBatch[0]!.data.id).toBe(201);
    expect(staged.readTableBatch("resume_modules")[0]!.data).toMatchObject({
      resume_id: 1,
      content: JSON.stringify(normalizeContent("summary", { text: "sk-backup-sentinel" })),
    });
    expect(staged.readTableBatch("settings")[0]!.data.api_key).toBe("sk-backup-sentinel");
    expect(staged.readTableBatch("bank_entries").map((row) => row.data.id)).toEqual([-1, 0, 1]);
    expect(staged.readTableBatch("bank_entries", -2).map((row) => row.data.id)).toEqual([-1, 0, 1]);

    for (const table of backup.TABLES_CLEAR_ORDER) {
      const sourceRows = sourceDatabase.prepare(
        `SELECT rowid AS cursor, * FROM "${table}" ORDER BY rowid`,
      ).all() as Array<Record<string, unknown> & { cursor: unknown }>;
      const expectedRows = sourceRows.map((row) => {
        expect(Number.isSafeInteger(row.cursor)).toBe(true);
        const data: Record<string, unknown> = { ...row };
        delete data.cursor;
        return { cursor: row.cursor as number, data };
      });
      const stagedRows: Array<{ cursor: number; data: Record<string, unknown> }> = [];
      let cursor: number | undefined;
      for (;;) {
        const batch = staged.readTableBatch(table, cursor, 200);
        expect(batch.length).toBeLessThanOrEqual(200);
        if (batch.length === 0) break;
        if (cursor !== undefined) expect(batch[0]!.cursor).toBeGreaterThan(cursor);
        stagedRows.push(...batch);
        cursor = batch.at(-1)!.cursor;
      }
      expect(stagedRows).toEqual(expectedRows);
    }

    expect(() => staged.readTableBatch("not_allowlisted")).toThrow(/未知表/);
    expect(() => staged.readTableBatch("resumes", 0, 201)).toThrow(/limit/);

    const directory = staged.temporaryDirectory;
    staged.dispose();
    staged.dispose();
    expect(() => staged.readTableBatch("resumes")).toThrow(staging.BackupStagingError);
    expect(fs.existsSync(directory)).toBe(false);
    await expectRestoreDirectoriesToClear();
    } finally {
      staged.dispose();
    }
  });

  it.each([
    ["未知表", (input: JsonRecord[]) => {
      firstRow(input, "resumes").table = "unknown_table";
    }, /未知表/],
    ["重复 manifest", (input: JsonRecord[]) => {
      input.splice(1, 0, structuredClone(input[0]) as JsonRecord);
    }, /manifest.*重复|重复.*manifest/i],
    ["缺失 end", (input: JsonRecord[]) => {
      input.pop();
    }, /缺少 end/],
    ["end 后仍有记录", (input: JsonRecord[]) => {
      input.push(structuredClone(firstRow(input, "resumes")) as JsonRecord);
    }, /end 之后/],
    ["统计不匹配", (input: JsonRecord[]) => {
      endRecord(input).stats.resumes! -= 1;
    }, /统计/],
  ])("拒绝%s并自动清理", async (_name, mutate, message) => {
    const fixture = cloneRecords(await exportedJsonRecords());
    mutate(fixture);
    await expectRejectedAndClean(chunksOf(serializeJsonRecords(fixture)), message);
  }, 15_000);

  it("旧版本 manifest 在版本闸门处被拒绝，而非误报备份损坏", async () => {
    const fixture = cloneRecords(await exportedJsonRecords());
    (fixture[0] as { backupVersion: string }).backupVersion = "2.0.0";
    await expectRejectedAndClean(chunksOf(serializeJsonRecords(fixture)), /不支持此备份版本/);
  });

  it("拒绝没有换行结束的截断尾行并自动清理", async () => {
    const complete = await exportedBytes();
    await expectRejectedAndClean(chunksOf(complete.subarray(0, complete.length - 1)), /换行|截断/);
  });

  it("以 fatal UTF-8 解码拒绝非法字节并自动清理", async () => {
    await expectRejectedAndClean(chunksOf(Buffer.from([0xff, 0x0a])), /UTF-8/);
  });

  it("拒绝重复键、额外空白、CRLF 和非规范数字并自动清理", async () => {
    const canonical = (await exportedBytes()).toString("utf8");
    const newline = canonical.indexOf("\n");
    const firstLine = canonical.slice(0, newline);
    const tail = canonical.slice(newline);
    const variants = [
      firstLine.replace('"kind":"manifest"', '"kind":"manifest","kind":"manifest"') + tail,
      ` ${firstLine}${tail}`,
      `${firstLine}\r${tail}`,
      firstLine.replace(`"dbVersion":${databaseModule.CURRENT_DB_VERSION}`, `"dbVersion":${databaseModule.CURRENT_DB_VERSION}e0`) + tail,
    ];

    for (const variant of variants) {
      await expectRejectedAndClean(sourceOf(Buffer.from(variant, "utf8")), /canonical|规范/i);
    }
  });

  it("非 canonical 且违反约束的 row 在格式校验前不执行 INSERT", async () => {
    const fixture = cloneRecords(await exportedJsonRecords());
    const bankRow = firstRow(fixture, "bank_entries");
    (bankRow.data as JsonRecord).kind = "invalid";
    const canonicalLine = JSON.stringify(bankRow);
    const plaintext = serializeJsonRecords(fixture).toString("utf8")
      .replace(`${canonicalLine}\n`, ` ${canonicalLine}\n`);
    const originalPrepare = DatabaseSync.prototype.prepare;
    let bankInsertCalls = 0;
    const prepareSpy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql: string) {
      const statement = originalPrepare.call(this, sql);
      if (!sql.startsWith('INSERT INTO "bank_entries"')) return statement;
      return {
        run: (...args: unknown[]) => {
          bankInsertCalls += 1;
          return Reflect.apply(statement.run, statement, args);
        },
      } as never;
    });
    let error: unknown;
    try {
      error = await captureError(() => staging.stageBackupRecordStream(
        sourceOf(Buffer.from(plaintext, "utf8")),
        sourceDatabase,
      ));
    } finally {
      prepareSpy.mockRestore();
    }
    expect(error).toBeInstanceOf(staging.BackupStagingError);
    expect((error as Error).message).toMatch(/canonical|规范/i);
    expect(bankInsertCalls).toBe(0);
    await expectRestoreDirectoriesToClear();
  });

  it("插入完成后发现非 canonical end 会回滚事务", async () => {
    const canonical = (await exportedBytes()).toString("utf8");
    const endStart = canonical.lastIndexOf("\n", canonical.length - 2) + 1;
    const nonCanonicalEnd = `${canonical.slice(0, endStart)} ${canonical.slice(endStart)}`;
    const calls: string[] = [];
    const originalExec = DatabaseSync.prototype.exec;
    const execSpy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
      calls.push(sql);
      return originalExec.call(this, sql);
    });
    try {
      await expectRejectedAndClean(sourceOf(Buffer.from(nonCanonicalEnd, "utf8")), /canonical|规范/i);
    } finally {
      execSpy.mockRestore();
    }
    expect(calls).toContain("BEGIN IMMEDIATE");
    expect(calls).toContain("ROLLBACK");
    expect(calls).not.toContain("COMMIT");
  });

  it("真实解析路径拒绝超过 2MiB 的单条 NDJSON 并自动清理", async () => {
    await expectLimitRejectedAndClean(sourceOf(Buffer.alloc(2_097_153, 0x61)));
  }, 15_000);

  it("真实 end 路径拒绝超过单表行数上限并自动清理", async () => {
    const fixture = cloneRecords(await exportedJsonRecords());
    endRecord(fixture).stats.resumes = 1_000_001;
    await expectLimitRejectedAndClean(sourceOf(serializeJsonRecords(fixture)));
  });

  it("真实 end 路径拒绝超过总行数上限并自动清理", async () => {
    const fixture = cloneRecords(await exportedJsonRecords());
    endRecord(fixture).totalRecords = 2_000_001;
    await expectLimitRejectedAndClean(sourceOf(serializeJsonRecords(fixture)));
  });

  it("真实累计路径无须分配 4GiB 即拒绝明文超限并自动清理", async () => {
    const oversizedChunk = oversizedPlaintextChunk();
    expect(oversizedChunk.buffer.byteLength).toBe(0);
    await expectLimitRejectedAndClean(sourceOf(oversizedChunk));
  });

  it("普通解析错误后仍累计后续 chunk 并优先报告明文上限", async () => {
    await expectLimitRejectedAndClean(sourceOf(
      Buffer.from("not-json\n", "utf8"),
      oversizedPlaintextChunk(),
    ));
  });

  it("普通解析错误和明文上限后仍排空真实坏 tag 源并优先报告认证错误", async () => {
    const password = "correct horse battery staple";
    const encrypted = await collect(container.createEncryptedBackupStream(
      password,
      sourceOf(Buffer.from("not-json\n", "utf8")) as AsyncIterable<Buffer>,
    ));
    encrypted[encrypted.length - 1]! ^= 0x01;
    await expectAuthenticationRejectedAndClean(injectAfterFirstChunk(
      container.decryptBackupStream(password, sourceOf(encrypted)),
      oversizedPlaintextChunk(),
    ));
  });

  it.each([
    {
      name: "单条 NDJSON 字节上限",
      createPlaintext: () => Buffer.alloc(2_097_153, 0x61),
    },
    {
      name: "单表行数上限",
      createPlaintext: async () => {
        const fixture = cloneRecords(await exportedJsonRecords());
        endRecord(fixture).stats.resumes = 1_000_001;
        return serializeJsonRecords(fixture);
      },
    },
    {
      name: "总行数上限",
      createPlaintext: async () => {
        const fixture = cloneRecords(await exportedJsonRecords());
        endRecord(fixture).totalRecords = 2_000_001;
        return serializeJsonRecords(fixture);
      },
    },
  ])("$name 后继续排空，使损坏 tag 优先报告认证错误", async ({ createPlaintext }) => {
    const plaintext = await createPlaintext();
    const password = "correct horse battery staple";

    const encrypted = await collect(container.createEncryptedBackupStream(
      password,
      sourceOf(plaintext) as AsyncIterable<Buffer>,
    ));
    await expectLimitRejectedAndClean(container.decryptBackupStream(password, sourceOf(encrypted)));

    const tampered = Buffer.from(encrypted);
    tampered[tampered.length - 1]! ^= 0x01;
    await expectAuthenticationRejectedAndClean(container.decryptBackupStream(password, sourceOf(tampered)));
  });

  it("拒绝无效领域 JSON，错误包含表名、行号和字段并自动清理", async () => {
    const fixture = cloneRecords(await exportedJsonRecords());
    const moduleRow = firstRow(fixture, "resume_modules").data as JsonRecord;
    moduleRow.content = JSON.stringify({ text: 1 });
    await expectRejectedAndClean(chunksOf(serializeJsonRecords(fixture)), /resume_modules.*第 1 行.*content/);
  });

  it("真实 CHECK 约束失败会拒绝并自动清理", async () => {
    const fixture = cloneRecords(await exportedJsonRecords());
    (firstRow(fixture, "bank_entries").data as JsonRecord).kind = "invalid";
    await expectRejectedAndClean(sourceOf(serializeJsonRecords(fixture)), /constraint|约束/i);
  });

  it("仅把带 ERR_SQLITE_CONSTRAINT 前缀的 INSERT 错误包装为数据库约束", async () => {
    const fixture = serializeJsonRecords(await exportedJsonRecords());
    const constraintError = Object.assign(new Error("synthetic constraint"), {
      code: "ERR_SQLITE_CONSTRAINT_CHECK",
    });
    const originalPrepare = DatabaseSync.prototype.prepare;
    const prepareSpy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql.startsWith('INSERT INTO "settings"')) {
        return { run: () => { throw constraintError; } } as never;
      }
      return originalPrepare.call(this, sql);
    });
    let error: unknown;
    try {
      error = await captureError(() => staging.stageBackupRecordStream(sourceOf(fixture), sourceDatabase));
    } finally {
      prepareSpy.mockRestore();
    }
    expect(error).toBeInstanceOf(staging.BackupStagingError);
    expect((error as Error).message).toMatch(/数据库约束/);
    expect((error as Error & { cause?: unknown }).cause).toBe(constraintError);
    await expectRestoreDirectoriesToClear();
  });

  it("非约束 INSERT 运行时错误保持原对象并自动清理", async () => {
    const fixture = serializeJsonRecords(await exportedJsonRecords());
    const runtimeError = new Error("injected insert runtime failure");
    const originalPrepare = DatabaseSync.prototype.prepare;
    const prepareSpy = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql.startsWith('INSERT INTO "settings"')) {
        return { run: () => { throw runtimeError; } } as never;
      }
      return originalPrepare.call(this, sql);
    });
    let error: unknown;
    try {
      error = await captureError(() => staging.stageBackupRecordStream(sourceOf(fixture), sourceDatabase));
    } finally {
      prepareSpy.mockRestore();
    }
    expect(error).toBe(runtimeError);
    await expectRestoreDirectoriesToClear();
  });

  it("拒绝主键破坏并自动清理", async () => {
    const fixture = cloneRecords(await exportedJsonRecords());
    addRow(fixture, structuredClone(firstRow(fixture, "resumes")) as JsonRecord);
    await expectRejectedAndClean(chunksOf(serializeJsonRecords(fixture)), /constraint|约束/i);
  });

  it("拒绝唯一约束破坏并自动清理", async () => {
    const fixture = cloneRecords(await exportedJsonRecords());
    const duplicate = structuredClone(firstRow(fixture, "resume_modules")) as JsonRecord;
    (duplicate.data as JsonRecord).id = 2;
    addRow(fixture, duplicate);
    await expectRejectedAndClean(chunksOf(serializeJsonRecords(fixture)), /constraint|约束/i);
  });

  it("拒绝外键破坏并自动清理", async () => {
    const fixture = cloneRecords(await exportedJsonRecords());
    (firstRow(fixture, "resume_modules").data as JsonRecord).resume_id = 999_999;
    await expectRejectedAndClean(chunksOf(serializeJsonRecords(fixture)), /外键/);
  });

  it("暂存事务包含所有建表并在完整校验后提交，最后开启外键", async () => {
    const fixture = await exportedBytes();
    const calls: string[] = [];
    const originalExec = DatabaseSync.prototype.exec;
    const execSpy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
      calls.push(sql);
      return originalExec.call(this, sql);
    });
    let staged: Awaited<ReturnType<typeof staging.stageBackupRecordStream>> | undefined;
    try {
      staged = await staging.stageBackupRecordStream(sourceOf(fixture), sourceDatabase);
    } finally {
      execSpy.mockRestore();
    }
    try {
      expect(calls).toContain("BEGIN IMMEDIATE");
      expect(calls).toContain("COMMIT");
      const schemaCalls = calls.filter((sql) => /^CREATE TABLE\b/i.test(sql));
      expect(schemaCalls).toHaveLength(backup.TABLES_INSERT_ORDER.length);
      expect(calls.indexOf("PRAGMA foreign_keys = OFF")).toBeLessThan(calls.indexOf("BEGIN IMMEDIATE"));
      for (const sql of schemaCalls) {
        expect(calls.indexOf("BEGIN IMMEDIATE")).toBeLessThan(calls.indexOf(sql));
        expect(calls.indexOf(sql)).toBeLessThan(calls.indexOf("COMMIT"));
      }
      expect(calls.indexOf("COMMIT")).toBeLessThan(calls.indexOf("PRAGMA foreign_keys = ON"));
    } finally {
      staged?.dispose();
    }
  });

  it("复制表结构中途失败时回滚已建表并清理暂存目录", async () => {
    const fixture = await exportedBytes();
    const schemaError = new Error("injected schema copy failure");
    const originalExec = DatabaseSync.prototype.exec;
    let createdTables = 0;
    let tablesAfterRollback: unknown[] | undefined;
    const execSpy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (/^CREATE TABLE\b/i.test(sql) && ++createdTables === 2) throw schemaError;
      const result = originalExec.call(this, sql);
      if (sql === "ROLLBACK") {
        tablesAfterRollback = this.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
      }
      return result;
    });
    try {
      await expect(staging.stageBackupRecordStream(sourceOf(fixture), sourceDatabase)).rejects.toBe(schemaError);
    } finally {
      execSpy.mockRestore();
    }
    expect(createdTables).toBe(2);
    expect(tablesAfterRollback).toEqual([]);
    await expectRestoreDirectoriesToClear();
  });

  it("解析主错误不被 rmSync 清理失败覆盖", async () => {
    const before = restoreDirectories();
    const cleanupError = new Error("injected rm failure sk-backup-sentinel");
    const rmSpy = vi.spyOn(fs, "rmSync").mockImplementation(() => { throw cleanupError; });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let error: unknown;
    let residual: string[] = [];
    let rmCalls = 0;
    let consoleCalls: unknown[][] = [];
    try {
      error = await captureError(() => staging.stageBackupRecordStream(
        sourceOf(Buffer.from("not-json\n", "utf8")),
        sourceDatabase,
      ));
    } finally {
      rmCalls = rmSpy.mock.calls.length;
      consoleCalls = consoleSpy.mock.calls.map((call) => [...call]);
      rmSpy.mockRestore();
      consoleSpy.mockRestore();
      const target = (error as ErrorWithCleanupFailures | undefined)?.cleanupFailures?.[0]?.target;
      residual = restoreDirectories().filter((directory) => directory === target && !before.includes(directory));
    }
    try {
      expect(error).toBeInstanceOf(staging.BackupStagingError);
      expect(error).not.toBe(cleanupError);
      expect((error as Error).message).toBe("备份记录 JSON 无效");
      const errorWithCleanup = error as ErrorWithCleanupFailures;
      expect(errorWithCleanup.cleanupFailures).toEqual([
        expect.objectContaining({
          operation: "removeTemporaryDirectory",
          target: expect.stringMatching(/^resume-life-restore-/),
          message: expect.not.stringContaining("sk-backup-sentinel"),
        }),
      ]);
      expect(Object.getOwnPropertyDescriptor(errorWithCleanup, "cleanupFailures")?.enumerable).toBe(false);
      expect(rmCalls).toBe(3);
      const logOutput = JSON.stringify(consoleCalls);
      expect(logOutput).toContain("removeTemporaryDirectory");
      expect(logOutput).toContain(residual[0]);
      expect(logOutput).not.toContain("sk-backup-sentinel");
      expect(residual).toHaveLength(1);
    } finally {
      for (const directory of residual) {
        stagingStorage.removeTemporaryDirectory(path.join(os.tmpdir(), directory));
      }
    }
    await expectRestoreDirectoriesToClear();
  });

  it("dispose 删除失败会抛错且第二次可重试完成", async () => {
    const staged = await staging.stageBackupRecordStream(sourceOf(await exportedBytes()), sourceDatabase);
    const directory = staged.temporaryDirectory;
    const cleanupError = new Error("injected dispose rm failure");
    const rmSpy = vi.spyOn(fs, "rmSync").mockImplementation(() => { throw cleanupError; });
    try {
      expect(() => staged.dispose()).toThrow(cleanupError);
      expect(rmSpy).toHaveBeenCalledTimes(3);
      expect(rmSpy.mock.calls[0]?.[1]).toMatchObject({ maxRetries: 2, retryDelay: 100 });
      expect(fs.existsSync(directory)).toBe(true);
    } finally {
      rmSpy.mockRestore();
    }
    try {
      expect(() => staged.dispose()).not.toThrow();
      expect(fs.existsSync(directory)).toBe(false);
      expect(() => staged.readTableBatch("settings")).toThrow(staging.BackupStagingError);
    } finally {
      if (fs.existsSync(directory)) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    }
  });

  it("中文与 emoji 在单字节及空 chunk 边界完整往返", async () => {
    const staged = await staging.stageBackupRecordStream(
      oneByteChunksWithEmpties(await exportedBytes()),
      sourceDatabase,
    );
    try {
      expect(staged.readTableBatch("bank_entries").map((row) => row.data.question)).toEqual([
        "负数行 中文😀",
        "零行 中文😀",
        "正数行 中文😀",
      ]);
      expect(staged.readTableBatch("settings")[0]!.data.api_key).toBe("sk-backup-sentinel");
    } finally {
      staged.dispose();
    }
  });

  it("解析先失败但 GCM tag 最终也失败时优先抛认证错误并自动清理", async () => {
    const password = "correct horse battery staple";
    const encrypted = await collect(container.createEncryptedBackupStream(
      password,
      chunksOf(Buffer.from("not-json\n", "utf8")) as AsyncIterable<Buffer>,
      new Date("2026-09-17T00:00:00.000Z"),
    ));
    encrypted[encrypted.length - 1]! ^= 0x01;
    await expect(staging.stageBackupRecordStream(
      container.decryptBackupStream(password, chunksOf(encrypted)),
      sourceDatabase,
    )).rejects.toBeInstanceOf(container.BackupAuthenticationError);
    await expectRestoreDirectoriesToClear();
  });
});
