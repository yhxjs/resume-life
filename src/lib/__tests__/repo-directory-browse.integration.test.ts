import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import io from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let directory: string;
let target: string;
let db: DatabaseSync;
const prefix = "resume-life-browse-api-";

beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  target = path.join(directory, "target");
  fs.mkdirSync(target);
  vi.stubEnv("RESUME_LIFE_DATA_DIR", path.join(directory, "data"));
  db = (await import("../db")).getDb();
  db.exec("INSERT INTO projects (id,name,summary,created_at,updated_at) VALUES (1,'目录浏览','{}','','')");
});

afterEach(() => {
  vi.restoreAllMocks();
  db?.close();
  vi.unstubAllEnvs();
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(prefix)) throw new Error("Unsafe cleanup path");
  fs.rmSync(resolved, { recursive: true, force: true });
});

async function browse(browsePath?: string, id = "1", signal?: AbortSignal) {
  const before = db.prepare("SELECT * FROM projects ORDER BY id").all();
  const { GET } = await import("@/app/api/projects/[id]/scan-repo/route");
  const url = new URL(`http://localhost/api/projects/${id}/scan-repo?action=browse`);
  if (browsePath !== undefined) url.searchParams.set("path", browsePath);
  const response = await GET(new Request(url, { signal }), { params: Promise.resolve({ id }) });
  expect(db.prepare("SELECT * FROM projects ORDER BY id").all()).toEqual(before);
  expect(db.prepare("SELECT COUNT(*) AS total FROM project_summary_history").get()).toMatchObject({ total: 0 });
  expect(db.prepare("SELECT COUNT(*) AS total FROM project_materials").get()).toMatchObject({ total: 0 });
  expect(response.headers.get("cache-control")).toContain("no-store");
  return response;
}

function failRead(failedPath: string, code: string) {
  const read = io.readdir;
  vi.spyOn(io, "readdir").mockImplementation((async (requested: fs.PathLike, options: unknown) => {
    if (String(requested) === failedPath) throw Object.assign(new Error("SYNTHETIC_PRIVATE_PATH"), { code });
    return read(requested, options as Parameters<typeof read>[1]);
  }) as typeof read);
  const open = io.opendir;
  vi.spyOn(io, "opendir").mockImplementation(async (requested, options) => {
    if (String(requested) === failedPath) throw Object.assign(new Error("SYNTHETIC_PRIVATE_PATH"), { code });
    return open(requested, options);
  });
}

describe("真实目录浏览接口的失败语义", () => {
  it("空目录成功；仅未指定路径时使用主目录", async () => {
    vi.spyOn(os, "homedir").mockReturnValue(target);
    for (const requested of [target, undefined]) {
      const response = await browse(requested);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ currentPath: target, entries: [], truncated: false });
    }
  });

  it("目标不存在返回404，创建后显式重试恢复原目标", async () => {
    const missing = path.join(target, "missing");
    const rejected = await browse(missing);
    expect(rejected.status).toBe(404);
    expect(await rejected.json()).toEqual({ error: "目录不存在，请检查路径后重试" });
    fs.mkdirSync(missing);
    const retried = await browse(missing);
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ currentPath: missing, entries: [] });
  });

  it("普通文件返回400，不回退到主目录", async () => {
    const filename = path.join(target, "note.txt");
    fs.writeFileSync(filename, "合成内容");
    const response = await browse(filename);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "目标路径不是文件夹，请选择目录" });
  });

  it("NUL路径返回400", async () => {
    const response = await browse(`${target}\0private`);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "目录路径包含非法字符，请检查后重试" });
  });

  it.each(["EACCES", "EPERM"])("读取根目录遇到%s返回403且不泄露底层详情", async code => {
    failRead(target, code);
    const response = await browse(target);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "无权读取此目录，请选择有访问权限的文件夹" });
  });

  it.each([
    ["ENOENT", 404, "目录不存在，请检查路径后重试"],
    ["ENOTDIR", 400, "目标路径不是文件夹，请选择目录"],
  ])("stat后读取遇到%s仍返回对应状态", async (code, status, error) => {
    failRead(target, code as string);
    const response = await browse(target);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
  });

  it("未分类读取故障使用统一500脱敏响应", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    failRead(target, "EIO");
    const response = await browse(target);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "服务器内部错误，请稍后重试", requestId: expect.any(String) });
    expect(JSON.stringify(log.mock.calls)).not.toContain("SYNTHETIC_PRIVATE_PATH");
  });

  it("无法探测子目录标识不阻止父目录列表", async () => {
    const child = path.join(target, "child");
    fs.mkdirSync(child);
    failRead(child, "EACCES");
    const response = await browse(target);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ currentPath: target, entries: [{ name: "child", path: child, hasMarkers: false }] });
  });

  it.each([["0", 400, "无效的项目 ID"], ["999", 404, "项目不存在"]])("项目%s优先验证，失败不访问指定目录", async (id, status, error) => {
    const stat = vi.spyOn(io, "stat");
    const response = await browse(target, id as string);
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
    expect(stat.mock.calls.some(([requested]) => String(requested) === target)).toBe(false);
  });

  it("已取消的浏览请求返回499且不读盘、不写入", async () => {
    const controller = new AbortController();
    controller.abort();
    const stat = vi.spyOn(io, "stat");
    const response = await browse(target, "1", controller.signal);
    expect(response.status).toBe(499);
    expect(await response.json()).toEqual({ error: "请求已取消" });
    expect(stat.mock.calls.some(([requested]) => String(requested) === target)).toBe(false);
  });

  it("目录慢读期间其他接口可响应，取消后不继续探测子目录", async () => {
    const controller = new AbortController();
    const original = io.readdir;
    const release = Promise.withResolvers<void>();
    let started = false;
    vi.spyOn(io, "readdir").mockImplementation((async (...args: Parameters<typeof io.readdir>) => {
      if (String(args[0]) === target) { started = true; await release.promise; }
      return original(...args);
    }) as typeof io.readdir);
    const open = vi.spyOn(io, "opendir");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const pending = browse(target, "1", controller.signal);
    try {
      await expect.poll(() => started).toBe(true);
      const { GET } = await import("@/app/api/projects/[id]/route");
      const other = await GET(new Request("http://localhost/api/projects/1"), { params: Promise.resolve({ id: "1" }) });
      expect(other.status).toBe(200);
      expect(await other.json()).toMatchObject({ id: 1, name: "目录浏览" });
      controller.abort();
      release.resolve();
      const response = await pending;
      expect(response.status).toBe(499);
      expect(await response.json()).toEqual({ error: "请求已取消" });
      expect(open).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
    } finally {
      controller.abort(); release.resolve(); await pending;
    }
  });
});
