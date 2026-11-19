import { createHash } from "node:crypto";
import { createReadStream, copyFileSync, chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import nextEnv from "@next/env";
import { decryptSecret } from "../src/lib/secret-store.ts";
import { parseMaxOutputTokens, resolveMaxOutputTokens, VALID_API_FORMATS } from "../src/lib/settings-constants.ts";
import { parseHttpBaseUrl } from "../src/lib/model-base-url.ts";
import { normalizeProxyConfig } from "../src/lib/proxy-config.ts";
import { parseEvaluationTimeoutMs } from "../evals/timeout.ts";

const tasks = ["summary", "parse", "question", "evaluate"];
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const connectionVariables = ["BASE_URL", "API_KEY", "MODEL", "API_FORMAT", "PROXY_URL", "PROXY_USERNAME", "PROXY_PASSWORD"];
export class ApplicationEvaluationConfigError extends Error {}
const fail = message => { throw new ApplicationEvaluationConfigError(message); };

async function fileHash(file) {
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest("hex");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * SQLite readOnly still creates WAL/SHM sidecars when opening a source WAL database.
 * Read a private DB + WAL copy instead, rejecting changes observed during copying.
 * The stability check is not an atomic cross-file snapshot and does not lock the app.
 */
async function readCopiedSettings(dataDirectory) {
  const names = ["resume-life.db", "resume-life.db-wal"];
  const rollbackJournal = path.join(dataDirectory, "resume-life.db-journal");
  if (await fileHash(rollbackJournal) !== null) fail("应用数据库存在回滚日志，请先由应用完成恢复；本次不会尝试恢复或启动评测。");
  const before = await Promise.all(names.map(name => fileHash(path.join(dataDirectory, name))));
  if (!before[0]) fail("未找到应用数据库；请核对 RESUME_LIFE_DATA_DIR，不会创建应用数据。");
  const snapshot = mkdtempSync(path.join(tmpdir(), "resume-life-eval-app-config-"));
  try {
    for (let index = 0; index < names.length; index++) {
      if (before[index] === null) continue;
      const destination = path.join(snapshot, names[index]);
      copyFileSync(path.join(dataDirectory, names[index]), destination);
      if (process.platform !== "win32") chmodSync(destination, 0o600);
    }
    const copied = await Promise.all(names.map(name => fileHash(path.join(snapshot, name))));
    const after = await Promise.all(names.map(name => fileHash(path.join(dataDirectory, name))));
    if (before.some((hash, index) => hash !== copied[index] || hash !== after[index]) || await fileHash(rollbackJournal) !== null) {
      fail("读取期间应用数据库发生变化，本次评测未启动；请在保存完成后重新执行。");
    }
    const db = new DatabaseSync(path.join(snapshot, names[0]), { readOnly: true });
    try {
      const row = db.prepare("SELECT * FROM settings WHERE id = 1").get();
      if (!row) fail("应用尚未保存模型设置，请先在设置页完成配置。");
      return row;
    } finally {
      db.close();
    }
  } finally {
    const target = path.resolve(snapshot);
    if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith("resume-life-eval-app-config-")) {
      fail("应用配置临时快照清理路径无效。");
    }
    rmSync(target, { recursive: true, force: true });
  }
}

/**
 * Explicit opt-in only. Next's environment order applies at repository root:
 * process.env wins; NODE_ENV selects development/test/production, default production.
 * Connection env and saved config cannot be mixed; only experiment budget/deadline may override.
 * No decrypted values are written to disk or included in metadata.
 * @param {"summary" | "parse" | "question" | "evaluate"} task
 * @param {string} root
 */
export async function readApplicationEvaluationConfig(task, root = repositoryRoot) {
  try {
    if (!tasks.includes(task)) fail("--app-config 仅支持 summary、parse、question 或 evaluate。");
    if (process.env.NODE_ENV && !["production", "development", "test"].includes(process.env.NODE_ENV)) {
      fail("--app-config 的 NODE_ENV 仅支持 production、development 或 test；未设置时按 production 读取。");
    }
    let environmentError = false;
    nextEnv.loadEnvConfig(root, process.env.NODE_ENV === "development", {
      info() {}, error() { environmentError = true; },
    });
    if (environmentError) fail("无法加载应用环境文件，请核对文件权限及格式。");
    if (connectionVariables.some(key => process.env[`PROMPT_EVAL_${key}`]?.trim())) {
      fail("--app-config 不能混用 PROMPT_EVAL 的服务地址、凭证、模型、协议或代理配置；请移除这些变量，或去掉 --app-config。");
    }
    const explicitBudget = process.env.PROMPT_EVAL_MAX_OUTPUT_TOKENS;
    if (explicitBudget !== undefined && parseMaxOutputTokens(explicitBudget) === null) {
      fail("PROMPT_EVAL_MAX_OUTPUT_TOKENS 必须是正安全整数。");
    }
    const timeoutMs = parseEvaluationTimeoutMs(process.env.PROMPT_EVAL_TIMEOUT_MS);
    if (timeoutMs === null) fail("PROMPT_EVAL_TIMEOUT_MS 必须是 1–300000 的完整正整数字符串。");
    const configuredDirectory = process.env.RESUME_LIFE_DATA_DIR;
    if (configuredDirectory && !path.isAbsolute(configuredDirectory)) {
      fail("RESUME_LIFE_DATA_DIR 必须使用绝对路径，不会解析或创建相对数据目录。");
    }
    const dataDirectory = configuredDirectory || path.join(root, "data");
    const row = await readCopiedSettings(dataDirectory);
    const text = key => typeof row[key] === "string" || typeof row[key] === "number" ? String(row[key]) : "";
    // Same task-first fallback order as the production LLM resolver.
    const model = text(`model_${task}`) || text("model_parse") || text("model_summary") || text("model_question") || text("model_evaluate");
    // The harness trims names; reject a legacy value rather than silently change model identity.
    if (model !== model.trim()) fail("应用已保存的模型名含首尾空白，请在设置页重新保存后再评测。");
    const baseUrl = text("base_url").trim();
    let apiKey, proxyPassword;
    try {
      apiKey = decryptSecret(text("api_key")).trim();
      proxyPassword = decryptSecret(text("proxy_password"));
    } catch {
      fail("应用凭证无法解密，请核对 RESUME_LIFE_SETTINGS_KEY 及已保存的加密凭证。");
    }
    if (!baseUrl || !apiKey || !model) fail("应用模型设置不完整，需要 Base URL、API Key 与任务模型或回退模型。");
    try { parseHttpBaseUrl(baseUrl); }
    catch { fail("应用模型地址无效，仅支持 HTTPS 或本机回环 HTTP，且地址不能携带账号密码。"); }
    const savedFormat = text("api_format");
    const apiFormat = VALID_API_FORMATS.has(savedFormat) ? savedFormat : "openai_chat";
    const maxOutputTokens = explicitBudget === undefined ? resolveMaxOutputTokens(text("max_output_tokens")) : parseMaxOutputTokens(explicitBudget);
    let proxy;
    try {
      proxy = normalizeProxyConfig({ enabled: row.proxy_enabled === 1, url: text("proxy_url"), username: text("proxy_username"), password: proxyPassword });
    } catch { fail("应用已启用的代理配置无效，请在设置页检查。"); }
    return {
      env: {
        PROMPT_EVAL_BASE_URL: baseUrl, PROMPT_EVAL_API_KEY: apiKey, PROMPT_EVAL_MODEL: model,
        PROMPT_EVAL_API_FORMAT: apiFormat, PROMPT_EVAL_MAX_OUTPUT_TOKENS: String(maxOutputTokens),
        // A disabled saved proxy may retain its URL/password; never activate it in the harness.
        PROMPT_EVAL_PROXY_URL: proxy.enabled ? proxy.url : "",
        PROMPT_EVAL_PROXY_USERNAME: proxy.enabled ? proxy.username : "",
        PROMPT_EVAL_PROXY_PASSWORD: proxy.enabled ? proxy.password : "",
      },
      metadata: {
        configSource: "saved-application", task, model, apiFormat, maxOutputTokens, timeoutMs,
        proxyEnabled: proxy.enabled, environment: process.env.NODE_ENV || "production",
      },
    };
  } catch (error) {
    if (error instanceof ApplicationEvaluationConfigError) throw error;
    fail("无法只读加载应用模型配置，请检查数据目录、数据库结构及环境设置；应用数据未修改。");
  }
}

/** Public configuration identity only; suitable for audit output before an evaluation. */
export async function readApplicationEvaluationMetadata(task, root) {
  return (await readApplicationEvaluationConfig(task, root)).metadata;
}
