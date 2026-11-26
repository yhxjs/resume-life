import * as z from "zod/v4";
import { cancelMcpJob, getMcpJob, getMcpJobResult, listMcpJobs } from "@/lib/mcp-jobs";
import { recoverMcpArtifact } from "@/lib/mcp-artifacts";
import { recoverRepositoryCapture } from "@/lib/mcp-project-materials";
import { recoverFileExtraction } from "@/lib/mcp-file-import";
import { contextPageInput } from "./content-tools";
import { edit, json, read, revision, write } from "./records";
import type { McpTools } from "./tools";
import { toolAccess } from "./config.mjs";

export const MCP_JOB_OPERATIONS = {
  extract_uploaded_file: ["get_mcp_upload", "get_file_extraction"],
  export_resume: ["get_resume", "get_resume_export_context"],
  export_portfolio: ["get_resume", "get_project", "get_portfolio_context"],
  capture_project_repository: ["get_project", "list_project_materials", "get_project_material_context", "get_repository_catalog"],
} as const;
export function recoverJobResult(operation: string, key: string) {
  if (operation === "extract_uploaded_file") return recoverFileExtraction(key);
  if (operation === "export_resume" || operation === "export_portfolio") return recoverMcpArtifact(operation, key);
  if (operation === "capture_project_repository") return recoverRepositoryCapture(key);
  return undefined;
}
export function registerJobTools(tools: McpTools) {
  const permits = (name: string) => tools.permits(name as keyof typeof toolAccess);
  tools.register("start_mcp_job", { title: "提交持久任务", description: "异步执行已授权的导出、仓库采集或文件提取。arguments 使用原工具完整输入及原幂等键；同键返回同一任务。连接关闭不主动取消任务，重连后查询状态。", annotations: write,
    inputSchema: z.strictObject({ operation: z.enum(["export_resume", "export_portfolio", "capture_project_repository", "extract_uploaded_file"]), arguments: z.record(z.string(), z.json()), timeoutMs: z.number().int().min(100).max(600_000).optional() }) },
    async (input, ctx) => json(tools.startJob(input, ctx)));
  tools.register("get_mcp_job", { title: "查询持久任务", description: "读取运行、完成、取消、中断或恢复失效状态；只返回元数据，结果另行分页读取。", annotations: read,
    inputSchema: z.strictObject({ jobId: revision }) }, async ({ jobId }) => json(getMcpJob(jobId, permits, recoverJobResult)));
  tools.register("list_mcp_jobs", { title: "查找持久任务", description: "按创建顺序分页列出当前有来源读取权限的任务；空页仍可能有 nextCursor。", annotations: read,
    inputSchema: z.strictObject({ limit: z.number().int().min(1).max(50).optional(), cursor: z.string().max(200).optional() }) }, async input => json(listMcpJobs(input, permits, recoverJobResult)));
  tools.register("get_mcp_job_result", { title: "读取任务结果", description: "分页读取已经提交的任务结果；导出返回产物入口，采集返回固定快照入口。", annotations: read,
    inputSchema: z.strictObject({ jobId: revision, ...contextPageInput }) }, async ({ jobId, ...page }) => json(getMcpJobResult(jobId, page, permits, recoverJobResult)));
  tools.register("cancel_mcp_job", { title: "取消持久任务", description: "取消尚未提交的任务，需要原操作写权限。已经完成的任务保留原结果；跨进程提交前会复核取消状态。", annotations: edit,
    inputSchema: z.strictObject({ jobId: revision }) }, async ({ jobId }) => json(cancelMcpJob(jobId, permits, recoverJobResult)));
}
