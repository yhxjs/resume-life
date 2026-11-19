import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import nextConfig from "../../../next.config";

import { findMissingParserDependencies, findSensitiveTraceEntries } from "../../../scripts/check-build-trace.mjs";

describe("findSensitiveTraceEntries", () => {
  const projectRoot = path.resolve("fixture-project");
  const tracePath = path.join(
    projectRoot,
    ".next/server/app/api/backup/export/route.js.nft.json",
  );
  const traceEntry = (projectPath: string) => path
    .relative(path.dirname(tracePath), path.join(projectRoot, projectPath))
    .replaceAll("\\", "/");
  const privatePaths = [
    ".git/config", ".claude/config.json", ".impeccable/screenshot.png",
    ".codex-export-results/preview.png", ".codex-preflight-results/preview.png",
    ".codex-preflight-green-results/preview.png", ".playwright-mcp/preview.png",
    ".superpowers/context.json", ".test-artifacts/preview.png", ".tmp-preview/preview.html",
    "coverage/lcov.info", "test-results/trace.zip", "playwright-report/index.html",
    "public/uploads/avatar.png", "docs/design-proposals/preview.html", "docs/superpowers/plan.md",
    "proxy-settings-current.png", "temp_rendered_page.png", "test-worker-dummy.js",
    ".plan.md", ".process.json", ".checklist.json", ".open-source-analysis.md", ".open-source-proposal.md", "server.log", "server-err.log",
    "audit-report-resume-life-2026-09-28.html", "public/highlight-preview.html",
    ".env.local", "nested/.env.production", "nested/private.pem", "nested/private.key",
    "nested/id_rsa", "nested/id_ed25519", "nested/credentials.json", "nested/secrets.yml",
    "nested/.htpasswd", "nested/service-account-private.json", "nested/vault.yml",
  ];

  it("识别 data 目录中的数据库、附属文件和恢复快照", () => {
    const entries = [
      "data/resume-life.db",
      "data/resume-life.db-wal",
      "data/resume-life.db-shm",
      "data/backups/resume-life.db.pre-restore-2026-09-18T00-00-00Z",
      "data/backup/resume-life.db.bak-20260918-000000",
    ].map(traceEntry);

    expect(findSensitiveTraceEntries(tracePath, entries, projectRoot)).toEqual(entries);
  });

  it("忽略 data 目录之外的依赖与静态资源", () => {
    const entries = [
      "node_modules/next/dist/server/next-server.js",
      ".next/static/chunks/app.js",
      "public/icon.png",
      ".env.example",
      "eng.traineddata",
      "chi_sim.traineddata",
    ].map(traceEntry);

    expect(findSensitiveTraceEntries(tracePath, entries, projectRoot)).toEqual([]);
  });

  it("拒绝本地截图、内部文档、上传文件、追踪记录和凭证进入构建清单", () => {
    const entries = privatePaths.map(traceEntry);
    expect(findSensitiveTraceEntries(tracePath, entries, projectRoot)).toEqual(entries);
  });

  it("Next 构建排除规则覆盖同一组私有路径且不排除 OCR 与业务资产", () => {
    const excludes = nextConfig.outputFileTracingExcludes?.["/*"] ?? [];
    const excluded = (filename: string) => excludes.some((pattern) => path.matchesGlob(filename, pattern.replace(/^\.\//, "")));
    for (const filename of privatePaths) expect(excluded(filename), filename).toBe(true);
    for (const filename of ["eng.traineddata", "chi_sim.traineddata", "public/logo.png", "public/favicon.ico"]) {
      expect(excluded(filename), filename).toBe(false);
    }
  });

  it("设置了 RESUME_LIFE_DATA_DIR 时检查的是该目录，而不是项目内的 data/", () => {
    const externalDataDirectory = path.resolve("fixture-external-data");
    const previous = process.env.RESUME_LIFE_DATA_DIR;
    process.env.RESUME_LIFE_DATA_DIR = externalDataDirectory;
    try {
      const externalEntry = path
        .relative(path.dirname(tracePath), path.join(externalDataDirectory, "resume-life.db"))
        .replaceAll("\\", "/");
      const projectDataEntry = traceEntry("data/resume-life.db");

      expect(findSensitiveTraceEntries(tracePath, [externalEntry, projectDataEntry], projectRoot))
        .toEqual([externalEntry]);
    } finally {
      if (previous === undefined) delete process.env.RESUME_LIFE_DATA_DIR;
      else process.env.RESUME_LIFE_DATA_DIR = previous;
    }
  });
});

describe("解析依赖构建追踪", () => {
  const projectRoot = process.cwd();
  const tracePath = path.join(projectRoot, ".next/server/app/api/import/parse/route.js.nft.json");
  const projectRequire = createRequire(path.join(projectRoot, "package.json"));
  const mammoth = path.relative(path.dirname(tracePath), projectRequire.resolve("mammoth"));
  const pdfParse = path.relative(path.dirname(tracePath), projectRequire.resolve("pdf-parse"));
  const pdfjsRoot = path.join(projectRoot, "node_modules/pdfjs-dist");
  const pdfRenderAssets = [
    "legacy/build/pdf.mjs", "legacy/build/pdf.worker.mjs",
    ...["cmaps", "standard_fonts"].flatMap((directory) =>
      fs.readdirSync(path.join(pdfjsRoot, directory)).map((file) => `${directory}/${file}`)),
  ].map((file) => path.relative(path.dirname(tracePath), path.join(pdfjsRoot, file)));

  it("两个沙箱解析依赖均在追踪中时通过", () => {
    expect(findMissingParserDependencies(tracePath, [mammoth, pdfParse, ...pdfRenderAssets], projectRoot)).toEqual([]);
  });

  it("依赖仅在宿主 node_modules 存在、构建清单遗漏时拒绝", () => {
    expect(findMissingParserDependencies(tracePath, [pdfParse, ...pdfRenderAssets], projectRoot)).toEqual(["mammoth"]);
    expect(findMissingParserDependencies(tracePath, [mammoth, ...pdfRenderAssets], projectRoot)).toEqual(["pdf-parse"]);
  });

  it("解析依赖存在但扫描件渲染资源缺席时仍拒绝", () => {
    expect(findMissingParserDependencies(tracePath, [mammoth, pdfParse], projectRoot)).toEqual(expect.arrayContaining([
      "pdfjs-dist/legacy/build/pdf.mjs",
      "pdfjs-dist/legacy/build/pdf.worker.mjs",
      "pdfjs-dist/cmaps",
      "pdfjs-dist/standard_fonts",
    ]));
  });

  it.each(["flat", "linked"])("%s 安装同时接受链接与实际路径，但仍拒绝遗漏、同名替代和失效清单", (layout) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-build-trace-"));
    try {
      fs.writeFileSync(path.join(directory, "package.json"), "{}");
      for (const name of ["mammoth", "pdf-parse", "pdfjs-dist"]) {
        const location = path.join(directory, "node_modules", ...(layout === "linked" ? [".pnpm", `${name}@fixture`, "node_modules", name] : [name]));
        fs.mkdirSync(location, { recursive: true });
        fs.writeFileSync(path.join(location, "package.json"), JSON.stringify({ name, main: "index.js" }));
        fs.writeFileSync(path.join(location, "index.js"), "module.exports = {};");
        if (name === "pdfjs-dist") {
          for (const file of ["legacy/build/pdf.mjs", "legacy/build/pdf.worker.mjs", "cmaps/map.bcmap", "standard_fonts/font.pfb"]) {
            fs.mkdirSync(path.dirname(path.join(location, file)), { recursive: true });
            fs.writeFileSync(path.join(location, file), "fixture");
          }
        }
        if (layout === "linked") fs.symlinkSync(location, path.join(directory, "node_modules", name), process.platform === "win32" ? "junction" : "dir");
      }
      const trace = path.join(directory, ".next/server/app/api/import/parse/route.js.nft.json");
      const files = ["mammoth/index.js", "pdf-parse/index.js", "pdfjs-dist/legacy/build/pdf.mjs", "pdfjs-dist/legacy/build/pdf.worker.mjs", "pdfjs-dist/cmaps/map.bcmap", "pdfjs-dist/standard_fonts/font.pfb"]
        .map((file) => path.join(directory, "node_modules", file));
      const relative = (file: string) => path.relative(path.dirname(trace), file);
      for (const physical of [false, true]) {
        const entries = files.map((file) => relative(physical ? fs.realpathSync(file) : file));
        expect(findMissingParserDependencies(trace, entries, directory)).toEqual([]);
        for (const [index, missing] of [[0, "mammoth"], [1, "pdf-parse"], [2, "pdfjs-dist/legacy/build/pdf.mjs"], [3, "pdfjs-dist/legacy/build/pdf.worker.mjs"], [4, "pdfjs-dist/cmaps"], [5, "pdfjs-dist/standard_fonts"]] as const) {
          expect(findMissingParserDependencies(trace, entries.filter((_, position) => position !== index), directory)).toEqual([missing]);
        }
        const unrelated = path.join(directory, "other/pdf.worker.mjs");
        fs.mkdirSync(path.dirname(unrelated), { recursive: true }); fs.writeFileSync(unrelated, "same filename");
        expect(findMissingParserDependencies(trace, [...entries.filter((_, index) => index !== 3), relative(unrelated)], directory)).toEqual(["pdfjs-dist/legacy/build/pdf.worker.mjs"]);
        fs.unlinkSync(files[3]!);
        expect(findMissingParserDependencies(trace, entries, directory)).toEqual(["pdfjs-dist/legacy/build/pdf.worker.mjs"]);
        fs.writeFileSync(files[3]!, "fixture");
      }
    } finally {
      if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-build-trace-")) throw new Error("Unsafe cleanup path");
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
