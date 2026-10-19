import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMP_PREFIX = "resume-life-resumes-route-test-";

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
  new Request("http://127.0.0.1/api/resumes", {
    method,
    headers: { "content-type": "application/json", origin: "http://127.0.0.1", host: "127.0.0.1" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

describe("GET/POST /api/resumes 简历列表", () => {
  it.each([null, [], "invalid", { basic: { name: 123 } }, { education: [{ school: 123 }] }, { skills: { items: [123] } }].map((modules) => ({ modules })))(
    "POST 拒绝错误模块输入 $modules 且不写入任何行", async ({ modules }) => {
      const { POST } = await import("../route");
      expect((await POST(request("POST", { title: "错误导入", modules }))).status).toBe(400);
      expect(db?.prepare("SELECT COUNT(*) AS n FROM resumes").get()).toEqual({ n: 0 });
      expect(db?.prepare("SELECT COUNT(*) AS n FROM resume_modules").get()).toEqual({ n: 0 });
    }
  );

  it("POST 接受合法的部分模块，省略部分仍初始化默认值", async () => {
    const { POST } = await import("../route");
    const response = await POST(request("POST", { title: "合法导入", modules: {
      basic: { name: "测试姓名", email: "synthetic@example.invalid" }, education: [{ school: "测试学校" }],
    } }));
    expect(response.status).toBe(201);
    const { id } = await response.json();
    const { loadResume } = await import("@/lib/resumes");
    const result = loadResume(id);
    expect(result?.modules.find((module) => module.key === "basic")?.content).toMatchObject({ name: "测试姓名" });
    expect(result?.modules.find((module) => module.key === "education")?.content).toEqual(expect.arrayContaining([expect.objectContaining({ school: "测试学校" })]));
    expect(result?.modules.find((module) => module.key === "summary")?.content).toEqual({ text: "", descriptionItems: [], descriptionStyle: "unordered" });
  });

  it("POST 创建简历并初始化默认模块，GET 列表可见且 versions 为空数组", async () => {
    const route = await import("../route");
    const post = await route.POST(request("POST", { title: "前端简历" }));
    expect(post.status).toBe(201);
    const created = (await post.json()) as { id: number; title: string };
    expect(created.title).toBe("前端简历");

    const modules = db?.prepare("SELECT COUNT(*) AS n FROM resume_modules WHERE resume_id = ?").get(created.id) as
      | { n: number }
      | undefined;
    expect(modules?.n).toBeGreaterThan(0);

    const get = await route.GET(request("GET"));
    expect(get.status).toBe(200);
    const list = (await get.json()) as { id: number; title: string; versions: unknown[] }[];
    expect(list).toHaveLength(1);
    expect(list[0]?.title).toBe("前端简历");
    expect(list[0]?.versions).toEqual([]);
  });

  it("POST 标题为空（含纯空白）返回 400", async () => {
    const route = await import("../route");
    const empty = await route.POST(request("POST", { title: "" }));
    expect(empty.status).toBe(400);
    const data = (await empty.json()) as { error: string };
    expect(data.error).toContain("简历标题不能为空");

    const blank = await route.POST(request("POST", { title: "   " }));
    expect(blank.status).toBe(400);
  });

  it("POST 请求体不是合法 JSON 返回 400", async () => {
    const route = await import("../route");
    const res = await route.POST(
      new Request("http://127.0.0.1/api/resumes", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1", host: "127.0.0.1" },
        body: "{not-json",
      })
    );
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("请求体必须是有效 JSON");
  });
});
