import path from "node:path";
import type { NextConfig } from "next";
import { PRIVATE_BUILD_PATHS } from "./scripts/private-build-paths.mjs";

// 与运行期同一套解析规则（见 src/lib/db.ts）：显式配置优先，否则用项目内的 data/。
// 两者必须一致，否则这里排除的不是真正会被写入的目录。
const dataDirectory = process.env.RESUME_LIFE_DATA_DIR
  ? path.resolve(process.env.RESUME_LIFE_DATA_DIR)
  : path.join(process.cwd(), "data");
const relativeDataDirectory = path.relative(process.cwd(), dataDirectory);
// outputFileTracingExcludes 的值必须是相对项目根的 glob，因此数据目录落在项目外时
// 这里无法表达；那种情况下由 scripts/check-build-trace.mjs 用绝对路径兜底检查。
const dataExclude =
  relativeDataDirectory && !relativeDataDirectory.startsWith("..") && !path.isAbsolute(relativeDataDirectory)
    ? `./${relativeDataDirectory.split(path.sep).join("/")}/**/*`
    : "./data/**/*";
const pdfRenderAssets = [
  "./node_modules/pdfjs-dist/legacy/build/pdf.mjs",
  "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
  "./node_modules/pdfjs-dist/cmaps/*",
  "./node_modules/pdfjs-dist/standard_fonts/*",
];

const nextConfig: NextConfig = {
  headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        { key: "X-Frame-Options", value: "DENY" },
      ],
    }];
  },
  serverExternalPackages: ["pdf-parse", "mammoth", "playwright-core", "@napi-rs/canvas", "tesseract.js", "pdfjs-dist"],
  outputFileTracingExcludes: {
    "/*": [dataExclude, ...PRIVATE_BUILD_PATHS],
  },
  outputFileTracingIncludes: {
    "/api/import/parse": ["./chi_sim.traineddata", "./eng.traineddata", ...pdfRenderAssets],
    "/api/projects/\\[id\\]/materials": ["./chi_sim.traineddata", "./eng.traineddata", ...pdfRenderAssets],
  },
  // 不启用 next/image（全站使用原生 img 标签）：保留 images 配置会让 /_next/image 成为
  // proxy Host 白名单之外的回源通道，删除以关闭该面。
};

export default nextConfig;
