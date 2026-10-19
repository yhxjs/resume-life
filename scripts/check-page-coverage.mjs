import fs from "node:fs";
import path from "node:path";

const COVERAGE_FILE = "coverage/lcov.info";
// 防呆：本检查读取的是 test:coverage 的产物；单独跑本脚本时若报告不存在，
// 给出明确指引而不是抛出难懂的 ENOENT（CI 中 test:coverage 已按正确顺序先执行）。
if (!fs.existsSync(COVERAGE_FILE)) {
  console.error(`未找到 ${COVERAGE_FILE}：请先运行 npm run test:coverage 生成覆盖率报告，再执行本检查。`);
  process.exit(1);
}

// 陈旧提示：覆盖率报告比源码旧时说明快照未反映最新改动，提醒重跑（仅提示，不判失败）。
// src 目录不存在（合成夹具 cwd）或扫描失败时静默跳过——陈旧提示只是锦上添花，不能变成崩溃源。
try {
  const coverageMtime = fs.statSync(COVERAGE_FILE).mtimeMs;
  const newestSourceMtime = fs
    .readdirSync("src", { recursive: true })
    .filter((file) => /\.(?:ts|tsx)$/.test(file))
    .reduce((latest, file) => Math.max(latest, fs.statSync(path.join("src", file)).mtimeMs), 0);
  if (newestSourceMtime > coverageMtime) {
    console.warn("提示：coverage/lcov.info 比部分源码旧，结果可能未反映最新改动；如需精确结论请重新运行 npm run test:coverage。");
  }
} catch {
  // 无 src 目录或 stat 失败：跳过陈旧性提示
}

const records = fs.readFileSync(COVERAGE_FILE, "utf8").split("end_of_record");
const pages = records.flatMap((record) => {
  const filename = /^SF:(.+)$/m.exec(record)?.[1]?.replaceAll("\\", "/");
  if (!filename || !/^src\/app\/(?:.*\/)?(?:page|layout)\.tsx$/u.test(filename)) return [];
  return [{
    filename,
    lines: Number(/^LF:(\d+)$/m.exec(record)?.[1] ?? 0),
    covered: Number(/^LH:(\d+)$/m.exec(record)?.[1] ?? 0),
  }];
});

const lines = pages.reduce((sum, page) => sum + page.lines, 0);
const covered = pages.reduce((sum, page) => sum + page.covered, 0);
const coveredPages = pages.filter((page) => page.covered > 0).length;
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
console.log(`页面/布局单测覆盖：${covered}/${lines} 行，${coveredPages}/${pages.length} 个文件`);
// 2026-10-05 实测 920/1831 行、33/38 文件；保留小幅波动余量，避免大幅退化仍通过。
if (
  pages.length < 33 || lines < 1600 || covered < 900 || coveredPages < 32 ||
  covered / lines < 0.49 ||
  criticalPages.some((filename) => !pages.some((page) => page.filename === filename && page.covered > 0))
) {
  console.error("页面/布局单测覆盖未达基线：至少 900 行、32 个文件、49% 行覆盖率，报告含至少 1600 行/33 个文件且关键入口页面需命中");
  process.exitCode = 1;
}
