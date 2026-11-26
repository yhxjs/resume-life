import { readMcpConfig, permittedMcpTools, toolAccess, mcpPresets, MCP_SERVER_VERSION } from "../src/mcp/config.mjs";
import { readMcpRepositoryRoots } from "../src/mcp/repository-config.mjs";
import { readMcpCachePolicy } from "../src/mcp/cache-config.mjs";
import { Console } from "node:console";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// Resolve from this file, never from the Agent host's working directory.
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const mode = process.argv[2] ?? "serve";
const fail = (message) => { console.error(`[mcp] ${message}`); process.exitCode = 1; };

async function main() {
  if (!["serve", "doctor", "config"].includes(mode) || process.argv.length > (mode === "config" ? 5 : 3)) {
    throw new Error(`用法：node scripts/mcp.mjs [serve|doctor|config [json|codex] [${Object.keys(mcpPresets).join("|")}]]`);
  }
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major !== 24 || minor < 21) throw new Error("需要 Node.js 24.21.0 或更新的 24.x。");
  process.chdir(root);
  const envFile = path.join(root, ".env.local");
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  const directory = process.env.RESUME_LIFE_DATA_DIR || path.join(root, "data");
  if (!path.isAbsolute(directory)) throw new Error("RESUME_LIFE_DATA_DIR 必须为绝对路径。");
  process.env.RESUME_LIFE_DATA_DIR = directory;
  let ancestor = directory;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error("数据目录的根路径不可访问，请检查磁盘或挂载点。");
    ancestor = parent;
  }
  if (!fs.statSync(ancestor).isDirectory()) throw new Error("数据目录指向文件，请更正 RESUME_LIFE_DATA_DIR。");
  try { fs.accessSync(ancestor, fs.constants.W_OK); }
  catch { throw new Error("数据目录不可写，请检查文件权限。"); }
  const databasePath = path.join(directory, "resume-life.db");
  if (fs.existsSync(databasePath)) {
    try {
      if (!fs.statSync(databasePath).isFile()) throw new Error();
      fs.accessSync(databasePath, fs.constants.R_OK | fs.constants.W_OK);
    } catch { throw new Error("数据目录中的 resume-life.db 不是可读写的文件。"); }
  }
  try { require.resolve("tsx/esm/api"); require.resolve("@modelcontextprotocol/server"); }
  catch { throw new Error("项目依赖不完整，请在项目目录执行 npm ci。"); }
  try { await import("node:sqlite"); }
  catch { throw new Error("当前 Node 不支持 node:sqlite，请检查运行时安装。"); }
  const cachePolicy = readMcpCachePolicy();

  if (mode === "doctor") {
    const config = readMcpConfig();
    const repositoryRoots = readMcpRepositoryRoots();
    // This check intentionally does not open, initialize or migrate a database.
    const enabledTools = permittedMcpTools(config);
    console.log(JSON.stringify({ ok: true, serverVersion: MCP_SERVER_VERSION, availablePresets: Object.keys(mcpPresets), node: process.version, project: root, dataDirectory: directory,
      databaseExists: fs.existsSync(databasePath), repositoryRoots, cachePolicy,
      writeEnabled: config.writeEnabled, llmEnabled: config.llmEnabled, timeoutMs: config.timeoutMs,
      allowedTools: config.allowlist === null ? null : [...config.allowlist],
      enabledTools, toolCount: enabledTools.length,
      capabilities: Object.fromEntries(["read", "write", "llm"].map(access => [access, enabledTools.filter(name => toolAccess[name] === access)])),
      settingsKeyPresent: Boolean(process.env.RESUME_LIFE_SETTINGS_KEY) }, null, 2));
    return;
  }
  if (mode === "config") {
    const format = process.argv[3] ?? "json";
    const { allowlist, timeoutMs } = readMcpConfig();
    const presetName = process.argv[4];
    if (presetName !== undefined && !Object.hasOwn(mcpPresets, presetName)) throw new Error(`配置预设仅支持 ${Object.keys(mcpPresets).join("、")}。`);
    const profile = presetName === undefined ? undefined : mcpPresets[presetName];
    const selected = profile ? profile.tools.filter(name => allowlist === null || allowlist.has(name)) : allowlist === null ? null : [...allowlist];
    const hostPath = value => value.split(path.sep).join("/");
    const command = hostPath(process.execPath);
    const args = [hostPath(path.join(root, "scripts/mcp.mjs"))];
    // Carry restrictions into a desktop Host even when it does not inherit this shell's environment.
    const env = { RESUME_LIFE_DATA_DIR: hostPath(directory),
      RESUME_LIFE_MCP_REPO_ROOTS: JSON.stringify(readMcpRepositoryRoots().map(hostPath)),
      RESUME_LIFE_MCP_WRITE_ENABLED: String(profile?.writeEnabled ?? false), RESUME_LIFE_MCP_LLM_ENABLED: "false",
      RESUME_LIFE_MCP_TIMEOUT_MS: String(timeoutMs),
      RESUME_LIFE_MCP_CACHE_TTL_HOURS: String(cachePolicy.ttlHours), RESUME_LIFE_MCP_CACHE_MAX_BYTES: String(cachePolicy.maxBytes),
      ...(selected === null ? {} : { RESUME_LIFE_MCP_ALLOWED_TOOLS: selected.join(",") }) };
    const clientTimeoutSec = Math.ceil(timeoutMs / 1000) + 30;
    if (format === "json") console.log(JSON.stringify({ mcpServers: { "resume-life": { command, args, env } } }, null, 2));
    else if (format === "codex") console.log(`[mcp_servers.resume-life]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\nstartup_timeout_sec = 30\ntool_timeout_sec = ${clientTimeoutSec}\n\n[mcp_servers.resume-life.env]\n${Object.entries(env).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join("\n")}`);
    else throw new Error("配置格式仅支持 json 或 codex。");
    return;
  }
  globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
  const { register: registerEsm } = await import("tsx/esm/api");
  const { register: registerCjs } = await import("tsx/cjs/api");
  const options = { tsconfig: path.join(root, "tsconfig.json") };
  registerEsm(options);
  registerCjs(options);
  await import(new URL("../src/mcp/stdio.ts", import.meta.url).href);
}

main().catch(error => fail(error instanceof Error && error.message.startsWith("用法") ? error.message :
  error instanceof Error && /^(需要|RESUME_LIFE|数据目录|项目依赖|当前 Node|配置格式|配置预设)/.test(error.message) ? error.message : "启动失败，请检查运行时、依赖和 .env.local 格式。"));
