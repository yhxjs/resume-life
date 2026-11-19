import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
    globals: true,
    // 测试可能启动 PDF/OCR/崩溃恢复子进程；Windows 限为两个 worker，
    // 减少单 worker 的总耗时，同时控制并行子进程对 CPU 和磁盘的争用。
    maxWorkers: process.platform === "win32" ? 2 : 4,
    // Windows CI coverage is slow under concurrent SQLite and subprocess work.
    testTimeout: process.platform === "win32" ? 30_000 : 5_000,
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "lcov"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/**/__tests__/**",
        "src/**/*.test.{ts,tsx}",
        "src/**/*.spec.{ts,tsx}",
      ],
      thresholds: {
        // 2026-11-03 全量实测 87.84 / 81.57 / 80.30，留出平台与工具波动余量。
        lines: 85,
        functions: 78,
        branches: 77,
      },
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
