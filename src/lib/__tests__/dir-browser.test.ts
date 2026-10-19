import fs from "node:fs";
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
  it("caps entries and reports truncation for very large directories", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-browser-"));
    fixtures.push(directory);
    // 截断测试只依赖临时目录；宿主机器上的网络映射盘可能离线或响应极慢。
    const exists = fs.existsSync;
    vi.spyOn(fs, "existsSync").mockImplementation((target) => (
      typeof target === "string" && /^[A-Z]:\\$/i.test(target)
        ? target.toLowerCase() === path.parse(directory).root.toLowerCase()
        : exists(target)
    ));
    for (let index = 0; index < MAX_DIRECTORY_ENTRIES + 20; index += 1) {
      fs.mkdirSync(path.join(directory, `child-${index}`));
    }
    const result = listDirectory(directory);
    expect(result.entries).toHaveLength(MAX_DIRECTORY_ENTRIES);
    expect(result.truncated).toBe(true);
  });
});
