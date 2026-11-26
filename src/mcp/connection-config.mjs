import path from "node:path";
import { mcpPresets, readMcpConfig, permittedMcpTools } from "./config.mjs";
import { readMcpRepositoryRoots } from "./repository-config.mjs";
import { readMcpCachePolicy } from "./cache-config.mjs";

// Shared by CLI and authenticated Web settings. Never spread the host environment.
export function buildMcpConnectionConfig({ projectRoot, dataDirectory, nodePath = process.execPath, env = process.env, preset, format = "json" }) {
  if (preset !== undefined && (typeof preset !== "string" || !Object.hasOwn(mcpPresets, preset))) throw new Error("配置预设无效。");
  if (!["json", "codex"].includes(format)) throw new Error("配置格式仅支持 json 或 codex。");
  const repositoryRoots = readMcpRepositoryRoots(env);
  const hostPath = value => {
    if (typeof value !== "string" || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value) || !path.isAbsolute(value)) throw new Error("配置路径必须是有效的绝对路径（最多 4096 字符）。");
    return value.split(path.sep).join("/");
  };
  const config = readMcpConfig(env);
  const cache = readMcpCachePolicy(env);
  const profile = preset === undefined ? undefined : mcpPresets[preset];
  const selected = profile ? profile.tools.filter(name => config.allowlist === null || config.allowlist.has(name)) : config.allowlist === null ? null : [...config.allowlist];
  const command = hostPath(nodePath);
  hostPath(projectRoot);
  const args = [hostPath(path.join(projectRoot, "scripts/mcp.mjs"))];
  const hostEnv = {
    RESUME_LIFE_DATA_DIR: hostPath(dataDirectory),
    RESUME_LIFE_MCP_REPO_ROOTS: JSON.stringify(repositoryRoots.map(hostPath)),
    RESUME_LIFE_MCP_WRITE_ENABLED: String(profile?.writeEnabled ?? false),
    RESUME_LIFE_MCP_LLM_ENABLED: "false",
    RESUME_LIFE_MCP_TIMEOUT_MS: String(config.timeoutMs),
    RESUME_LIFE_MCP_CACHE_TTL_HOURS: String(cache.ttlHours),
    RESUME_LIFE_MCP_CACHE_MAX_BYTES: String(cache.maxBytes),
    ...(selected === null ? {} : { RESUME_LIFE_MCP_ALLOWED_TOOLS: selected.join(",") }),
    ...(env.RESUME_LIFE_OCR_DATA_DIR ? { RESUME_LIFE_OCR_DATA_DIR: hostPath(env.RESUME_LIFE_OCR_DATA_DIR) } : {}),
  };
  const server = { command, args, env: hostEnv };
  const text = format === "json" ? JSON.stringify({ mcpServers: { "resume-life": server } }, null, 2)
    : `[mcp_servers.resume-life]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\nstartup_timeout_sec = 30\ntool_timeout_sec = ${Math.ceil(config.timeoutMs / 1000) + 30}\n\n[mcp_servers.resume-life.env]\n${Object.entries(hostEnv).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join("\n")}`;
  const tools = permittedMcpTools(readMcpConfig(hostEnv));
  return { text, tools, writeEnabled: profile?.writeEnabled ?? false, repositoryRoots: repositoryRoots.map(hostPath), server };
}
