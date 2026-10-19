import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRIVATE_BUILD_PATHS } from "./private-build-paths.mjs";

const PARSER_TRACE_ROUTES = [
  "server/app/api/import/parse/route.js.nft.json",
  "server/app/api/projects/[id]/materials/route.js.nft.json",
];

function isWithin(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

export function findSensitiveTraceEntries(tracePath, entries, projectRoot = process.cwd()) {
  // 与运行期同一套解析规则（见 src/lib/db.ts）：显式配置优先，否则用项目内的 data/。
  // 否则设置了 RESUME_LIFE_DATA_DIR 时，这里检查的并不是真正会被写入的目录。
  const dataDirectory = process.env.RESUME_LIFE_DATA_DIR
    ? path.resolve(process.env.RESUME_LIFE_DATA_DIR)
    : path.resolve(projectRoot, "data");
  const traceDirectory = path.dirname(path.resolve(tracePath));
  return entries.filter((entry) => (
    typeof entry === "string"
    && (
      isWithin(dataDirectory, path.resolve(traceDirectory, entry))
      || (
        isWithin(projectRoot, path.resolve(traceDirectory, entry))
        && path.basename(entry) !== ".env.example"
        && PRIVATE_BUILD_PATHS.some((pattern) => path.matchesGlob(
          path.relative(projectRoot, path.resolve(traceDirectory, entry)),
          pattern.replace(/^\.\//, ""),
        ))
      )
    )
  ));
}

export function findMissingParserDependencies(tracePath, entries, projectRoot = process.cwd()) {
  const projectRequire = createRequire(path.join(projectRoot, "package.json"));
  const traced = new Set(entries.map((entry) => path.resolve(path.dirname(tracePath), entry)));
  const missing = ["mammoth", "pdf-parse"].filter((dependency) => !traced.has(projectRequire.resolve(dependency)));
  const pdfjsRoot = path.join(projectRoot, "node_modules/pdfjs-dist");
  for (const file of ["legacy/build/pdf.mjs", "legacy/build/pdf.worker.mjs"]) {
    if (!traced.has(path.join(pdfjsRoot, file))) missing.push(`pdfjs-dist/${file}`);
  }
  for (const directory of ["cmaps", "standard_fonts"]) {
    const assetDirectory = path.join(pdfjsRoot, directory);
    if (fs.readdirSync(assetDirectory).some((file) => !traced.has(path.join(assetDirectory, file)))) {
      missing.push(`pdfjs-dist/${directory}`);
    }
  }
  return missing;
}

function collectTraceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectTraceFiles(entryPath);
    return entry.isFile() && entry.name.endsWith(".nft.json") ? [entryPath] : [];
  });
}

export function checkBuildTrace(projectRoot = process.cwd()) {
  const resolvedRoot = path.resolve(projectRoot);
  const buildDirectory = path.join(resolvedRoot, ".next");
  if (!fs.existsSync(buildDirectory)) {
    throw new Error("未找到 .next 构建目录，请先运行 npm run build");
  }

  const traceFiles = collectTraceFiles(buildDirectory);
  if (traceFiles.length === 0) {
    throw new Error(".next 中未找到 NFT 构建追踪清单");
  }

  const violations = traceFiles.flatMap((tracePath) => {
    const manifest = JSON.parse(fs.readFileSync(tracePath, "utf8"));
    if (!Array.isArray(manifest.files)) {
      throw new Error(`NFT 清单缺少 files 数组：${path.relative(resolvedRoot, tracePath)}`);
    }
    return findSensitiveTraceEntries(tracePath, manifest.files, resolvedRoot).map((entry) => ({
      trace: path.relative(resolvedRoot, tracePath),
      entry,
    }));
  });

  const missingParserDependencies = PARSER_TRACE_ROUTES.flatMap((relativeTracePath) => {
    const tracePath = path.join(buildDirectory, relativeTracePath);
    if (!fs.existsSync(tracePath)) throw new Error(`缺少解析路由追踪清单：${relativeTracePath}`);
    const manifest = JSON.parse(fs.readFileSync(tracePath, "utf8"));
    if (!Array.isArray(manifest.files)) throw new Error(`NFT 清单缺少 files 数组：${relativeTracePath}`);
    return findMissingParserDependencies(tracePath, manifest.files, resolvedRoot).map((dependency) => ({
      trace: relativeTracePath,
      dependency,
    }));
  });

  return { traceCount: traceFiles.length, violations, missingParserDependencies };
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  try {
    const result = checkBuildTrace();
    if (result.violations.length > 0 || result.missingParserDependencies.length > 0) {
      if (result.violations.length > 0) console.error("构建追踪包含数据库或本地私有文件：");
      for (const violation of result.violations) {
        console.error(`- ${violation.trace}: ${violation.entry}`);
      }
      if (result.missingParserDependencies.length > 0) console.error("解析路由构建追踪缺少沙箱依赖：");
      for (const missing of result.missingParserDependencies) {
        console.error(`- ${missing.trace}: ${missing.dependency}`);
      }
      process.exitCode = 1;
    } else {
      console.log(`构建追踪检查通过，共检查 ${result.traceCount} 个 NFT 清单`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
