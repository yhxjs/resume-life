import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * RESUME_LIFE_DATA_DIR 的启动期校验。
 *
 * 校验点在 db.ts 的模块加载期，因此每条用例都要 resetModules 后重新导入。
 * process.exit(1) 会直接干掉测试进程，所以必须替换成抛错。
 */
function exitSpy() {
  return vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as never);
}

async function loadDb() {
  return import("../db");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("RESUME_LIFE_DATA_DIR 启动期校验", () => {
  it.each([true, false])("新库及未配置提示保留状态但不泄露真实敏感目录（configured=%s）", async (configured) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-datadir-"));
    const directory = path.join(root, "private-user-sensitive-company");
    fs.mkdirSync(directory);
    const originalDirectory = process.cwd();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RESUME_LIFE_DATA_DIR", configured ? directory : "");
    let database: ReturnType<(typeof import("../db"))["getDb"]> | undefined;
    try {
      process.chdir(directory);
      vi.resetModules();
      database = (await loadDb()).getDb();
      expect(warn.mock.calls.flat().join(" ")).toContain("新建数据库");
      if (!configured) expect(warn.mock.calls.flat().join(" ")).toContain("RESUME_LIFE_DATA_DIR 未设置");
      database.close();
      database = undefined;
      vi.resetModules();
      database = (await loadDb()).getDb();
      if (!configured) expect(warn.mock.calls.flat().join(" ")).toContain("使用当前工作目录下的数据目录");
      const logs = [...warn.mock.calls, ...error.mock.calls, ...info.mock.calls].flat().join(" ");
      expect(logs).not.toContain(directory);
      expect(logs).not.toContain("private-user-sensitive-company");
      expect(logs).not.toContain("resume-life.db");
      expect(logs).toContain("db.open");
    } finally {
      database?.close();
      process.chdir(originalDirectory);
      if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("resume-life-datadir-")) {
        throw new Error("Unsafe cleanup path");
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("目录不存在时只记一条 warn，不创建目录也不退出", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-datadir-"));
    const missing = path.join(root, "typo", "data");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const exit = exitSpy();
    vi.stubEnv("RESUME_LIFE_DATA_DIR", missing);
    vi.resetModules();

    const { DATA_DIR } = await loadDb();
    expect(DATA_DIR).toBe(path.resolve(missing));
    // 只 stat 不创建：构建期追踪检查依赖「启动不碰数据目录」这一约定
    expect(fs.existsSync(path.join(root, "typo"))).toBe(false);
    expect(warn.mock.calls.flat().join(" ")).toContain("data-directory-will-be-created");
    expect(exit).not.toHaveBeenCalled();

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("相对路径直接退出：解析基准是 process.cwd()，换个启动目录就换了库", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    exitSpy();
    vi.stubEnv("RESUME_LIFE_DATA_DIR", "relative-data");
    vi.resetModules();

    await expect(loadDb()).rejects.toThrow(/process\.exit\(1\)/);
    expect(warn.mock.calls.flat().join(" ")).toContain("relative-data-directory");
  });

  it("已存在的目录正常放行", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-datadir-"));
    const ready = path.join(root, "ready");
    fs.mkdirSync(ready);
    const exit = exitSpy();
    vi.stubEnv("RESUME_LIFE_DATA_DIR", ready);
    vi.resetModules();

    const { DATA_DIR } = await loadDb();
    expect(DATA_DIR).toBe(path.resolve(ready));
    expect(exit).not.toHaveBeenCalled();

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("最近的已存在祖先是文件而不是目录时退出", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-datadir-"));
    const filePath = path.join(root, "not-a-dir");
    fs.writeFileSync(filePath, "x");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    exitSpy();
    vi.stubEnv("RESUME_LIFE_DATA_DIR", path.join(filePath, "data"));
    vi.resetModules();

    await expect(loadDb()).rejects.toThrow(/process\.exit\(1\)/);
    expect(warn.mock.calls.flat().join(" ")).toContain("data-directory-parent-not-directory");

    fs.rmSync(root, { recursive: true, force: true });
  });

  it("未设置该变量时不校验，落回项目内的 data/", async () => {
    const exit = exitSpy();
    vi.stubEnv("RESUME_LIFE_DATA_DIR", "");
    vi.resetModules();

    const { DATA_DIR } = await loadDb();
    expect(DATA_DIR).toBe(path.join(process.cwd(), "data"));
    expect(exit).not.toHaveBeenCalled();
  });

  it("测试进程没有隔离目录时拒绝打开默认业务库", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("RESUME_LIFE_DATA_DIR", "");
    vi.resetModules();
    const mkdir = vi.spyOn(fs, "mkdirSync").mockImplementation(() => {
      throw new Error("blocked filesystem write");
    });

    const { getDb } = await loadDb();
    expect(() => getDb()).toThrow(/测试进程.*数据目录/);
    expect(mkdir).not.toHaveBeenCalled();
  });
});
