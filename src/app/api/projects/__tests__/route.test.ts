import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMP_PREFIX = "resume-life-projects-route-test-";

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
  new Request("http://127.0.0.1/api/projects", {
    method,
    headers: { "content-type": "application/json", origin: "http://127.0.0.1", host: "127.0.0.1" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("GET/POST /api/projects 项目列表", () => {
  it("POST 创建项目，GET 返回带 material_count 的列表", async () => {
    const route = await import("../route");
    const post = await route.POST(request("POST", { name: "电商后台" }));
    expect(post.status).toBe(201);
    const created = (await post.json()) as { id: number; name: string };
    expect(created.name).toBe("电商后台");

    db?.prepare("INSERT INTO project_materials (project_id, title, source, content, created_at) VALUES (?, ?, 'paste', ?, ?)")
      .run(created.id, "设计文档", "接口约定", "2026-01-01T00:00:00.000Z");

    const get = await route.GET(request("GET"));
    expect(get.status).toBe(200);
    const list = (await get.json()) as { id: number; name: string; material_count: number }[];
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("电商后台");
    expect(list[0]?.material_count).toBe(1);
  });

  it("GET 空库返回空数组", async () => {
    const route = await import("../route");
    const res = await route.GET(request("GET"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("POST 名称为空返回 400", async () => {
    const route = await import("../route");
    const res = await route.POST(request("POST", { name: "  " }));
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("项目名称不能为空");
  });
});
