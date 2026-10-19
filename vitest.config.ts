import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
    globals: true,
    // 每个测试 worker 还会启动 PDF/OCR/崩溃恢复子进程；Windows CI 同时运行
    // 多个文件会让冷启动争抢 CPU/磁盘，触发应用自身的解析期限。串行保留真实期限。
    maxWorkers: process.platform === "win32" ? 1 : 4,
    // Windows CI 采集覆盖率时，真实 SQLite/文件系统测试可能超过默认 5 秒。
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
        lines: 50,
        functions: 38,
        branches: 37,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
