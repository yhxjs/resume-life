import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { getRootDirs } = require("@next/eslint-plugin-next/dist/utils/get-root-dirs") as {
  getRootDirs(context: {
    cwd: string;
    settings: { next?: { rootDir?: string | string[] } };
  }): string[];
};

const fixture = mkdtempSync(path.join(process.cwd(), ".codex-next-eslint-"));
const normalized = (relative: string) => path.join(fixture, relative).replace(/\\/g, "/");
const roots = (rootDir?: string | string[]) =>
  getRootDirs({ cwd: fixture, settings: { next: { rootDir } } }).sort();

beforeAll(() => {
  for (const directory of ["apps/web/pages", "apps/admin/pages", "apps/.hidden", "apps/app1", "apps/app2", "literal(abc)", "literal[abc]", "literal{abc}"]) {
    mkdirSync(path.join(fixture, directory), { recursive: true });
  }
  writeFileSync(path.join(fixture, "apps/readme.txt"), "fixture");
});

afterAll(() => {
  if (path.dirname(fixture) !== process.cwd() || !path.basename(fixture).startsWith(".codex-next-eslint-")) {
    throw new Error("Next ESLint 测试清理目录不在预期工作区内");
  }
  rmSync(fixture, { recursive: true, force: true });
});

describe("Next ESLint rootDir 兼容性", () => {
  it("缺省使用 context.cwd", () => {
    expect(roots()).toEqual([fixture]);
  });

  it("显式目录只返回该目录，不展开子目录", () => {
    expect(roots(normalized("apps/web"))).toEqual([normalized("apps/web")]);
  });

  it("保留显式目录输入的末尾斜杠", () => {
    expect(roots(`${normalized("apps/web")}/`)).toEqual([`${normalized("apps/web")}/`]);
  });

  it("保留相对目录输入", () => {
    const relative = path.relative(process.cwd(), path.join(fixture, "apps/web")).replace(/\\/g, "/");
    expect(roots(relative)).toEqual([relative]);
  });

  it("保留显式目录的 ./ 前缀", () => {
    const relative = `./${path.relative(process.cwd(), path.join(fixture, "apps/web")).replace(/\\/g, "/")}`;
    expect(roots(relative)).toEqual([relative]);
  });

  it.each(["", "./"])("保留相对通配的 %s 前缀", (prefix) => {
    const relative = path.relative(process.cwd(), fixture).replace(/\\/g, "/");
    expect(roots(`${prefix}${relative}/apps/*`)).toEqual(
      ["admin", "app1", "app2", "web"].map((name) => `${prefix}${relative}/apps/${name}`).sort(),
    );
  });

  it("保留文件系统根目录的末尾斜杠", () => {
    const root = path.parse(fixture).root.replace(/\\/g, "/");
    expect(roots(root)).toEqual([root]);
  });

  it("不存在的显式目录返回空数组", () => {
    expect(roots(normalized("apps/missing"))).toEqual([]);
  });

  it("通配只返回目录，排除文件和隐藏目录", () => {
    expect(roots(normalized("apps/*"))).toEqual(
      ["apps/admin", "apps/app1", "apps/app2", "apps/web"].map(normalized).sort(),
    );
  });

  it("目录通配模式末尾斜杠不进入结果", () => {
    expect(roots(`${normalized("apps/*")}/`)).toEqual(
      ["apps/admin", "apps/app1", "apps/app2", "apps/web"].map(normalized).sort(),
    );
  });

  it.each(["apps/**", "apps/**/", "apps/*/**", "apps/*/**/"])("递归模式 %s 保留原有扫描边界", (pattern) => {
    expect(roots(normalized(pattern))).toEqual(
      ["apps/admin", "apps/admin/pages", "apps/app1", "apps/app2", "apps/web", "apps/web/pages"].map(normalized).sort(),
    );
  });

  it("brace 递归模式排除每个备选扫描根", () => {
    expect(roots(normalized("apps/{web,admin}/**"))).toEqual(
      [normalized("apps/admin/pages"), normalized("apps/web/pages")],
    );
  });

  it("保留递归模式中间段匹配", () => {
    expect(roots(normalized("apps/**/pages"))).toEqual(
      [normalized("apps/admin/pages"), normalized("apps/web/pages")],
    );
  });

  it("裸括号按原 glob 语义匹配", () => {
    expect(roots(normalized("literal(abc)"))).toEqual([]);
  });

  it.each(["literal[abc]", "literal{abc}"])("保留字面量目录 %s", (directory) => {
    expect(roots(normalized(directory))).toEqual([normalized(directory)]);
  });

  it("保留 brace 备选匹配", () => {
    expect(roots(normalized("apps/{web,admin}"))).toEqual(
      [normalized("apps/admin"), normalized("apps/web")],
    );
  });

  it("brace 空分支保留基目录", () => {
    expect(roots(normalized("apps/{web,}"))).toEqual([
      `${normalized("apps")}/`, normalized("apps/web"),
    ]);
  });

  it.each(["apps/./*", "apps/../apps/*", "apps/web/../*"])("静态前缀 %s 不丢失匹配目录", (pattern) => {
    expect(roots(`${fixture.replace(/\\/g, "/")}/${pattern}`).map((directory) => path.resolve(directory)).sort()).toEqual(
      ["apps/admin", "apps/app1", "apps/app2", "apps/web"].map((directory) => path.resolve(normalized(directory))).sort(),
    );
  });

  it("保留 brace 数字范围匹配", () => {
    expect(roots(normalized("apps/app{1..2}"))).toEqual(
      [normalized("apps/app1"), normalized("apps/app2")],
    );
  });

  it("数组分别展开目录和模式", () => {
    expect(roots([normalized("apps/web"), normalized("apps/app*")])).toEqual(
      ["apps/web", "apps/app1", "apps/app2"].map(normalized).sort(),
    );
  });

  it("规范化 Windows 反斜杠路径", () => {
    expect(roots(normalized("apps/web").replace(/\//g, "\\"))).toEqual([
      normalized("apps/web"),
    ]);
  });
});
