import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMP_PREFIX = "resume-life-bank-directions-route-test-";

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
  new Request("http://127.0.0.1/api/bank/directions", {
    method: "GET",
    headers: { origin: "http://127.0.0.1", host: "127.0.0.1" },
  });

const seedEntry = (direction: string, question: string): void => {
  db?.prepare("INSERT INTO bank_entries (direction, kind, question, created_at) VALUES (?, 'tech', ?, ?)")
    .run(direction, question, "2026-01-01T00:00:00.000Z");
};

describe("GET /api/bank/directions 题库方向列表", () => {
  it("按方向分组计数，空方向不参与分组", async () => {
    seedEntry("前端", "什么是闭包");
    seedEntry("前端", "事件循环");
    seedEntry("后端", "索引原理");
    seedEntry("", "无方向题不计入");

    const route = await import("../route");
    const res = await route.GET(request());
    expect(res.status).toBe(200);
    const data = (await res.json()) as { direction: string; count: number }[];
    // 按 direction 排序：SQLite BINARY collation，「前」(U+524D) 在「后」(U+540E) 之前
    expect(data).toEqual([
      { direction: "前端", count: 2 },
      { direction: "后端", count: 1 },
    ]);
  });

  it("空库返回空数组", async () => {
    const route = await import("../route");
    const res = await route.GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});
