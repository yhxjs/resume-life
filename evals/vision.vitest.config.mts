import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) } },
  test: {
    include: ["evals/vision-ocr.eval.ts"],
    environment: "node", maxWorkers: 1, testTimeout: 75_000,
  },
});
