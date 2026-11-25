import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mcpPresets } from "../../src/mcp/config.mjs";

const launcher = fileURLToPath(new URL("../../scripts/mcp.mjs", import.meta.url));

export class ResumeLifeClient {
  constructor(client) { this.client = client; }

  static async connect({ dataDirectory, preset = "readonly", timeoutMs = 120_000, cwd, repositoryRoots = [] } = {}) {
    if (!path.isAbsolute(dataDirectory ?? "")) throw new Error("dataDirectory 必须为绝对路径");
    if (!Object.hasOwn(mcpPresets, preset)) throw new Error("未知的 MCP 权限预设");
    if (!Array.isArray(repositoryRoots) || repositoryRoots.some(root => typeof root !== "string" || !path.isAbsolute(root))) throw new Error("repositoryRoots 必须是绝对目录数组");
    const profile = mcpPresets[preset];
    const client = new Client({ name: "resume-life-example-agent", version: "1.0.0" });
    try {
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [launcher], cwd, stderr: "inherit",
        env: { RESUME_LIFE_DATA_DIR: dataDirectory, RESUME_LIFE_MCP_REPO_ROOTS: JSON.stringify(repositoryRoots), RESUME_LIFE_MCP_WRITE_ENABLED: String(profile.writeEnabled), RESUME_LIFE_MCP_LLM_ENABLED: "false",
          RESUME_LIFE_MCP_ALLOWED_TOOLS: profile.tools.join(","), RESUME_LIFE_MCP_TIMEOUT_MS: String(timeoutMs) } }));
      return new ResumeLifeClient(client);
    } catch (error) { await client.close(); throw error; }
  }

  async call(name, args = {}) {
    const result = await this.client.callTool({ name, arguments: args });
    const envelope = result.structuredContent;
    if (result.isError || envelope?.ok === false) {
      throw Object.assign(new Error(envelope?.error?.message ?? "MCP 调用失败"), envelope?.error, { tool: name, requestId: envelope?.meta?.requestId });
    }
    if (envelope?.ok !== true || !Object.hasOwn(envelope, "data")) throw new Error("MCP 响应缺少结构化结果");
    return envelope.data;
  }

  /** Use the returned pointer verbatim, including workflowKind/interviewId/versionId. */
  async readFull(pointer) {
    if (pointer.tool !== "read_record_section") throw new Error("不支持的完整正文入口");
    const { tool, ...identity } = pointer;
    let offset = 0, expectedRevision;
    const fragments = [];
    for (;;) {
      const part = await this.call(tool, { ...identity, offset, ...(expectedRevision ? { expectedRevision } : {}) });
      if (part.encoding !== "json/utf-16" || part.offset !== offset || (expectedRevision && part.revision !== expectedRevision)) throw new Error("正文片段与读取版本不符");
      fragments.push(part.text);
      if (part.nextOffset === null) return JSON.parse(fragments.join(""));
      if (part.nextOffset <= offset) throw new Error("正文游标没有推进");
      offset = part.nextOffset; expectedRevision = part.revision;
    }
  }

  async close() { await this.client.close(); }
}
