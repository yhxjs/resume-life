import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { buildMcpConnectionConfig } from "@/mcp/connection-config.mjs";
import { DATA_DIR } from "./db";
import { getMcpStatus } from "./mcp-status";
import type { McpConnectionCheck, McpConnectionConfig, McpConnectionFormat, McpConnectionPreset, McpConnectionReport } from "./mcp-connection-types";

const presets: McpConnectionReport["presets"] = [
  { name: "readonly", label: "只读", description: "读取资料和运行状态，适合首次连接。" },
  { name: "preparation", label: "求职准备", description: "管理求职准备与进度，允许对应写入。" },
  { name: "collaboration", label: "全面协作", description: "开放预设内的读取和写入，由外部 Agent 协作。" },
  { name: "training", label: "面试训练", description: "访问训练与复习流程，允许对应写入。" },
  { name: "authoring", label: "内容创作", description: "编辑项目、简历和自我介绍，允许对应写入。" },
];

export class McpConnectionInputError extends Error {}

export function parseMcpConnectionInput(value: unknown): { preset: McpConnectionPreset; format: McpConnectionFormat } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new McpConnectionInputError("请选择预设和配置格式。");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).some(key => key !== "preset" && key !== "format")
    || typeof body.preset !== "string" || body.preset.length > 32 || !presets.some(p => p.name === body.preset)
    || (body.format !== "json" && body.format !== "codex")) throw new McpConnectionInputError("预设或格式无效；仅接受 preset 和 format。");
  return { preset: body.preset as McpConnectionPreset, format: body.format };
}

export function generateMcpConnection(input: ReturnType<typeof parseMcpConnectionInput>): McpConnectionConfig {
  const generated = buildMcpConnectionConfig({ projectRoot: process.cwd(), dataDirectory: DATA_DIR, ...input });
  return { ...input, text: generated.text, toolCount: generated.tools.length, writeEnabled: generated.writeEnabled,
    firstCallAvailable: generated.tools.includes("get_mcp_status") };
}

function readableFile(file: string) {
  if (!fs.statSync(file).isFile()) throw new Error("Not a file");
  fs.accessSync(file, fs.constants.R_OK);
}

/** Read-only probes; no process spawning, downloads, user paths or arbitrary env projection. */
export async function diagnoseMcpConnection(): Promise<McpConnectionReport> {
  const projectRoot = process.cwd();
  const checks: McpConnectionCheck[] = [];
  const check = async (id: string, label: string, probe: () => string | Promise<string>, repair: string, optional = false) => {
    try { checks.push({ id, label, state: "pass", detail: await probe(), repair: "" }); }
    catch { checks.push({ id, label, state: optional ? "warning" : "error", detail: "检查未通过。", repair }); }
  };
  await check("runtime", "原生 Node 与 SQLite", async () => {
    const [major, minor] = process.versions.node.split(".").map(Number);
    if (major !== 24 || (minor ?? 0) < 21) throw new Error();
    const { DatabaseSync } = await import("node:sqlite");
    const memory = new DatabaseSync(":memory:");
    try { memory.prepare("SELECT 1").get(); } finally { memory.close(); }
    return "Node 24.21+（24.x）与内存 SQLite 查询通过。";
  }, "安装 Node.js 24.21.0 或更新的 24.x，用该 Node 重启应用后重新生成配置。");
  await check("entry", "项目入口与依赖", () => {
    readableFile(path.join(projectRoot, "scripts/mcp.mjs"));
    readableFile(path.join(projectRoot, "src/mcp/stdio.ts"));
    const resolve = createRequire(path.join(projectRoot, "package.json")).resolve;
    for (const dependency of ["tsx/esm/api", "tsx/cjs/api", "@modelcontextprotocol/server", "zod"]) resolve(dependency);
    return "启动脚本、TypeScript 入口和 MCP 依赖均可读取；尚未运行 stdio 握手。";
  }, "在完整项目目录执行 npm ci，并从该目录启动应用；仅复制 Next 构建产物不足以启动 MCP。");
  await check("data", "数据目录权限", () => {
    let ancestor = DATA_DIR;
    while (!fs.existsSync(ancestor)) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw new Error();
      ancestor = parent;
    }
    if (!fs.statSync(ancestor).isDirectory()) throw new Error();
    fs.accessSync(ancestor, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
    const database = path.join(DATA_DIR, "resume-life.db");
    if (fs.existsSync(database)) { readableFile(database); fs.accessSync(database, fs.constants.W_OK); }
    return "当前应用账户通过目录访问权限检查；外部 Host 账户需拥有相同权限。未执行文件写入探针。";
  }, "检查 RESUME_LIFE_DATA_DIR 的绝对路径、磁盘挂载及目录/数据库读写权限。用相同操作系统账户启动 Host。");
  let repositoryRoots: string[] = [];
  await check("config", "权限白名单与配置", () => {
    const generated = buildMcpConnectionConfig({ projectRoot, dataDirectory: DATA_DIR, preset: "readonly" });
    repositoryRoots = generated.repositoryRoots;
    return "预设与现有工具白名单取交集；所有预设均关闭服务端模型调用。";
  }, "检查 MCP 工具白名单、超时、缓存参数，以及仓库/OCR 绝对路径配置；修正启动环境后重启应用。");
  await check("chromium", "Chromium / PDF 导出", async () => {
    const { chromium } = await import("playwright-core");
    readableFile(chromium.executablePath());
    return "检测到 Playwright Chromium 文件；未验证浏览器启动或系统动态库。";
  }, "在项目目录执行 npx playwright install chromium（Linux 可用 --with-deps）。导出也会尝试本机 Chrome/Edge；请用一次 PDF 导出确认可用。", true);
  await check("ocr", "本地 OCR", () => {
    const directory = process.env.RESUME_LIFE_OCR_DATA_DIR || projectRoot;
    if (!path.isAbsolute(directory)) throw new Error();
    createRequire(path.join(projectRoot, "package.json")).resolve("tesseract.js");
    for (const language of ["chi_sim", "eng"]) {
      const file = path.join(directory, `${language}.traineddata`);
      readableFile(file);
      if (fs.statSync(file).size === 0) throw new Error();
    }
    return "中文与英文语言包及 Tesseract 依赖已存在；未验证识别质量。";
  }, "在项目目录执行 npm run setup:ocr；如指定 RESUME_LIFE_OCR_DATA_DIR，请使用绝对路径并把两份语言包放入该目录。扫描件导入时选择本地 OCR。", true);
  let status: McpConnectionReport["status"] = null;
  await check("status", "当前应用运行摘要", () => {
    const current = getMcpStatus();
    // Explicit projection excludes any future additions until their public contract is reviewed.
    status = { databaseVersion: current.databaseVersion, workspaceBinding: current.workspaceBinding, operationLogCount: current.operationLogCount,
      jobs: current.jobs, leases: current.leases, cache: current.cache,
      drafts: { total: current.drafts.total, available: current.drafts.available, expired: current.drafts.expired },
      generationRequests: { pending: current.generationRequests.pending, interrupted: current.generationRequests.interrupted,
        succeeded: current.generationRequests.succeeded, failed: current.generationRequests.failed } };
    return "已读取当前 Web 应用的数据库摘要。外部 Host 连接状态未知。";
  }, "检查应用数据库状态，修复后刷新诊断。");
  return { node: process.version, nodePath: process.execPath, projectRoot, dataDirectory: DATA_DIR, repositoryRoots,
    presets, checks, canGenerate: checks.every(c => c.state !== "error"), status };
}
