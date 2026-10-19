import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMP_PREFIX = "resume-life-notebook-id-route-test-";

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

const request = (method: string, body?: unknown) =>
  new Request("http://127.0.0.1/api/notebook/1", {
    method,
    headers: { "content-type": "application/json", origin: "http://127.0.0.1", host: "127.0.0.1" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const idContext = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

const seedEntry = (): number => {
  const result = db?.prepare(
    `INSERT INTO notebook_entries (source, source_id, question, answer, created_at, updated_at)
     VALUES ('drill', 1, ?, '答案', ?, ?)`
  ).run("什么是闭包", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  return Number(result?.lastInsertRowid);
};

const seedCategory = (): number => {
  const result = db?.prepare("INSERT INTO notebook_categories (name, created_at) VALUES (?, ?)")
    .run("八股文", "2026-01-01T00:00:00.000Z");
  return Number(result?.lastInsertRowid);
};

describe("GET/PATCH/DELETE /api/notebook/[id] 错题详情", () => {
  it("GET 返回错题详情", async () => {
    const id = seedEntry();
    const route = await import("../route");
    const res = await route.GET(request("GET"), idContext(id));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { id: number; question: string; answer: string };
    expect(data.id).toBe(id);
    expect(data.question).toBe("什么是闭包");
  });

  it("GET 非法 id 返回 400", async () => {
    const route = await import("../route");
    const res = await route.GET(request("GET"), idContext("abc"));
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("无效的错题 ID");
  });

  it("PATCH 设置分类后可再传 null 清空", async () => {
    const id = seedEntry();
    const categoryId = seedCategory();
    const route = await import("../route");

    const set = await route.PATCH(request("PATCH", { category_id: categoryId }), idContext(id));
    expect(set.status).toBe(200);
    const afterSet = db?.prepare("SELECT category_id FROM notebook_entries WHERE id = ?").get(id) as
      | { category_id: number }
      | undefined;
    expect(afterSet?.category_id).toBe(categoryId);

    const cleared = await route.PATCH(request("PATCH", { category_id: null }), idContext(id));
    expect(cleared.status).toBe(200);
    const afterClear = db?.prepare("SELECT category_id FROM notebook_entries WHERE id = ?").get(id) as
      | { category_id: number | null }
      | undefined;
    expect(afterClear?.category_id).toBeNull();
  });

  it("PATCH 指向不存在的分类返回 400", async () => {
    const id = seedEntry();
    const route = await import("../route");
    const res = await route.PATCH(request("PATCH", { category_id: 9999 }), idContext(id));
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("分类不存在");
  });

  it("PATCH 非对象或缺少显式分类字段时返回 400 且不修改分类和时间", async () => {
    const id = seedEntry();
    const categoryId = seedCategory();
    const route = await import("../route");
    expect((await route.PATCH(request("PATCH", { category_id: categoryId }), idContext(id))).status).toBe(200);
    const before = db?.prepare("SELECT category_id, updated_at FROM notebook_entries WHERE id = ?").get(id) as
      | { category_id: number; updated_at: string }
      | undefined;
    expect(before).toBeDefined();

    for (const body of [null, [], {}, "invalid", true, { category_id: true }]) {
      const res = await route.PATCH(request("PATCH", body), idContext(id));
      expect(res.status).toBe(400);
      const after = db?.prepare("SELECT category_id, updated_at FROM notebook_entries WHERE id = ?").get(id) as
        | { category_id: number; updated_at: string }
        | undefined;
      expect(after).toEqual(before);
    }
  });

  it("PATCH 不存在的错题返回 404", async () => {
    seedCategory();
    const route = await import("../route");
    const res = await route.PATCH(request("PATCH", { category_id: 1 }), idContext(999));
    expect(res.status).toBe(404);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("错题不存在");
  });

  it("DELETE 删除错题，再删一次返回 404", async () => {
    const id = seedEntry();
    const route = await import("../route");
    const first = await route.DELETE(request("DELETE"), idContext(id));
    expect(first.status).toBe(200);
    expect(((await first.json()) as { ok: boolean }).ok).toBe(true);

    const second = await route.DELETE(request("DELETE"), idContext(id));
    expect(second.status).toBe(404);
    const data = (await second.json()) as { error: string };
    expect(data.error).toContain("错题不存在");
  });
});
