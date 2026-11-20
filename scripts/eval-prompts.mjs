import "./check-runtime.mjs";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluationExitCode } from "./eval-completion.mjs";
import { evaluationSamplePattern, parseEvaluationSampleIds } from "./eval-selection.mjs";

const args = process.argv.slice(2);
const suiteArgs = args.filter(arg => arg.startsWith("--suite="));
const sampleArgs = args.filter(arg => arg.startsWith("--sample="));
const appConfigArgs = args.filter(arg => arg.startsWith("--app-config="));
const appConfigTask = appConfigArgs[0]?.slice("--app-config=".length);
if (args.some(arg => !arg.startsWith("--sample=") && !arg.startsWith("--app-config=") && !["--live", "--suite=intro", "--suite=project", "--suite=project-challenge-boundaries", "--suite=project-personal-scope", "--suite=project-challenge-order", "--suite=project-challenge-evidence", "--suite=project-work-state", "--suite=project-challenge-admission", "--suite=project-architecture-evidence", "--suite=project-independent-achievement", "--suite=project-summary-field-boundaries", "--suite=project-summary-field-repair", "--suite=project-summary-challenge-status", "--suite=project-summary-evidence-ledger", "--suite=project-summary-archive-conflict", "--suite=evaluator", "--suite=interview", "--suite=interview-retry", "--suite=interview-reverse", "--suite=interview-reference", "--suite=interview-finish", "--suite=interview-remediation-create", "--suite=interview-series-answer", "--suite=application-interview-review", "--suite=interview-series-advance", "--suite=interview-series-finalize", "--suite=project-drill-create", "--suite=project-eval-reference-scope", "--suite=bank-drill-create", "--suite=drill-answer", "--suite=repo", "--suite=repo-scan", "--suite=salary", "--suite=defense", "--suite=defense-drill", "--suite=jargon-decoder", "--suite=style-generation", "--suite=diagnosis", "--suite=resume-job-search", "--suite=polish", "--suite=import", "--suite=jd-portrait", "--suite=career-gap"].includes(arg)) ||
  suiteArgs.length > 1 || appConfigArgs.length > 1 || (appConfigArgs.length && !["summary", "parse", "question", "evaluate"].includes(appConfigTask)) || args.filter(arg => arg === "--live").length > 1) {
  console.error("用法：npm run eval:prompts [-- --suite=intro|--suite=project|--suite=project-challenge-boundaries|--suite=project-personal-scope|--suite=project-challenge-order|--suite=project-challenge-evidence|--suite=project-work-state|--suite=project-challenge-admission|--suite=project-architecture-evidence|--suite=project-independent-achievement|--suite=project-summary-field-boundaries|--suite=project-summary-field-repair|--suite=project-summary-challenge-status|--suite=project-summary-evidence-ledger|--suite=project-summary-archive-conflict|--suite=evaluator|--suite=interview|--suite=interview-retry|--suite=interview-reverse|--suite=interview-reference|--suite=interview-finish|--suite=interview-remediation-create|--suite=interview-series-answer|--suite=application-interview-review|--suite=interview-series-advance|--suite=interview-series-finalize|--suite=project-drill-create|--suite=project-eval-reference-scope|--suite=bank-drill-create|--suite=drill-answer|--suite=repo|--suite=repo-scan|--suite=salary|--suite=defense|--suite=defense-drill|--suite=jargon-decoder|--suite=style-generation|--suite=diagnosis|--suite=resume-job-search|--suite=polish|--suite=import|--suite=jd-portrait|--suite=career-gap] [--sample=完整ID ...] [--live]；默认 intro，仅导出提示词，不调用模型；repo-scan 仅支持完整离线提示快照。");
  console.error("已保存应用配置：追加 --live --app-config=summary|parse|question|evaluate；不能混用 PROMPT_EVAL 连接配置，可用输出预算和期限变量覆盖实验参数。");
  process.exit(1);
}
const live = args.includes("--live");
if (appConfigTask && !live) {
  console.error("--app-config=summary|parse|question|evaluate 仅可与 --live 一起使用；默认快照不读取应用配置。");
  process.exit(1);
}
const suite = suiteArgs[0]?.slice("--suite=".length) || "intro";
let requestedIds;
try {
  requestedIds = parseEvaluationSampleIds(sampleArgs.map(arg => arg.slice("--sample=".length)));
} catch {
  console.error("--sample 需要有效且唯一的完整样本 ID，不能共用报告文件名。");
  process.exit(1);
}
if (requestedIds.length && suite === "repo-scan") {
  console.error("repo-scan 暂不支持 --sample；请运行完整离线套件。");
  process.exit(1);
}
if (live && suite === "repo-scan") {
  console.error("repo-scan 仅支持离线提示快照，不启动 CLI 或 HTTP 模型；请去掉 --live。");
  process.exit(1);
}
const root = fileURLToPath(new URL("../", import.meta.url));
let appConfig;
if (appConfigTask) {
  let ConfigError;
  try {
    const { readApplicationEvaluationConfig, ApplicationEvaluationConfigError } = await import("./eval-app-config.mjs");
    ConfigError = ApplicationEvaluationConfigError;
    appConfig = await readApplicationEvaluationConfig(appConfigTask, root);
  } catch (error) {
    console.error(ConfigError && error instanceof ConfigError ? error.message : "无法只读加载应用模型配置；请检查环境设置与应用数据库。");
    process.exit(1);
  }
}
if (live && !appConfig && ["BASE_URL", "API_KEY", "MODEL"].some(key => !process.env[`PROMPT_EVAL_${key}`]?.trim())) {
  console.error("真实评估需要 PROMPT_EVAL_BASE_URL、PROMPT_EVAL_API_KEY、PROMPT_EVAL_MODEL；请通过环境变量提供，不放入命令行参数。");
  process.exit(1);
}
const output = mkdtempSync(path.join(tmpdir(), "resume-life-prompt-eval-"));
if (appConfig) writeFileSync(path.join(output, "configuration.json"), JSON.stringify(appConfig.metadata, null, 2), { mode: 0o600 });
console.log(`${live ? "真实模型评估" : "提示词快照（零模型调用）"}：${output}`);
const child = spawn(process.execPath, [
  path.join(root, "node_modules/vitest/vitest.mjs"), "run", "--config", "evals/vitest.config.mts",
  ...(requestedIds.length ? ["--testNamePattern", evaluationSamplePattern(requestedIds)] : []),
], {
  cwd: root,
  stdio: "inherit",
  windowsHide: true,
  env: {
    ...process.env,
    ...appConfig?.env,
    PROMPT_EVAL_LIVE: live ? "1" : "0",
    PROMPT_EVAL_SUITE: suite,
    PROMPT_EVAL_OUTPUT: output,
    // 未指定样本时也覆盖环境，避免调用方的旧选择影响本轮范围。
    PROMPT_EVAL_SAMPLE_IDS: JSON.stringify(requestedIds),
    // 即使调用方设置了生产数据目录，也始终改用本轮专属目录。
    RESUME_LIFE_DATA_DIR: path.join(output, "data"),
    RESUME_LIFE_SETTINGS_KEY: randomBytes(32).toString("hex"),
  },
});
child.on("error", () => {
  console.error("评估子进程启动失败。");
  process.exitCode = 1;
});
child.on("exit", code => { process.exitCode = evaluationExitCode(code, { output, suite, live, requestedIds }); });
