import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMP_PREFIX = "resume-life-bank-id-route-test-";

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
  new Request("http://127.0.0.1/api/bank/1", {
    method: "DELETE",
    headers: { origin: "http://127.0.0.1", host: "127.0.0.1" },
  });

const idContext = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

const seedEntry = (): number => {
  const result = db?.prepare(
    "INSERT INTO bank_entries (direction, kind, question, created_at) VALUES (?, 'tech', ?, ?)"
  ).run("前端", "什么是闭包", "2026-01-01T00:00:00.000Z");
  return Number(result?.lastInsertRowid);
};

describe("DELETE /api/bank/[id] 题库条目删除", () => {
  it("删除存在的题目返回 ok，且库里不再有该行", async () => {
    const id = seedEntry();
    const route = await import("../route");
    const res = await route.DELETE(request(), idContext(id));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean };
    expect(data.ok).toBe(true);
    const rows = db?.prepare("SELECT COUNT(*) AS n FROM bank_entries").get() as { n: number } | undefined;
    expect(rows?.n).toBe(0);
  });

  it("删除不存在的题目返回 404", async () => {
    const route = await import("../route");
    const res = await route.DELETE(request(), idContext(999));
    expect(res.status).toBe(404);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("题目不存在");
  });

  it("非法 id 返回 400", async () => {
    const route = await import("../route");
    const res = await route.DELETE(request(), idContext(Number.NaN));
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("无效的题目 ID");
  });
});
