import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMP_PREFIX = "resume-life-notebook-cats-route-test-";

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
  new Request("http://127.0.0.1/api/notebook/categories", {
    method,
    headers: { "content-type": "application/json", origin: "http://127.0.0.1", host: "127.0.0.1" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("GET/POST /api/notebook/categories 错题分类", () => {
  it("POST 创建分类，GET 列表带 entry_count", async () => {
    const route = await import("../route");
    const post = await route.POST(request("POST", { name: "八股文" }));
    expect(post.status).toBe(201);
    const created = (await post.json()) as { id: number; name: string };
    expect(created.name).toBe("八股文");

    // 挂两条错题到该分类下，验证 entry_count 统计
    db?.prepare(
      `INSERT INTO notebook_entries (category_id, source, source_id, question, created_at, updated_at)
       VALUES (?, 'drill', 1, 'Q1', '', ''), (?, 'drill', 2, 'Q2', '', '')`
    ).run(created.id, created.id);

    const get = await route.GET(request("GET"));
    expect(get.status).toBe(200);
    const list = (await get.json()) as { id: number; name: string; entry_count: number }[];
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("八股文");
    expect(list[0]?.entry_count).toBe(2);
  });

  it("POST 同名分类返回 409", async () => {
    const route = await import("../route");
    const first = await route.POST(request("POST", { name: "行为面" }));
    expect(first.status).toBe(201);
    const second = await route.POST(request("POST", { name: "行为面" }));
    expect(second.status).toBe(409);
    const data = (await second.json()) as { error: string };
    expect(data.error).toContain("已存在同名分类");
  });

  it("POST 名称为空或超过 30 字返回 400", async () => {
    const route = await import("../route");
    const empty = await route.POST(request("POST", { name: "  " }));
    expect(empty.status).toBe(400);
    const emptyData = (await empty.json()) as { error: string };
    expect(emptyData.error).toContain("请输入分类名称");

    const tooLong = await route.POST(request("POST", { name: "a".repeat(31) }));
    expect(tooLong.status).toBe(400);
    const tooLongData = (await tooLong.json()) as { error: string };
    expect(tooLongData.error).toContain("分类名称不能超过 30 个字");
  });
});
