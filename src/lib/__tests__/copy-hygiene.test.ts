import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC_DIR = path.join(process.cwd(), "src");
const CODE_EXTENSIONS = new Set([".ts", ".tsx"]);

/** 助手口癖字符 U+55B5，用码点构造以免本文件自身命中检查 */
const ASSISTANT_TIC = String.fromCharCode(0x55b5);

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return entry.isFile() && CODE_EXTENSIONS.has(path.extname(entry.name)) ? [entryPath] : [];
  });
}

describe("用户可见文案卫生", () => {
  it("生产代码与测试中不出现助手口癖字符", () => {
    const offenders = sourceFiles(SRC_DIR)
      .filter((file) => fs.readFileSync(file, "utf8").includes(ASSISTANT_TIC))
      .map((file) => path.relative(process.cwd(), file).replaceAll("\\", "/"));

    expect(offenders).toEqual([]);
  });
});
