import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMP_PREFIX = "resume-life-health-route-test-";

let tempDir: string;
let db: DatabaseSync | undefined;

beforeEach(async () => {
  vi.resetModules();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", path.join(tempDir, "data"));
  db = (await import("@/lib/db")).getDb();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  // Windows 上删除仍被 SQLite 持有的文件会 EPERM，必须先关句柄
  db?.close();
  db = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  const resolved = path.resolve(tempDir);
  if (
    path.dirname(resolved) !== path.resolve(os.tmpdir())
    || !path.basename(resolved).startsWith(TEMP_PREFIX)
  ) {
    throw new Error(`Unsafe cleanup path: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
});

const request = () =>
  new Request("http://127.0.0.1/api/health", {
    method: "GET",
    headers: { origin: "http://127.0.0.1", host: "127.0.0.1" },
  });

describe("GET /api/health 健康检查", () => {
  it("物理损坏的数据库由健康 handler 返回 database-open 阶段的 503", async () => {
    db!.close();
    db = undefined;
    vi.resetModules();
    const dataDir = path.join(tempDir, "data");
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(path.join(dataDir, `resume-life.db${suffix}`), { force: true });
    fs.writeFileSync(path.join(dataDir, "resume-life.db"), "synthetic-invalid-sqlite");
    const { GET } = await import("../route");
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: "error", message: "数据库健康检查失败" });
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(vi.mocked(console.error).mock.calls.map(([line]) => String(line)).join("\n")).toContain('"stage":"database-open"');
  });
  it("存储写探针失败只返回安全 503 契约，日志带固定失败阶段", async () => {
    const database = await import("@/lib/db");
    vi.spyOn(database, "assertStorageWritable").mockImplementation(() => {
      throw Object.assign(new Error("PRIVATE_PATH"), { code: "EACCES" });
    });
    const route = await import("../route");
    const response = await route.GET(request());
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({ status: "error", message: "数据库健康检查失败", timestamp: expect.any(String), requestId: expect.any(String) });
    const logs = vi.mocked(console.error).mock.calls.map((call) => String(call[0]));
    const payload = JSON.parse(logs.find((line) => line.startsWith("[server-error]"))!.replace(/^\[server-error\]\s*/, ""));
    expect(payload).toMatchObject({ requestId: body.requestId, stage: "storage-write", errorCode: "EACCES" });
    expect(logs.join("\n")).not.toContain("PRIVATE_PATH");
  });

  it("非 WAL 故障日志可与存储写故障区分，响应仍不暴露 db", async () => {
    db!.exec("PRAGMA journal_mode=DELETE");
    const route = await import("../route");
    const response = await route.GET(request());
    expect(response.status).toBe(503);
    expect(await response.json()).not.toHaveProperty("db");
    const logs = vi.mocked(console.error).mock.calls.map((call) => String(call[0]));
    const payload = JSON.parse(logs.find((line) => line.startsWith("[server-error]"))!.replace(/^\[server-error\]\s*/, ""));
    expect(payload.stage).toBe("database-wal");
  });

  it("返回 200 且数据库健康字段齐全", async () => {
    const route = await import("../route");
    const res = await route.GET(request());
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      status: string;
      db: { status: string; version: number; journalMode: string; storageWritable: boolean };
      restoreStaging: { count: number; oldestAgeMs: number | null };
      uptimeSeconds: number;
      latencyMs: number;
      timestamp: string;
    };
    expect(data.status).toBe("ok");
    expect(data.db.status).toBe("connected");
    // 库以 WAL 模式打开，健康检查必须如实反映
    expect(data.db.journalMode).toBe("wal");
    expect(data.db.storageWritable).toBe(true);
    expect(data.db.version).toBeGreaterThanOrEqual(1);
    expect(data.restoreStaging.count).toBeGreaterThanOrEqual(0);
    expect(data.restoreStaging.oldestAgeMs === null || data.restoreStaging.oldestAgeMs >= 0).toBe(true);
    expect(typeof data.uptimeSeconds).toBe("number");
    expect(typeof data.latencyMs).toBe("number");
    expect(typeof data.timestamp).toBe("string");
  });

  it("连续探测保持健康（写探针文件被清理，不残留）", async () => {
    const route = await import("../route");
    const first = await route.GET(request());
    expect(first.status).toBe(200);
    const second = await route.GET(request());
    expect(second.status).toBe(200);
    const dataDir = path.join(tempDir, "data");
    expect(fs.existsSync(path.join(dataDir, ".health-write-probe"))).toBe(false);
  });
});
