import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CURRENT_DB_VERSION } from "../db-schema";

const root = process.cwd();
const read = (...parts: string[]) => fs.readFileSync(path.join(root, ...parts), "utf8");

const navSource = read("src/components/layout/site-nav.tsx");
const readme = read("README.md");
const requirements = read("docs", "REQUIREMENTS.md");
const product = read("PRODUCT.md");
const apiDoc = read("docs", "API.md");
const troubleshooting = read("docs", "TROUBLESHOOTING.md");

/** 导航项：`{ href: "/x", label: "…" }`，下拉分组的子项与直达链接写法一致 */
function navEntries(): { href: string; label: string }[] {
  return [...navSource.matchAll(/href:\s*"([^"]+)",\s*label:\s*"([^"]+)"/gu)]
    .map(([, href, label]) => ({ href: href!, label: label! }));
}

/** 取文件里某个二级标题到下一个二级标题之间的正文 */
function section(source: string, heading: string): string {
  const start = source.indexOf(heading);
  if (start === -1) return "";
  const rest = source.slice(start + heading.length);
  const end = rest.search(/\n## /u);
  return end === -1 ? rest : rest.slice(0, end);
}

/** 源码树里全部路由文件 → 路径 + 导出的方法名 */
function routes(): { routePath: string; methods: string[] }[] {
  const apiRoot = path.join(root, "src", "app", "api");
  const found: { routePath: string; methods: string[] }[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name === "route.ts") {
        const source = fs.readFileSync(full, "utf8");
        found.push({
          routePath: `/${path.relative(path.join(root, "src", "app"), dir).split(path.sep).join("/")}`,
          methods: [...source.matchAll(/export const (GET|POST|PUT|PATCH|DELETE)\b/gu)]
            .map(([, method]) => method!)
            .sort(),
        });
      }
    }
  };
  walk(apiRoot);
  return found.sort((a, b) => a.routePath.localeCompare(b.routePath));
}

describe("文档能力清单契约", () => {
  it("能从 site-nav.tsx 解析出导航项（提取器自身有效）", () => {
    const entries = navEntries();
    expect(entries.length).toBeGreaterThanOrEqual(12);
    expect(entries.map((e) => e.label)).toContain("错题本");
  });

  it("README 功能清单覆盖全部导航入口", () => {
    const capabilities = section(readme, "## 功能");
    expect(capabilities).not.toBe("");
    // 首页是根路径，不是一项能力，不要求出现在进度清单里
    const missing = navEntries()
      .filter((entry) => entry.href !== "/")
      .filter((entry) => !capabilities.includes(entry.label))
      .map((entry) => entry.label);
    expect(missing).toEqual([]);
  });

  it("REQUIREMENTS 的产品定位覆盖全部导航入口", () => {
    const positioning = section(requirements, "## 1. 产品定位");
    expect(positioning).not.toBe("");
    const missing = navEntries()
      .filter((entry) => entry.href !== "/")
      .filter((entry) => !positioning.includes(entry.label))
      .map((entry) => entry.label);
    expect(missing).toEqual([]);
  });

  it("REQUIREMENTS 的当前认证定位引用 ADR-0004，不沿用无登录决策", () => {
    const positioning = section(requirements, "## 1. 产品定位");
    expect(positioning).toContain("ADR.md#adr-0004");
    expect(positioning).not.toContain("无登录");
    expect(positioning).toContain("登录");
  });

  it("PRODUCT 的能力清单覆盖全部导航入口", () => {
    const missing = navEntries()
      .filter((entry) => entry.href !== "/")
      .filter((entry) => !product.includes(entry.label))
      .map((entry) => entry.label);
    expect(missing).toEqual([]);
  });
});

describe("API 契约文档契约", () => {
  const documented = new Map<string, string[]>();
  for (const [, routePath, methods] of apiDoc.matchAll(/\|\s*`([^`]+)`\s*\|\s*([A-Z, ]+?)\s*\|/gu)) {
    documented.set(routePath!, methods!.split(",").map((m) => m.trim()).sort());
  }

  it("能解析出文档里的端点表（提取器自身有效）", () => {
    expect(documented.get("/api/health")).toEqual(["GET"]);
    expect(documented.get("/api/applications")).toEqual(["GET", "POST"]);
  });

  it("每个 route.ts 的路径与方法都在 docs/API.md 中登记", () => {
    const missing = routes()
      .filter((route) => {
        const listed = documented.get(route.routePath);
        return !listed || listed.join(",") !== route.methods.join(",");
      })
      .map((route) => `${route.routePath} [${route.methods.join(",")}]`);
    expect(missing).toEqual([]);
  });

  it("文档里的端点数量与源码一致，且正文标注的总数正确", () => {
    const total = routes().length;
    // 正文写死的数字同样要跟得上，否则「共 73 个」这种说明会先过期
    expect(apiDoc).toContain(`共 ${total} 个路由文件`);
  });

  it("两个自定义备份请求头都被文档化", () => {
    // 密码走 header 而非 body，是脚本作者最容易踩的坑
    expect(apiDoc).toContain("X-Resume-Life-Backup-Password");
    expect(apiDoc).toContain("X-Resume-Life-Preserve-Ai-Config");
  });

  it("API 描述的数据库版本与当前实现一致", () => {
    const documentedVersion = apiDoc.match(/数据库结构版本为\s*`(\d+)`/u)?.[1];
    expect(Number(documentedVersion)).toBe(CURRENT_DB_VERSION);
  });

  it("README 与排障文档的数据库版本与当前实现一致", () => {
    expect(readme).toContain(`数据库结构版本为 **${CURRENT_DB_VERSION}**`);
    expect(troubleshooting).toContain(`数据库结构版本为 \`${CURRENT_DB_VERSION}\``);
  });
});

describe("运行时版本描述契约", () => {
  it("运行时文档与首版配置示例保持一致", () => {
    expect(troubleshooting).toContain("24.21.0");
    expect(readme).toContain("npm run setup:ocr");
  });
});
