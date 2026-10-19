import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMP_PREFIX = "resume-life-templates-route-test-";

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
  new Request("http://127.0.0.1/api/templates", {
    method,
    headers: { "content-type": "application/json", origin: "http://127.0.0.1", host: "127.0.0.1" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("GET/POST /api/templates 自定义模板", () => {
  it.each(["{broken", "null", "[]"])("坏模板 %s 显式标记且不阻断其他模板，保存修复后解除标记", async (style) => {
    db!.prepare("INSERT INTO resume_templates(id,name,style,created_at,updated_at) VALUES(1,'坏模板',?,'','')").run(style);
    db!.prepare("INSERT INTO resume_templates(id,name,style,created_at,updated_at) VALUES(2,'正常模板','{}','','')").run();
    const { GET } = await import("../route");
    const listed = await (await GET(request("GET"))).json();
    expect(listed.items[0]).toMatchObject({ id: 1, corrupted: true });
    expect(listed.items[1].corrupted).not.toBe(true);
    expect(db!.prepare("SELECT style FROM resume_templates WHERE id=1").get()).toEqual({ style });
    const { PATCH } = await import("../[id]/route");
    const renamed = await PATCH(request("PATCH", { name: "待修复" }), { params: Promise.resolve({ id: "1" }) });
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).corrupted).toBe(true);
    const repaired = await PATCH(request("PATCH", { style: {} }), { params: Promise.resolve({ id: "1" }) });
    expect(repaired.status).toBe(200);
    expect((await repaired.json()).corrupted).not.toBe(true);
    expect((await (await GET(request("GET"))).json()).items[0].corrupted).not.toBe(true);
  });

  it("POST 创建模板（空 style 兜底为默认样式），GET 列表返回 items", async () => {
    const route = await import("../route");
    const post = await route.POST(request("POST", { name: "深色模板", style: {} }));
    expect(post.status).toBe(201);
    const created = (await post.json()) as { id: number; name: string; style: Record<string, unknown> };
    expect(created.name).toBe("深色模板");
    // normalizeStyle 会把缺失字段补成默认值，返回完整样式对象
    expect(Object.keys(created.style).length).toBeGreaterThan(0);

    const get = await route.GET(request("GET"));
    expect(get.status).toBe(200);
    const list = (await get.json()) as { items: { id: number; name: string }[] };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]?.name).toBe("深色模板");
  });

  it("POST 名称为空或超过 30 字返回 400", async () => {
    const route = await import("../route");
    const empty = await route.POST(request("POST", { name: "", style: {} }));
    expect(empty.status).toBe(400);
    const emptyData = (await empty.json()) as { error: string };
    expect(emptyData.error).toContain("模板名称不能为空");

    const tooLong = await route.POST(request("POST", { name: "a".repeat(31), style: {} }));
    expect(tooLong.status).toBe(400);
    const tooLongData = (await tooLong.json()) as { error: string };
    expect(tooLongData.error).toContain("模板名称不能超过 30 字");
  });

  it("POST 缺少 style 返回 400 样式参数无效", async () => {
    const route = await import("../route");
    const res = await route.POST(request("POST", { name: "无样式模板" }));
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("样式参数无效");
    const rows = db?.prepare("SELECT COUNT(*) AS n FROM resume_templates").get() as { n: number } | undefined;
    expect(rows?.n).toBe(0);
  });
});
