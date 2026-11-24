import { Console } from "node:console";
import { McpConfigurationError, readMcpConfig } from "./config.mjs";

// 领域模块的 console.info（例如首次开库日志）也必须走 stderr。
// 在加载业务模块前切换，MCP transport 仍直接使用 process.stdout。
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });

async function main() {
  const config = readMcpConfig(); // Fail before starting the transport, not inside the deferred handshake factory.
  const { serveStdio } = await import("@modelcontextprotocol/server/stdio");
  const { createResumeLifeMcpServer } = await import("./server");
  const { logServerError } = await import("@/lib/server-errors");
  serveStdio(() => createResumeLifeMcpServer(config), { onerror: error => { logServerError("mcp.transport", error); } });
}

void main().catch(error => {
  console.error(error instanceof McpConfigurationError ? error.message : "MCP 服务启动失败，请检查 Node 版本、依赖和数据目录配置。");
  process.exitCode = 1;
});
