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
];
afterAll(() => {
  fs.rmSync(path.join(directory, "coverage/lcov.info"), { force: true });
  fs.rmdirSync(path.join(directory, "coverage"));
  fs.rmdirSync(directory);
});

function runGate(
  hits: number[],
  { files = 38, lines = 1831, windowsPaths = false, extraRecord = "" } = {},
) {
  const records = Array.from({ length: files }, (_, index) => {
    const filename = criticalPages[index] ?? `src/app/sample-${index}/page.tsx`;
    return `SF:${windowsPaths ? filename.replaceAll("/", "\\") : filename}\nLF:${index === 0 ? lines - (files - 1) * 45 : 45}\nLH:${hits[index] ?? 0}\nend_of_record`;
  });
  fs.writeFileSync(path.join(directory, "coverage/lcov.info"), `${records.join("\n")}\n${extraRecord}`);
  return spawnSync(process.execPath, [script], { cwd: directory, encoding: "utf8" });
}

describe("页面覆盖门禁的合成 LCOV 契约", () => {
  const baselineHits = [32, ...Array<number>(31).fill(28)];

  it("拒绝原始 17 行、单文件的首页孤岛", () => {
    const result = runGate([17]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("页面/布局单测覆盖未达基线");
  });

  it("拒绝退化到 403 行、23 个文件，即使关键页面仍命中", () => {
    const result = runGate([7, ...Array<number>(22).fill(18)]);
    expect(result.stdout).toContain("403/1831 行，23/38 个文件");
    expect(result.status).toBe(1);
  });

  it("拒绝仅 899 行命中，即使覆盖占比和文件数足够", () => {
    expect(runGate([31, ...Array<number>(31).fill(28)]).status).toBe(1);
  });

  it("拒绝仅 31 个页面命中，即使达到覆盖行数", () => {
    expect(runGate([60, ...Array<number>(30).fill(28)]).status).toBe(1);
  });

  it("拒绝首页失去覆盖，即使其他页面足够", () => {
    expect(runGate([0, 32, ...Array<number>(31).fill(28)]).status).toBe(1);
  });

  it("拒绝报告排除页面导致分母缩小", () => {
    expect(runGate(baselineHits, { files: 32 }).status).toBe(1);
    expect(runGate(baselineHits, { files: 33, lines: 1585 }).status).toBe(1);
  });

  it("拒绝覆盖占比跌破 49%，即使行数和文件数达标", () => {
    expect(runGate(baselineHits, { lines: 1837 }).status).toBe(1);
  });

  it("在 900 行、32 个页面的边界通过，且支持 Windows 路径", () => {
    const result = runGate(baselineHits, { windowsPaths: true });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("900/1831 行，32/38 个文件");
  });

  it("当前 920 行、33 个文件的实测水位通过", () => {
    const result = runGate([24, ...Array<number>(32).fill(28)]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("920/1831 行，33/38 个文件");
  });

  it("拒绝关键页面零命中，即使总体覆盖行数与文件数足够", () => {
    const hits = [...baselineHits, 28];
    hits[2] = 0;
    expect(runGate(hits).status).toBe(1);
  });

  it("API 命中不能代替页面命中", () => {
    const result = runGate([17], {
      extraRecord: "SF:src/app/api/projects/route.ts\nLF:1000\nLH:1000\nend_of_record\n",
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("17/1831 行，1/38 个文件");
  });
});
