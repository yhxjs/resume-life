import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

/**
 * 客户端包不得触达 Node 内建模块。
 *
 * 这条边界此前是「人肉逐层看 import」维护的：`src/lib/scores.ts` 里放了一个
 * `getOverallScore()`，它 import 了 `getDb`，于是九个 `"use client"` 组件
 * 顺着 `scores.ts → db.ts → node:sqlite` 一路把服务端模块拖进浏览器包。
 * `next build` 直接以 TurbopackInternalError 失败，而 `npm run typecheck`
 * 与 `npm test` 都不会发现——前者不打包，后者在 Node 环境跑。
 *
 * 所以这里做传递闭包检查：从每个 `"use client"` 文件出发，只沿**值导入**
 * 走（`import type` 编译期擦除，不算），一旦遇到 `node:` 前缀即判失败。
 */
const SRC_DIR = path.join(process.cwd(), "src");

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (/\.tsx?$/u.test(entry.name)) found.push(full);
  }
  return found;
}

/** 模块说明符列表，跳过 `import type` 与纯类型具名导入 */
function valueImports(source: string): string[] {
  const specs: string[] = [];
  const statement = /(?:^|\n)\s*import\s+(?!type\s)([\s\S]*?)\s*from\s+["']([^"']+)["']/gu;
  for (const match of source.matchAll(statement)) {
    const clause = match[1]!;
    const named = clause.match(/\{([\s\S]*)\}/u);
    if (named) {
      const values = named[1]!
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part && !part.startsWith("type "));
      if (values.length === 0) continue;
    }
    specs.push(match[2]!);
  }
  for (const match of source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/gu)) specs.push(match[1]!);
  return specs;
}

type Graph = {
  imports: Map<string, string[]>;
  resolve: (from: string, specifier: string) => string | null;
};

/** 从入口出发找第一条抵达 Node 内建的引用链；没有则返回 null */
function nodeBuiltinTrail(entry: string, graph: Graph): string[] | null {
  const seen = new Set<string>();
  const stack: { file: string; trail: string[] }[] = [{ file: entry, trail: [entry] }];
  while (stack.length > 0) {
    const { file, trail } = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const specifier of graph.imports.get(file) ?? []) {
      if (specifier.startsWith("node:")) return [...trail, specifier];
      const next = graph.resolve(file, specifier);
      if (next) stack.push({ file: next, trail: [...trail, next] });
    }
  }
  return null;
}

function resolveModule(from: string, specifier: string): string | null {
  const base = specifier.startsWith("@/")
    ? path.join(SRC_DIR, specifier.slice(2))
    : specifier.startsWith(".")
      ? path.resolve(path.dirname(from), specifier)
      : null;
  if (!base) return null;
  for (const candidate of [base + ".ts", base + ".tsx", path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function format(trail: string[]): string {
  return trail
    .map((item) => (item.startsWith("node:") ? item : path.relative(process.cwd(), item).replaceAll("\\", "/")))
    .join(" -> ");
}

describe("客户端包的服务端边界", () => {
  const files = sourceFiles(SRC_DIR);
  const graph: Graph = {
    imports: new Map(files.map((file) => [file, valueImports(fs.readFileSync(file, "utf8"))])),
    resolve: resolveModule,
  };
  const clientEntries = files.filter((file) => /^\s*["']use client["']/mu.test(fs.readFileSync(file, "utf8")));

  it("检查器能发现传递引用（守卫自身有效）", () => {
    const probe: Graph = {
      imports: new Map([
        ["entry.tsx", ["@/lib/pure"]],
        ["pure.ts", ["@/lib/db"]],
        ["db.ts", ["node:sqlite"]],
      ]),
      resolve: (from, specifier) => {
        const table: Record<string, Record<string, string>> = {
          "entry.tsx": { "@/lib/pure": "pure.ts" },
          "pure.ts": { "@/lib/db": "db.ts" },
        };
        return table[from]?.[specifier] ?? null;
      },
    };
    expect(nodeBuiltinTrail("entry.tsx", probe)).toEqual(["entry.tsx", "pure.ts", "db.ts", "node:sqlite"]);
  });

  it("只走值导入：`import type` 链条不算泄漏", () => {
    const probe: Graph = {
      imports: new Map([
        ["entry.tsx", ["@/lib/types-only"]],
        ["types-only.ts", []],
      ]),
      resolve: (from, specifier) => (from === "entry.tsx" && specifier === "@/lib/types-only" ? "types-only.ts" : null),
    };
    expect(nodeBuiltinTrail("entry.tsx", probe)).toBeNull();
  });

  it("没有客户端组件能传递地引用到 node: 内建模块", () => {
    const leaks = clientEntries
      .map((entry) => nodeBuiltinTrail(entry, graph))
      .filter((trail): trail is string[] => trail !== null)
      .map(format);
    expect(leaks).toEqual([]);
  });

  it("客户端入口自身不被当成纯类型模块跳过（入口集合非空）", () => {
    expect(clientEntries.length).toBeGreaterThan(10);
  });

  it("客户端请求必须经过 apiFetch，包含 JSON、SSE 和文件上传下载", () => {
    const seen = new Set<string>();
    const stack = [...clientEntries];
    const directFetches: string[] = [];
    while (stack.length) {
      const file = stack.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      if (file !== path.join(SRC_DIR, "lib", "api-fetch.ts")) {
        const tree = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
        const visit = (node: ts.Node) => {
          if (ts.isCallExpression(node) && ((ts.isIdentifier(node.expression) && node.expression.text === "fetch")
            || (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
              && ["window", "globalThis"].includes(node.expression.expression.text) && node.expression.name.text === "fetch"))) {
            directFetches.push(path.relative(SRC_DIR, file));
          }
          ts.forEachChild(node, visit);
        };
        visit(tree);
      }
      for (const specifier of graph.imports.get(file) ?? []) {
        const next = graph.resolve(file, specifier);
        if (next) stack.push(next);
      }
    }
    expect(directFetches).toEqual([]);
    expect(seen.has(path.join(SRC_DIR, "lib", "api-fetch.ts"))).toBe(true);
  });
});
