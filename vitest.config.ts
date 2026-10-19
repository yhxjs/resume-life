import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
    globals: true,
    maxWorkers: 4,
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
