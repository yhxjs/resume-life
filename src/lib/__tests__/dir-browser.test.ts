import fs from "node:fs";
import io from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listDirectory, MAX_DIRECTORY_ENTRIES } from "../repo-scanner/dir-browser";

const fixtures: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of fixtures.splice(0)) {
    if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-browser-")) {
      throw new Error("Unsafe cleanup path");
    }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("repo-scanner directory browser", () => {
  it("caps entries and reports truncation for very large directories", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-browser-"));
    fixtures.push(directory);
    for (let index = 0; index < MAX_DIRECTORY_ENTRIES + 20; index += 1) {
      fs.mkdirSync(path.join(directory, `child-${index}`));
    }
    const result = await listDirectory(directory);
    expect(result.entries).toHaveLength(MAX_DIRECTORY_ENTRIES);
    expect(result.truncated).toBe(true);
  });

  it("不存在的目标不能静默替换成主目录", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-browser-"));
    fixtures.push(directory);
    await expect(listDirectory(path.join(directory, "missing"))).rejects.toMatchObject({ status: 404, message: "目录不存在，请检查路径后重试" });
  });

  it("普通文件不能作为目录或静默跳到主目录", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-browser-"));
    fixtures.push(directory);
    const filename = path.join(directory, "note.txt");
    fs.writeFileSync(filename, "合成内容");
    await expect(listDirectory(filename)).rejects.toMatchObject({ status: 400, message: "目标路径不是文件夹，请选择目录" });
  });

  it("保留工程标识优先、自然名称排序与隐藏目录过滤", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-browser-"));
    fixtures.push(directory);
    for (const name of ["plain-10", "plain-2", "repo-20", ".private", ".git"]) fs.mkdirSync(path.join(directory, name));
    fs.mkdirSync(path.join(directory, "repo-20", ".git"));
    fs.writeFileSync(path.join(directory, "ordinary.txt"), "合成内容");
    const result = await listDirectory(directory);
    expect(result.entries.map(entry => entry.name)).toEqual(["repo-20", ".git", "plain-2", "plain-10"]);
    expect(result.entries[0]).toMatchObject({ hasMarkers: true });
    expect(result.entries.slice(1).every(entry => !entry.hasMarkers)).toBe(true);
    expect(result.truncated).toBe(false);
  });

  it.each(["EACCES", "EPERM"])("根目录 %s 读取失败不能返回空列表", async code => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-browser-"));
    fixtures.push(directory);
    const read = io.readdir;
    vi.spyOn(io, "readdir").mockImplementation((async (target: fs.PathLike, options: unknown) => {
      if (String(target) === directory) throw Object.assign(new Error("SYNTHETIC_PRIVATE_PATH"), { code });
      return read(target, options as Parameters<typeof read>[1]);
    }) as typeof read);
    await expect(listDirectory(directory)).rejects.toMatchObject({ status: 403, message: "无权读取此目录，请选择有访问权限的文件夹" });
  });
});
