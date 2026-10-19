import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
) as {
  scripts: { dev: string; start: string; "pretest:coverage"?: string };
  dependencies: Record<string, string>;
};
const layoutSource = fs.readFileSync(path.join(process.cwd(), "src/app/layout.tsx"), "utf8");
const globalStyles = fs.readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");

describe("运行时脚本契约", () => {
  it("覆盖率测试先执行 Node 版本门禁", () => {
    expect(packageJson.scripts["pretest:coverage"]).toBe("node scripts/check-runtime.mjs");
  });

  it("开发服务器只监听回环地址", () => {
    expect(packageJson.scripts.dev).toMatch(/next dev --hostname 127\.0\.0\.1(?:\s|$)/);
    expect(packageJson.scripts.dev).toMatch(/--port 3714(?:\s|$)/);
  });

  it("生产服务器只监听回环地址", () => {
    expect(packageJson.scripts.start).toMatch(/next start --hostname 127\.0\.0\.1(?:\s|$)/);
    expect(packageJson.scripts.start).toMatch(/--port 3714(?:\s|$)/);
  });

  it("中文字体使用系统回退链且不打包 Noto Web Font", () => {
    expect(layoutSource).not.toContain("@fontsource/noto-");
    expect(globalStyles).not.toContain("--font-noto-");
    expect(packageJson.dependencies).not.toHaveProperty("@fontsource/noto-sans-sc");
    expect(packageJson.dependencies).not.toHaveProperty("@fontsource/noto-serif-sc");
    expect(globalStyles).toMatch(/--font-sans:[\s\S]*?"PingFang SC"[\s\S]*?"Hiragino Sans GB"[\s\S]*?"Microsoft YaHei"[\s\S]*?;/u);
    expect(globalStyles).toMatch(/--font-serif:[\s\S]*?"Songti SC"[\s\S]*?"SimSun"[\s\S]*?;/u);
  });
});
