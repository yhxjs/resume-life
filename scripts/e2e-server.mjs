import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import "./check-runtime.mjs";
// Every run owns a fresh SQLite directory; a developer's data is never used.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-e2e-"));
const server = spawn(process.execPath, [
  fileURLToPath(new URL("../node_modules/next/dist/bin/next", import.meta.url)),
  "start", "--hostname", "127.0.0.1", "--port", "3319",
], {
  stdio: "inherit",
  env: {
    ...process.env,
    RESUME_LIFE_DATA_DIR: dataDir,
    RESUME_LIFE_SETTINGS_KEY: randomBytes(32).toString("hex"),
  },
});

function stop() {
  if (server.exitCode === null) server.kill("SIGTERM");
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
server.on("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
server.on("close", (code) => {
  // Only remove the exact mkdtemp directory created by this process.
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  process.exitCode = code ?? 0;
});
