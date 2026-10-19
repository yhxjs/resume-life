import fs from "node:fs";
import path from "node:path";

export function cleanupPreviousPlaywrightResults(rootDirectory = process.cwd()): void {
  const root = path.resolve(rootDirectory);
  const target = path.resolve(root, "test-results");
  if (path.dirname(target) !== root || path.basename(target) !== "test-results") {
    throw new Error(`Unsafe Playwright cleanup target: ${target}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
}
