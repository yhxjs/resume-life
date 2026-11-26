import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { MCP_SERVER_VERSION, mcpPresets, toolAccess } from "../src/mcp/config.mjs";
import { readContext } from "../examples/mcp/helpers.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const destination = path.join(root, "docs/MCP-TOOLS.md");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-mcp-contract-"));
const client = new Client({ name: "mcp-contract-check", version: "1" });
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, "scripts/mcp.mjs")], cwd: temporary, stderr: "pipe",
    env: { RESUME_LIFE_DATA_DIR: temporary, RESUME_LIFE_MCP_ALLOWED_TOOLS: Object.keys(toolAccess).join(","),
      RESUME_LIFE_MCP_WRITE_ENABLED: "true", RESUME_LIFE_MCP_LLM_ENABLED: "true" } }));
  const tools = (await client.listTools()).tools.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const names = new Set(tools.map(tool => tool.name));
  assert.equal(names.size, tools.length);
  assert.deepEqual([...names].sort(), Object.keys(toolAccess).sort());
  for (const tool of tools) {
    assert.equal(tool.inputSchema?.type, "object", tool.name + " input schema");
    assert.equal(tool.outputSchema?.oneOf?.length, 2, tool.name + " success/error envelope");
    assert.equal(tool.annotations?.readOnlyHint, toolAccess[tool.name] === "read", tool.name + " permission annotation");
    for (const key of tool.inputSchema.required ?? []) assert.ok(Object.hasOwn(tool.inputSchema.properties ?? {}, key), tool.name + ":" + key);
  }
  for (const [name, preset] of Object.entries(mcpPresets)) {
    assert.equal(new Set(preset.tools).size, preset.tools.length, name + " duplicate permission");
    for (const tool of preset.tools) assert.ok(names.has(tool), name + ":" + tool);
    assert.equal(preset.llmEnabled, false, name + " external collaboration enables model calls");
  }
  // Check literal dependencies, including helper functions shared by tool handlers.
  for (const filename of fs.readdirSync(path.join(root, "src/mcp")).filter(name => name.endsWith(".ts") && !name.includes(".test."))) {
    const source = ts.createSourceFile(filename, fs.readFileSync(path.join(root, "src/mcp", filename), "utf8"), ts.ScriptTarget.Latest, true);
    const visit = node => {
      if (ts.isCallExpression(node) && node.expression.getText(source) === "requireReads") {
        for (const arg of node.arguments.slice(1)) if (ts.isStringLiteral(arg)) assert.equal(toolAccess[arg.text], "read", filename + " invalid read dependency " + arg.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const call = async (name, args) => {
    const response = await client.callTool({ name, arguments: args });
    assert.equal(response.structuredContent?.ok, true, JSON.stringify(response.structuredContent));
    return response.structuredContent.data;
  };
  const catalog = (await readContext(call, "get_workflow_catalog")).value;
  const flows = catalog.workflows;
  assert.equal(new Set(flows.map(flow => flow.id)).size, flows.length, "duplicate workflow");
  for (const flow of flows) {
    assert.ok(flow.available, flow.id + " missing capability");
    for (const dependency of flow.requiredTools) assert.ok(names.has(dependency), flow.id + ":" + dependency);
    for (const step of flow.steps) {
      const schema = tools.find(tool => tool.name === step.tool).inputSchema;
      for (const required of schema.required ?? []) assert.ok(Object.hasOwn(step.inputs, required), flow.id + ":" + step.tool + ":" + required);
      for (const input of Object.keys(step.inputs)) assert.ok(Object.hasOwn(schema.properties ?? {}, input), flow.id + " unknown argument " + input);
    }
  }
  const counts = Object.values(toolAccess).reduce((all, access) => ({ ...all, [access]: (all[access] ?? 0) + 1 }), {});
  const quote = value => "`" + value + "`";
  const output = [
    "# MCP 能力契约", "",
    "由 " + quote("node scripts/check-mcp-contract.mjs --write") + " 从实际 stdio tools/list 和工作流目录生成。CI 使用无参数命令检查漂移。", "",
    "版本 " + MCP_SERVER_VERSION + "；" + tools.length + " 个工具（" + counts.read + " 只读、" + counts.write + " 写入、" + counts.llm + " 模型）；" + flows.length + " 个工作流。", "",
    "| 工具 | 权限 | 输入契约 SHA-256 | 输出契约 SHA-256 |", "|---|---|---|---|",
    ...tools.map(tool => "| " + quote(tool.name) + " | " + toolAccess[tool.name] + " | " + quote(hash(tool.inputSchema)) + " | " + quote(hash(tool.outputSchema)) + " |"), "",
    "| 工作流 | 必要能力 |", "|---|---|",
    ...flows.map(flow => "| " + quote(flow.id) + " | " + flow.requiredTools.map(quote).join("、") + " |"), "",
    "工作流完整绑定契约 SHA-256：" + quote(hash(flows)) + "。", "",
    "| 预设 | 工具数 |", "|---|---|", ...Object.entries(mcpPresets).map(([name, preset]) => "| " + name + " | " + preset.tools.length + " |"), "",
  ].join("\n");
  if (process.argv.includes("--write")) fs.writeFileSync(destination, output);
  else assert.equal(fs.readFileSync(destination, "utf8").replaceAll("\r\n", "\n"), output, "MCP 能力契约文档已过期");
  const docs = fs.readFileSync(path.join(root, "docs/MCP.md"), "utf8");
  assert.ok(docs.includes(MCP_SERVER_VERSION) && docs.includes(String(tools.length) + " 个工具"), "MCP.md version/count mismatch");
  assert.ok(docs.includes(counts.read + " 个只读、" + counts.write + " 个业务写入、" + counts.llm + " 个可选服务端模型工具"), "MCP.md permission counts mismatch");
  for (const [name, preset] of Object.entries(mcpPresets)) {
    assert.ok(docs.includes("| " + quote(name) + " | " + preset.tools.length + " |"), "MCP.md preset count mismatch: " + name);
  }
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  assert.ok(readme.includes(counts.read + " 个只读工具、" + counts.write + " 个可选写工具和 " + counts.llm + " 个可选模型生成工具"), "README permission counts mismatch");
  console.log(JSON.stringify({ ok: true, tools: tools.length, workflows: flows.length, counts }));
} finally {
  await client.close();
  if (path.dirname(path.resolve(temporary)) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith("resume-life-mcp-contract-")) throw new Error("Unsafe contract cleanup");
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
