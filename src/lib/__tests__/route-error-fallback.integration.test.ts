import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tempDir: string;
let db: DatabaseSync;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  vi.resetModules();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-route-error-fallback-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", path.join(tempDir, "data"));
  db = (await import("@/lib/db")).getDb();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (path.dirname(tempDir) !== os.tmpdir() || !path.basename(tempDir).startsWith("resume-life-route-error-fallback-")) {
    throw new Error("Unsafe cleanup path");
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("finish 路由的非预期异常兜底", () => {
  it("路由内首个 DB 读取抛错时收敛为 500 + requestId，并留下含 operation 的服务端日志", async () => {
    // ESM 命名空间导出无法 spyOn，故沿用项目既有手法：spy 原型方法。
    const original = DatabaseSync.prototype.prepare;
    const spy = vi
      .spyOn(DatabaseSync.prototype, "prepare")
      .mockImplementation(function (this: DatabaseSync) {
        throw new Error("SQLITE_IOERR: disk I/O error");
      });

    const route = await import("@/app/api/interviews/[id]/finish/route");
    const res = await route.POST(
      new Request("http://127.0.0.1/api/interviews/1/finish", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1", host: "127.0.0.1" },
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ id: "1" }) }
    );
    const payload = await res.json();

    expect(res.status).toBe(500);
    expect(payload.requestId).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
    expect(JSON.stringify(payload)).not.toContain("SQLITE_IOERR");

    const logged = errorSpy.mock.calls.flat().join(" ");
    expect(logged).toContain("[server-error]");
    expect(logged).toContain("POST /api/interviews/[id]/finish");

    spy.mockRestore();
    void original;
  });
});
