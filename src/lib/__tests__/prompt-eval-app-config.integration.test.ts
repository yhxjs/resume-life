import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { encryptSecret } from "../secret-store";
import { listenForFetch } from "../../../tests/support/http-server";

const directories: string[] = [], databases: DatabaseSync[] = [], servers: Server[] = [];
const encryptionKey = "synthetic-app-config-encryption-key-not-a-real-key";
const apiKey = "synthetic-app-config-api-key-not-a-real-key";
const proxyPassword = "synthetic-app-config-proxy-password-not-a-real-password";
const runner = path.resolve("scripts/eval-prompts.mjs");
const helperUrl = pathToFileURL(path.resolve("scripts/eval-app-config.mjs")).href;

beforeEach(() => vi.stubEnv("RESUME_LIFE_SETTINGS_KEY", encryptionKey));
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const db of databases.splice(0)) db.close();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
  for (const directory of directories.splice(0)) {
    const target = path.resolve(directory);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !/^resume-life-(?:app-config-test-|prompt-eval-)/.test(path.basename(target))) {
      throw new Error("Unsafe app configuration test cleanup path");
    }
    fs.rmSync(target, { recursive: true, force: true });
  }
});

function fixture(values: Record<string, string | number> = {}, openWal = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-app-config-test-"));
  directories.push(root);
  const data = path.join(root, "data");
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, "sentinel.txt"), "unchanged");
  const db = new DatabaseSync(path.join(data, "resume-life.db"));
  const row = {
    base_url: "https://synthetic.invalid/v1", api_key: encryptSecret(apiKey), api_format: "openai_chat",
    model_parse: "saved-parse", model_summary: "saved-summary", model_question: "saved-question", model_evaluate: "saved-evaluate",
    max_output_tokens: "8192", proxy_enabled: 0, proxy_url: "http://127.0.0.1:1", proxy_username: "saved-user",
    proxy_password: encryptSecret(proxyPassword), ...values,
  };
  db.exec(`PRAGMA journal_mode = WAL; CREATE TABLE settings (id INTEGER PRIMARY KEY, ${Object.keys(row).map(key => `${key} ${key === "proxy_enabled" ? "INTEGER" : "TEXT"}`).join(", ")}); PRAGMA wal_checkpoint(TRUNCATE);`);
  db.prepare(`INSERT INTO settings VALUES (1, ${Object.keys(row).map(() => "?").join(", ")})`).run(...Object.values(row));
  if (openWal) databases.push(db);
  else db.close();
  return { root, data, db };
}

function fingerprints(data: string) {
  if (!fs.existsSync(data)) return null;
  return Object.fromEntries(fs.readdirSync(data).sort().map(name => [name,
    createHash("sha256").update(fs.readFileSync(path.join(data, name))).digest("hex"),
  ]));
}

async function processRun(argv: string[], config: Record<string, string | undefined>, cwd = process.cwd()) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("PROMPT_EVAL_") || key.startsWith("__NEXT_") || key === "RESUME_LIFE_DATA_DIR" || key === "RESUME_LIFE_SETTINGS_KEY") delete env[key];
  Object.assign(env, config);
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  const child = spawn(process.execPath, argv, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let text = "";
  child.stdout.on("data", data => { text += data; });
  child.stderr.on("data", data => { text += data; });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("App configuration test exceeded 20s")); }, 20_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", status => { clearTimeout(timer); resolve(status); });
  });
  for (const secret of [apiKey, proxyPassword, encryptionKey]) expect(text).not.toContain(secret);
  const output = text.match(/(?:提示词快照（零模型调用）|真实模型评估)：([^\r\n]+)/)?.[1];
  if (output) directories.push(output);
  return { code, text, output };
}

async function probe(root: string, task: string, config: Record<string, string | undefined> = {}) {
  // The child compares credentials in memory and emits only booleans plus public metadata.
  const file = path.join(root, "probe.mjs");
  fs.writeFileSync(file, `
    import { readApplicationEvaluationConfig } from ${JSON.stringify(helperUrl)};
    try {
      const result = await readApplicationEvaluationConfig(process.env.APP_CONFIG_TEST_TASK, process.env.APP_CONFIG_TEST_ROOT);
      console.log(JSON.stringify({ metadata: result.metadata,
        apiKeyMatches: result.env.PROMPT_EVAL_API_KEY === process.env.APP_CONFIG_TEST_API_KEY,
        proxyPasswordMatches: result.env.PROMPT_EVAL_PROXY_PASSWORD === process.env.APP_CONFIG_TEST_PROXY_PASSWORD,
        proxyUrl: result.env.PROMPT_EVAL_PROXY_URL, proxyUsername: result.env.PROMPT_EVAL_PROXY_USERNAME,
        budget: result.env.PROMPT_EVAL_MAX_OUTPUT_TOKENS }));
    } catch { console.log('CONFIG_UNAVAILABLE'); process.exitCode = 1; }
  `);
  const result = await processRun([file], {
    NODE_ENV: "test", RESUME_LIFE_SETTINGS_KEY: encryptionKey,
    APP_CONFIG_TEST_ROOT: root, APP_CONFIG_TEST_TASK: task,
    APP_CONFIG_TEST_API_KEY: apiKey, APP_CONFIG_TEST_PROXY_PASSWORD: proxyPassword, ...config,
  });
  const line = result.text.split(/\r?\n/).find(item => item.startsWith('{"metadata":'));
  return { ...result, value: line ? JSON.parse(line) : null };
}

async function service() {
  const requests: { model: unknown; maxTokens: unknown; authenticated: boolean; stream: unknown }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push({ model: body.model, maxTokens: body.max_tokens, authenticated: req.headers.authorization === `Bearer ${apiKey}`, stream: body.stream });
    const content = JSON.stringify({ overview: "本机合成工具。", architecture: "", highlights: "", responsibilities: "", challenges: "", techStack: "", brief: "", achievements: [] });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  servers.push(server);
  await listenForFetch(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic endpoint unavailable");
  return { url: `http://127.0.0.1:${address.port}/v1`, requests };
}

describe("显式使用已保存应用配置的评测入口（仅本机服务）", () => {
  it("实际解密、选择summary模型并隔离执行；禁用代理的残留地址不启用，源WAL库无新增文件", async () => {
    const local = await service();
    const saved = fixture({ base_url: local.url });
    const before = fingerprints(saved.data);
    const result = await processRun([runner, "--suite=project", "--sample=overview-document-work-only/full", "--live", "--app-config=summary"], {
      NODE_ENV: "test", RESUME_LIFE_DATA_DIR: saved.data, RESUME_LIFE_SETTINGS_KEY: encryptionKey,
      PROMPT_EVAL_MAX_OUTPUT_TOKENS: "4096", PROMPT_EVAL_TIMEOUT_MS: "10000",
    });
    expect(result.code, result.text).toBe(0);
    expect(local.requests).toEqual([{ model: "saved-summary", maxTokens: 4096, authenticated: true, stream: true }]);
    expect(fingerprints(saved.data)).toEqual(before);
    const metadata = JSON.parse(fs.readFileSync(path.join(result.output!, "configuration.json"), "utf8"));
    expect(metadata).toEqual({ configSource: "saved-application", task: "summary", model: "saved-summary", apiFormat: "openai_chat", maxOutputTokens: 4096, timeoutMs: 10000, proxyEnabled: false, environment: "test" });
    const summary = JSON.parse(fs.readFileSync(path.join(result.output!, "summary.json"), "utf8"));
    expect(summary).toMatchObject({ model: "saved-summary", maxOutputTokens: 4096, timeoutMs: 10000, expectedSamples: 1, protocolCounts: { pass: 1 } });
    const artifacts = fs.readdirSync(result.output!).filter(name => name.endsWith(".json")).map(name => fs.readFileSync(path.join(result.output!, name), "utf8")).join("\n");
    for (const secret of [apiKey, proxyPassword, encryptionKey, local.url]) expect(artifacts).not.toContain(secret);
  }, 25_000);

  it.each<{ task: string; models: Record<string, string>; expected: string }>([
    { task: "summary", models: { model_summary: "" }, expected: "saved-parse" },
    { task: "parse", models: { model_parse: "" }, expected: "saved-summary" },
    { task: "question", models: { model_parse: "", model_summary: "", model_question: "" }, expected: "saved-evaluate" },
    { task: "evaluate", models: { model_parse: "", model_summary: "", model_evaluate: "" }, expected: "saved-question" },
  ])("$task未配置时沿生产顺序回退为$expected，读取有效代理凭证", async ({ task, models, expected }) => {
    const saved = fixture({ ...models, proxy_enabled: 1, proxy_url: "socks5://127.0.0.1:1080", api_format: "openai_responses", max_output_tokens: "3072" });
    const before = fingerprints(saved.data);
    const result = await probe(saved.root, task);
    expect(result.code, result.text).toBe(0);
    expect(result.value).toMatchObject({
      metadata: { task, model: expected, apiFormat: "openai_responses", maxOutputTokens: 3072, proxyEnabled: true },
      apiKeyMatches: true, proxyPasswordMatches: true, proxyUrl: "socks5://127.0.0.1:1080", proxyUsername: "saved-user", budget: "3072",
    });
    expect(fingerprints(saved.data)).toEqual(before);
  });

  it("读取尚在WAL中的最新保存值，不在源库创建或修改共享内存/日志", async () => {
    const saved = fixture({ model_summary: "saved-in-wal", api_format: "legacy-invalid", max_output_tokens: "invalid" }, true);
    const before = fingerprints(saved.data);
    expect(Object.keys(before!)).toContain("resume-life.db-wal");
    const result = await probe(saved.root, "summary");
    expect(result.code, result.text).toBe(0);
    expect(result.value.metadata).toMatchObject({ model: "saved-in-wal", apiFormat: "openai_chat", maxOutputTokens: 8192 });
    expect(fingerprints(saved.data)).toEqual(before);
  });

  it.each(["db", "wal"])("复制期间源%s变化即拒绝，清理临时副本且不恢复/覆盖外部变化", async kind => {
    const saved = fixture({}, kind === "wal");
    const source = path.join(saved.data, `resume-life.db${kind === "wal" ? "-wal" : ""}`);
    const original = fs.readFileSync(source);
    const hook = path.join(saved.root, "concurrent-write.mjs");
    fs.writeFileSync(hook, `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import path from 'node:path';
      const copy = fs.copyFileSync;
      let changed = false;
      fs.copyFileSync = function(source, ...rest) {
        const result = copy(source, ...rest);
        if (!changed && path.resolve(String(source)) === path.resolve(process.env.APP_CONFIG_TEST_CHANGED_SOURCE)) {
          changed = true;
          fs.appendFileSync(source, '\\nexternal-write\\n');
        }
        return result;
      };
      syncBuiltinESMExports();
    `);
    const temporary = path.join(saved.root, "isolated-tmp");
    fs.mkdirSync(temporary);
    const result = await processRun(["--import", pathToFileURL(hook).href, runner, "--live", "--app-config=summary"], {
      NODE_ENV: "test", RESUME_LIFE_DATA_DIR: saved.data, RESUME_LIFE_SETTINGS_KEY: encryptionKey,
      APP_CONFIG_TEST_CHANGED_SOURCE: source, TMPDIR: temporary, TEMP: temporary, TMP: temporary,
    });
    expect(result.code).toBe(1);
    expect(result.text).toContain("读取期间应用数据库发生变化");
    expect(result.output).toBeUndefined();
    expect(fs.readdirSync(temporary)).toEqual([]);
    expect(fs.readFileSync(source).equals(Buffer.concat([original, Buffer.from("\nexternal-write\n")]))).toBe(true);
  });

  it("按Next环境优先级、变量展开和默认production读取，已有进程环境优先", async () => {
    const saved = fixture();
    fs.writeFileSync(path.join(saved.root, ".env"), "RESUME_LIFE_SETTINGS_KEY=wrong-base-key\n");
    fs.writeFileSync(path.join(saved.root, ".env.local"), "RESUME_LIFE_SETTINGS_KEY=wrong-local-key\n");
    fs.writeFileSync(path.join(saved.root, ".env.production.local"), "RESUME_LIFE_SETTINGS_KEY=$APP_CONFIG_TEST_ENCRYPTION_KEY\n");
    const before = fingerprints(saved.data);
    const config = { NODE_ENV: undefined, RESUME_LIFE_SETTINGS_KEY: undefined, APP_CONFIG_TEST_ENCRYPTION_KEY: encryptionKey };
    const result = await probe(saved.root, "summary", config);
    expect(result.code, result.text).toBe(0);
    expect(result.value).toMatchObject({ apiKeyMatches: true, metadata: { environment: "production" } });
    const overridden = await probe(saved.root, "summary", { ...config, RESUME_LIFE_SETTINGS_KEY: "wrong-process-key" });
    expect(overridden.code).toBe(1);
    expect(fingerprints(saved.data)).toEqual(before);
  });

  it("test模式跳过.env.local，development选择对应环境文件", async () => {
    const saved = fixture();
    fs.writeFileSync(path.join(saved.root, ".env.local"), "RESUME_LIFE_SETTINGS_KEY=wrong-local-key\n");
    fs.writeFileSync(path.join(saved.root, ".env.test"), "RESUME_LIFE_SETTINGS_KEY=$APP_CONFIG_TEST_ENCRYPTION_KEY\n");
    fs.writeFileSync(path.join(saved.root, ".env.development.local"), "RESUME_LIFE_SETTINGS_KEY=$APP_CONFIG_TEST_ENCRYPTION_KEY\n");
    for (const mode of ["test", "development"]) {
      const result = await probe(saved.root, "summary", { NODE_ENV: mode, RESUME_LIFE_SETTINGS_KEY: undefined, APP_CONFIG_TEST_ENCRYPTION_KEY: encryptionKey });
      expect(result.code, result.text).toBe(0);
      expect(result.value).toMatchObject({ apiKeyMatches: true, metadata: { environment: mode } });
    }
  });

  it.each(["missing-db", "wrong-key", "plain-credential", "missing-table", "mixed-model", "mixed-proxy", "bad-budget", "bad-timeout", "rollback-journal", "spaced-model"])(
    "预检失败不修改源文件、不创建评测输出且不泄漏凭证：%s", async mode => {
      const saved = fixture(mode === "plain-credential" ? { api_key: apiKey } : mode === "spaced-model" ? { model_summary: " saved-summary " } : {});
      const data = mode === "missing-db" ? path.join(saved.root, "missing-data") : saved.data;
      if (mode === "missing-table") {
        const db = new DatabaseSync(path.join(data, "resume-life.db"));
        db.exec("DROP TABLE settings");
        db.close();
      }
      if (mode === "rollback-journal") fs.writeFileSync(path.join(data, "resume-life.db-journal"), "pending recovery");
      const before = fingerprints(data);
      const result = await processRun([runner, "--live", "--app-config=summary"], {
        NODE_ENV: "test", RESUME_LIFE_DATA_DIR: data, RESUME_LIFE_SETTINGS_KEY: mode === "wrong-key" ? "wrong-encryption-key" : encryptionKey,
        ...(mode === "mixed-model" ? { PROMPT_EVAL_MODEL: "unrelated-model" } : {}),
        ...(mode === "mixed-proxy" ? { PROMPT_EVAL_PROXY_URL: "http://127.0.0.1:1" } : {}),
        ...(mode === "bad-budget" ? { PROMPT_EVAL_MAX_OUTPUT_TOKENS: "8192tail" } : {}),
        ...(mode === "bad-timeout" ? { PROMPT_EVAL_TIMEOUT_MS: "60001tail" } : {}),
      });
      expect(result.code).toBe(1);
      expect(result.output).toBeUndefined();
      expect(fingerprints(data)).toEqual(before);
      expect(result.text).not.toContain("unrelated-model");
      expect(result.text).not.toContain("wrong-encryption-key");
      if (mode.startsWith("mixed-")) expect(result.text).toContain("不能混用");
      if (mode === "spaced-model") expect(result.text).toContain("模型名含首尾空白");
    },
  );

  it.each([
    { args: ["--app-config=summary"] },
    { args: ["--live", "--app-config=invalid"] },
    { args: ["--live", "--app-config=summary", "--app-config=parse"] },
  ])(
    "只接受live中单个明确配置角色：$args", async ({ args }) => {
      const saved = fixture();
      const before = fingerprints(saved.data);
      const result = await processRun([runner, ...args], { RESUME_LIFE_DATA_DIR: saved.data, RESUME_LIFE_SETTINGS_KEY: encryptionKey });
      expect(result.code).toBe(1);
      expect(result.output).toBeUndefined();
      expect(fingerprints(saved.data)).toEqual(before);
    },
  );

  it("原专用环境模式保持兼容，不读取应用数据库或写配置receipt", async () => {
    const local = await service();
    const saved = fixture();
    fs.unlinkSync(path.join(saved.data, "resume-life.db"));
    const before = fingerprints(saved.data);
    const result = await processRun([runner, "--suite=project", "--sample=overview-document-work-only/full", "--live"], {
      RESUME_LIFE_DATA_DIR: saved.data, RESUME_LIFE_SETTINGS_KEY: "unrelated-app-key",
      PROMPT_EVAL_BASE_URL: local.url, PROMPT_EVAL_API_KEY: apiKey, PROMPT_EVAL_MODEL: "dedicated-model",
    });
    expect(result.code, result.text).toBe(0);
    expect(local.requests).toEqual([{ model: "dedicated-model", maxTokens: 3200, authenticated: true, stream: true }]);
    expect(fingerprints(saved.data)).toEqual(before);
    expect(fs.existsSync(path.join(result.output!, "configuration.json"))).toBe(false);
  }, 25_000);
});
