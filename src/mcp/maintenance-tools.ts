import * as z from "zod/v4";
import type { McpTools } from "./tools";
import { MCP_SERVER_VERSION, toolAccess } from "./config.mjs";
import { json, read, edit } from "./records";
import { maintainMcpState } from "@/lib/mcp-generation";
import { getMcpStatus } from "@/lib/mcp-status";
import { previewMcpCache, maintainMcpCache } from "@/lib/mcp-cache";
import { McpOperationError } from "@/lib/mcp-errors";

export function registerMaintenanceTools(tools: McpTools) {
  tools.register("preview_mcp_cache_cleanup", { title: "预览缓存清理", description: "列出过期产物、批次结果和孤立文件的数量、大小及摘要标识，不包含正文或本机路径；运行中任务保留。",
    inputSchema: z.strictObject({ limit: z.number().int().min(1).max(1000).optional() }), annotations: read }, async ({ limit }) => json(previewMcpCache(limit)));
  tools.register("cleanup_mcp_cache", { title: "清理已预览缓存", description: "按同一 limit 和 previewToken 删除可重建缓存；保留正式业务及幂等防重墓碑。预览变化时拒绝清理。",
    inputSchema: z.strictObject({ limit: z.number().int().min(1).max(1000).optional(), previewToken: z.string().regex(/^[a-f0-9]{64}$/) }), annotations: edit }, async ({ limit, previewToken }) => {
      if (!tools.permits("preview_mcp_cache_cleanup")) throw new McpOperationError("FORBIDDEN", "缓存清理需要预览能力");
      return json(maintainMcpCache(limit, previewToken));
    });
  tools.register("get_mcp_status", { title: "读取 MCP 运行状态", description: "读取版本、已授权工具及草稿／生成请求／操作日志计数，用于接入排障。",
    inputSchema: z.strictObject({}), annotations: read }, async () => json({ serverVersion: MCP_SERVER_VERSION, ...getMcpStatus(),
    enabledTools: Object.keys(toolAccess).filter(name => tools.permits(name as keyof typeof toolAccess)) }));
  tools.register("maintain_mcp_state", { title: "清理过期 MCP 草稿和缓存", description: "按批次清理过期草稿正文和不可用的生成响应缓存，保留请求幂等墓碑和已保存记录入口。返回本批清理数量。",
    inputSchema: z.strictObject({ limit: z.number().int().min(1).max(1000).optional() }), annotations: edit }, async ({ limit }) => json(maintainMcpState(limit)));
}
