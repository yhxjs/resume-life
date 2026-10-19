import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC_DIR = path.join(process.cwd(), "src");
const CODE_EXTENSIONS = new Set([".ts", ".tsx"]);
/** 拆开书写，避免本文件自身命中检查 */
const DEPENDENCY_PATH = ["node", "modules"].join("_") + "/";
/** 真正需要拦下的是「在依赖包目录里读文件」，而非把它当作路径字符串参与断言 */
const FILE_READ_APIS = [
  "readFileSync",
  "readdirSync",
  "existsSync",
  "statSync",
  "createReadStream",
  "copyFileSync",
  "require.resolve",
];

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return entry.isFile() && CODE_EXTENSIONS.has(path.extname(entry.name)) ? [entryPath] : [];
  });
}

describe("测试资产自足性", () => {
  it("测试不在第三方包的私有目录里读取文件", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC_DIR)) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, index) => {
        if (!line.includes(DEPENDENCY_PATH)) return;
        if (!FILE_READ_APIS.some((api) => line.includes(api))) return;
        offenders.push(
          `${path.relative(process.cwd(), file).replaceAll("\\", "/")}:${index + 1}`
        );
      });
    }

    expect(offenders).toEqual([]);
  });
});
