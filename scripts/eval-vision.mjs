import "./check-runtime.mjs";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluationExitCode } from "./eval-completion.mjs";

const args = process.argv.slice(2);
if (args.length > 1 || args.some(arg => arg !== "--live")) {
  console.error("用法：npm run eval:vision [-- --live]；默认只生成合成图片与提示快照，不调用模型。");
  process.exit(1);
}
const live = args.includes("--live");
if (live && ["BASE_URL", "API_KEY", "MODEL"].some(key => !process.env[`VISION_EVAL_${key}`]?.trim())) {
  console.error("视觉评估需要 VISION_EVAL_BASE_URL、VISION_EVAL_API_KEY、VISION_EVAL_MODEL 环境变量。");
  process.exit(1);
}
const root = fileURLToPath(new URL("../", import.meta.url));
const output = mkdtempSync(path.join(tmpdir(), "resume-life-vision-eval-"));
console.log(`视觉评估目录：${output}`);
const child = spawn(process.execPath, [
  path.join(root, "node_modules/vitest/vitest.mjs"), "run", "--config", "evals/vision.vitest.config.mts",
], {
  cwd: root, stdio: "inherit", windowsHide: true,
  env: {
    ...process.env,
    VISION_EVAL_LIVE: live ? "1" : "0",
    VISION_EVAL_OUTPUT: output,
    RESUME_LIFE_DATA_DIR: path.join(output, "data"),
    RESUME_LIFE_SETTINGS_KEY: randomBytes(32).toString("hex"),
  },
});
child.on("error", () => { console.error("视觉评估子进程启动失败。"); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = evaluationExitCode(code, { output, suite: "vision-ocr", live }); });
