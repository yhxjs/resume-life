import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("../../", import.meta.url));
let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-search-benchmark-test-")); });
afterEach(() => {
  if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith("resume-life-search-benchmark-test-")) throw new Error("Unsafe cleanup");
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

it("emits reproducible JSON and ignores a caller's data directory using only disposable synthetic databases", () => {
  const callerData = path.join(directory, "caller-data"), output = path.join(directory, "result.json");
  fs.mkdirSync(callerData);
  const sentinel = path.join(callerData, "resume-life.db"), original = Buffer.from("Synthetic caller sentinel: never open, replace or delete");
  fs.writeFileSync(sentinel, original);
  const stdout = execFileSync(process.execPath, [path.join(root, "scripts/benchmark-mcp-search.mjs"), "--sizes=137", "--limit=10", "--body-chars=64", "--samples=2", "--writes=2", `--output=${output}`],
    { cwd: directory, env: { ...process.env, RESUME_LIFE_DATA_DIR: callerData }, windowsHide: true, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 });
  const report = JSON.parse(stdout), onDisk = JSON.parse(fs.readFileSync(output, "utf8"));
  expect(report).toMatchObject({ ...onDisk, report: output });
  expect(report).toMatchObject({ ok: true, parameters: { sizes: [137], limit: 10, bodyChars: 64, samples: 2, writes: 2 },
    isolation: { syntheticOnly: true, callerDataDirectoryIgnored: true, cleaned: true } });
  expect(report.environment.sourceHashesAfter).toEqual(report.environment.sourceHashes);
  expect(report.scenarios[0]).toMatchObject({ rows: 137, traversal: { received: 137, missing: 0, duplicates: 0, outOfOrder: 0, fullTraversal: true, additionalCountExecutions: 0 },
    concurrentWriter: { totalCommitted: 3, commitsWhileSnapshotOpen: 3, observedSnapshotTotal: 137, rowsAfterWrites: 138, queryOnly: true, separateReadConnection: true, conflictAfterMutation: { code: "CONFLICT" } },
    sqlEvidence: { immediateBegins: 0 } });
  expect(report.scenarios[0].traversal.actualIdsSha256).toBe(report.scenarios[0].traversal.expectedIdsSha256);
  expect(fs.readFileSync(sentinel)).toEqual(original); expect(fs.readdirSync(callerData)).toEqual(["resume-life.db"]);
}, 40_000);

it("rejects invalid parameters instead of creating an unbounded benchmark", () => {
  expect(() => execFileSync(process.execPath, [path.join(root, "scripts/benchmark-mcp-search.mjs"), "--sizes=0"],
    { cwd: directory, windowsHide: true, stdio: "pipe", timeout: 5000 })).toThrow();
  expect(fs.readdirSync(directory)).toEqual([]);
});
