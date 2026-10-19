import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMP_PREFIX = "resume-life-notebook-cat-id-route-test-";

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
  new Request("http://127.0.0.1/api/notebook/categories/1", {
    method,
    headers: { "content-type": "application/json", origin: "http://127.0.0.1", host: "127.0.0.1" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const idContext = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

const seedCategory = (name: string): number => {
  const result = db?.prepare("INSERT INTO notebook_categories (name, created_at) VALUES (?, ?)")
    .run(name, "2026-01-01T00:00:00.000Z");
  return Number(result?.lastInsertRowid);
};

describe("PATCH/DELETE /api/notebook/categories/[id] 分类改名与删除", () => {
  it("PATCH 重命名分类", async () => {
    const id = seedCategory("旧名");
    const route = await import("../route");
    const res = await route.PATCH(request("PATCH", { name: "新名" }), idContext(id));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    const row = db?.prepare("SELECT name FROM notebook_categories WHERE id = ?").get(id) as
      | { name: string }
      | undefined;
    expect(row?.name).toBe("新名");
  });

  it("PATCH 重命名为已存在名称返回 409", async () => {
    seedCategory("已有分类");
    const id = seedCategory("待改名");
    const route = await import("../route");
    const res = await route.PATCH(request("PATCH", { name: "已有分类" }), idContext(id));
    expect(res.status).toBe(409);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("已存在同名分类");
  });

  it("PATCH 空名 400 / 不存在的分类 404 / 非法 id 400", async () => {
    const route = await import("../route");
    const blank = await route.PATCH(request("PATCH", { name: "" }), idContext(1));
    expect(blank.status).toBe(400);
    const blankData = (await blank.json()) as { error: string };
    expect(blankData.error).toContain("请输入分类名称");

    const missing = await route.PATCH(request("PATCH", { name: "任意" }), idContext(999));
    expect(missing.status).toBe(404);
    const missingData = (await missing.json()) as { error: string };
    expect(missingData.error).toContain("分类不存在");

    const invalid = await route.PATCH(request("PATCH", { name: "任意" }), idContext(Number.NaN));
    expect(invalid.status).toBe(400);
    const invalidData = (await invalid.json()) as { error: string };
    expect(invalidData.error).toContain("无效的分类 ID");
  });

  it("DELETE 删除分类后错题的 category_id 置空（ON DELETE SET NULL）", async () => {
    const id = seedCategory("待删除");
    db?.prepare(
      `INSERT INTO notebook_entries (category_id, source, source_id, question, created_at, updated_at)
       VALUES (?, 'drill', 1, 'Q', '', '')`
    ).run(id);

    const route = await import("../route");
    const res = await route.DELETE(request("DELETE"), idContext(id));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);

    const row = db?.prepare("SELECT category_id FROM notebook_entries WHERE source_id = 1").get() as
      | { category_id: number | null }
      | undefined;
    expect(row?.category_id).toBeNull();
  });

  it("DELETE 不存在的分类返回 404", async () => {
    const route = await import("../route");
    const res = await route.DELETE(request("DELETE"), idContext(999));
    expect(res.status).toBe(404);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("分类不存在");
  });
});
