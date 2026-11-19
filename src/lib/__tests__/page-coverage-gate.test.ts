import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const script = path.resolve(process.cwd(), "scripts/check-page-coverage.mjs");
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "page-coverage-gate-"));
fs.mkdirSync(path.join(directory, "coverage"));
const criticalPages = [
  "src/app/page.tsx",
  "src/app/applications/page.tsx",
  "src/app/bank/page.tsx",
  "src/app/resumes/[id]/page.tsx",
  "src/app/resumes/[id]/print/page.tsx",
  "src/app/settings/page.tsx",
  "src/app/settings/usage/page.tsx",
  "src/app/tools/page.tsx",
  "src/app/resumes/page.tsx",
  "src/app/knowledge/page.tsx",
  "src/app/drills/page.tsx",
  "src/app/intros/page.tsx",
  "src/app/notebook/page.tsx",
  "src/app/review/page.tsx",
  "src/app/styles/page.tsx",
  "src/app/tools/decoder/page.tsx",
  "src/app/tools/jd/page.tsx",
  "src/app/tools/salary/page.tsx",
  "src/app/login/page.tsx",
];
afterAll(() => {
  fs.rmSync(path.join(directory, "coverage/lcov.info"), { force: true });
  fs.rmdirSync(path.join(directory, "coverage"));
  fs.rmdirSync(directory);
});

function runGate(
  hits: number[],
  { files = 38, lines = 2250, windowsPaths = false, extraRecord = "" } = {},
) {
  const records = Array.from({ length: files }, (_, index) => {
    const filename = criticalPages[index] ?? `src/app/sample-${index}/page.tsx`;
    const fileLines = Math.floor(lines / files) + (index < lines % files ? 1 : 0);
    return `SF:${windowsPaths ? filename.replaceAll("/", "\\") : filename}\nLF:${fileLines}\nLH:${hits[index] ?? 0}\nend_of_record`;
  });
  fs.writeFileSync(path.join(directory, "coverage/lcov.info"), `${records.join("\n")}\n${extraRecord}`);
  return spawnSync(process.execPath, [script], { cwd: directory, encoding: "utf8" });
}

describe("页面覆盖门禁的合成 LCOV 契约", () => {
  const baselineHits = [18, ...Array<number>(33).fill(54)];

  it("拒绝原始 17 行、单文件的首页孤岛", () => {
    const result = runGate([17]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("页面/布局单测覆盖未达基线");
  });

  it("拒绝退化到 403 行、23 个文件，即使关键页面仍命中", () => {
    const result = runGate([7, ...Array<number>(22).fill(18)]);
    expect(result.stdout).toContain("403/2250 行，23/38 个文件");
    expect(result.status).toBe(1);
  });

  it("拒绝仅 1799 行命中，即使覆盖占比和文件数足够", () => {
    expect(runGate([17, ...Array<number>(33).fill(54)], { lines: 2240 }).status).toBe(1);
  });

  it("拒绝仅 33 个页面命中，即使达到覆盖行数", () => {
    expect(runGate([40, ...Array<number>(32).fill(55)]).status).toBe(1);
  });

  it("拒绝首页失去覆盖，即使其他页面足够", () => {
    expect(runGate([0, ...Array<number>(34).fill(54)]).status).toBe(1);
  });

  it("拒绝报告排除页面导致分母缩小", () => {
    expect(runGate(baselineHits, { files: 37 }).status).toBe(1);
    expect(runGate(baselineHits, { lines: 2099 }).status).toBe(1);
  });

  it("拒绝覆盖占比跌破 80%，即使行数和文件数达标", () => {
    expect(runGate(baselineHits, { lines: 2251 }).status).toBe(1);
  });

  it("在 1800 行、34 个页面、80% 的边界通过，且支持 Windows 路径", () => {
    const result = runGate(baselineHits, { windowsPaths: true });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("1800/2250 行，34/38 个文件");
  });

  it("1928 行、34 个文件的实测水位通过", () => {
    const result = runGate([47, ...Array<number>(33).fill(57)], { lines: 2292 });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("1928/2292 行，34/38 个文件");
  });

  it("旧 920 行、33 个文件水位不再满足当前基线", () => {
    expect(runGate([24, ...Array<number>(32).fill(28)], { lines: 1831 }).status).toBe(1);
  });

  it("拒绝关键页面零命中，即使总体覆盖行数与文件数足够", () => {
    const hits = [...baselineHits, 54];
    hits[2] = 0;
    expect(runGate(hits).status).toBe(1);
  });

  it("登录页失去覆盖时拒绝，即使总体指标仍达标", () => {
    const hits = [...baselineHits, 54];
    hits[criticalPages.indexOf("src/app/login/page.tsx")] = 0;
    expect(runGate(hits).status).toBe(1);
  });

  it("API 命中不能代替页面命中", () => {
    const result = runGate([17], {
      extraRecord: "SF:src/app/api/projects/route.ts\nLF:1000\nLH:1000\nend_of_record\n",
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("17/2250 行，1/38 个文件");
  });
});
