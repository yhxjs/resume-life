import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Console } from "node:console";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-mcp-benchmark-"));
const output = path.join(root, ".test-artifacts/mcp-benchmark.json");
process.env.RESUME_LIFE_DATA_DIR = path.join(temporary, "data");
process.env.RESUME_LIFE_MCP_WRITE_ENABLED = "false";
process.env.RESUME_LIFE_MCP_LLM_ENABLED = "false";
process.chdir(root);
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
try {
  const options = { tsconfig: path.join(root, "tsconfig.json") };
  (await import("tsx/esm/api")).register(options);
  (await import("tsx/cjs/api")).register(options);
  const { benchmarkMcp } = await import(new URL("../src/mcp/benchmark.ts", import.meta.url).href);
  const result = await benchmarkMcp(temporary);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ ...result, report: output }, null, 2) + "\n");
} catch (error) { console.error(error instanceof Error ? error.message : "MCP benchmark failed"); process.exitCode = 1; }
finally {
  if (path.dirname(path.resolve(temporary)) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith("resume-life-mcp-benchmark-")) throw new Error("Unsafe benchmark cleanup path");
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
