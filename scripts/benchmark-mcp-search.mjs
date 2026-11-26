import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const defaults = { sizes: [10_000, 100_000], limit: 50, bodyChars: 512, samples: 30, writes: 64 };
const usage = "node scripts/benchmark-mcp-search.mjs [--sizes=10000,100000] [--limit=50] [--body-chars=512] [--samples=30] [--writes=64] [--output=.test-artifacts/mcp-search-benchmark.json]";
const params = { ...defaults };
let output = path.join(root, ".test-artifacts/mcp-search-benchmark.json");
for (const arg of process.argv.slice(2)) {
  if (arg === "--help") { process.stdout.write(usage + "\n"); process.exit(0); }
  const match = /^--(sizes|limit|body-chars|samples|writes|output)=(.+)$/.exec(arg);
  assert.ok(match, "Unsupported argument. " + usage);
  const [, key, value] = match;
  if (key === "output") { output = path.resolve(root, value); continue; }
  if (key === "sizes") params.sizes = value.split(",").map(Number);
  else params[key === "body-chars" ? "bodyChars" : key] = Number(value);
}
assert.ok(params.sizes.length > 0 && params.sizes.length <= 5 && new Set(params.sizes).size === params.sizes.length);
assert.ok(params.sizes.every(n => Number.isSafeInteger(n) && n >= 2 && n <= 1_000_000), "sizes must be 2..1000000");
for (const [key, min, max] of [["limit", 1, 50], ["bodyChars", 64, 10_000], ["samples", 1, 1000], ["writes", 1, 1000]]) {
  assert.ok(Number.isInteger(params[key]) && params[key] >= min && params[key] <= max, `${key} must be ${min}..${max}`);
}
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-search-benchmark-"));
const token = randomUUID();
fs.writeFileSync(path.join(temporary, "benchmark-owner.json"), JSON.stringify({ token }));
const sourcePaths = ["src/lib/mcp-search.ts", "src/lib/mcp-search-epochs.ts", "src/lib/db.ts", "src/lib/db-schema.ts", "scripts/benchmark-mcp-search.mjs", "scripts/benchmark-mcp-search-worker.mjs"];
const sourceHashes = () => Object.fromEntries(sourcePaths.map(name => [name, createHash("sha256").update(fs.readFileSync(path.join(root, name))).digest("hex")]));
function git(...args) { try { return execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim(); } catch { return null; } }
const report = { formatVersion: 1, ok: false, measuredAt: new Date().toISOString(), parameters: params,
  method: "Production searchRecordsPage + native SQLite; direct domain calls exclude MCP transport/operation logging. Full traversal, no sampling of IDs.",
  environment: { platform: process.platform, release: os.release(), arch: process.arch, node: process.version, sqlite: process.versions.sqlite,
    cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem(), nodeOptions: process.env.NODE_OPTIONS ?? "",
    tsx: JSON.parse(fs.readFileSync(path.join(root, "node_modules/tsx/package.json"), "utf8")).version,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, gitHead: git("rev-parse", "HEAD"), sourceHashes: sourceHashes() },
  isolation: { syntheticOnly: true, callerDataDirectoryIgnored: true, directoryKind: "os.tmpdir()/unique-per-run/per-size", cleaned: false }, scenarios: [] };

async function scenario(rows) {
  process.stderr.write(`[search-benchmark] Running ${rows.toLocaleString("en-US")} synthetic records, full traversal\n`);
  const args = { ...params, rows, root, temporary, token };
  const child = spawn(process.execPath, [path.join(root, "scripts/benchmark-mcp-search-worker.mjs"), JSON.stringify(args)], {
    cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, RESUME_LIFE_DATA_DIR: path.join(temporary, `case-${rows}`), RESUME_LIFE_MCP_WRITE_ENABLED: "false", RESUME_LIFE_MCP_LLM_ENABLED: "false" },
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; });
  child.stderr.on("data", data => { stderr = (stderr + data).slice(-12000); process.stderr.write(data); });
  const timer = setTimeout(() => child.kill(), 10 * 60_000);
  try {
    const code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    assert.equal(code, 0, `Worker failed: ${stderr}`);
    const result = JSON.parse(stdout); assert.equal(result.ok, true); return result;
  } finally { clearTimeout(timer); }
}
try {
  for (const rows of params.sizes) report.scenarios.push(await scenario(rows));
  report.environment.sourceHashesAfter = sourceHashes();
  assert.deepEqual(report.environment.sourceHashesAfter, report.environment.sourceHashes, "Sources changed during the benchmark; rerun to obtain a coherent result");
  report.ok = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error); process.exitCode = 1;
} finally {
  const target = path.resolve(temporary);
  assert.equal(path.dirname(target), path.resolve(os.tmpdir()));
  assert.ok(path.basename(target).startsWith("resume-life-search-benchmark-"));
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, "benchmark-owner.json"), "utf8")).token, token);
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  report.isolation.cleaned = true;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ ...report, report: output }, null, 2) + "\n");
}
