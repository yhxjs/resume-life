import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mcpPresets } from "../../src/mcp/config.mjs";
import { readContext, readAllPages, readArtifact, recoverReceipt, waitForJob, uploadBytes } from "./helpers.mjs";
import { runWorkflow } from "./workflow-runner.mjs";

const launcher = fileURLToPath(new URL("../../scripts/mcp.mjs", import.meta.url));

export class ResumeLifeClient {
  constructor(client) { this.client = client; }

  /** @param {{ dataDirectory: string, preset?: keyof typeof mcpPresets, timeoutMs?: number, cwd?: string, repositoryRoots?: string[] }} options */
  static async connect({ dataDirectory, preset = "readonly", timeoutMs = 120_000, cwd, repositoryRoots = [] }) {
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
    return (await this.readContext(tool, identity)).value;
  }

  readContext(name, args = {}, preview = false, options = {}) { return readContext(this.call.bind(this), name, args, preview, options); }
  readAllPages(name, args = {}, options = {}) { return readAllPages(this.call.bind(this), name, args, options); }
  readArtifact(artifact, options = {}) { return readArtifact(this.call.bind(this), artifact, options); }
  recoverReceipt(receipt, options = {}) { return recoverReceipt(this.call.bind(this), receipt, options); }
  waitForJob(jobId, options = {}) { return waitForJob(this.call.bind(this), jobId, options); }
  uploadBytes(input, options = {}) { return uploadBytes(this.call.bind(this), input, options); }
  runWorkflow(plan, options) { return runWorkflow(this.call.bind(this), plan, options); }

  async close() { await this.client.close(); }
}
