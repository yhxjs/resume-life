import { defineConfig } from "vitest/config";
import base from "./vitest.config.mjs";

// A shard only covers part of the suite. Its blob retains the coverage map,
// including untested source files. CI merges all blobs with the original config
// before applying the unchanged thresholds and page coverage gate.
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    coverage: {
      ...base.test?.coverage,
      reporter: [],
      thresholds: undefined,
    },
  },
});
