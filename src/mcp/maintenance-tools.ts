import * as z from "zod/v4";
import type { McpTools } from "./tools";
import { MCP_SERVER_VERSION, toolAccess } from "./config.mjs";
import { json, read, edit } from "./records";
import { maintainMcpState } from "@/lib/mcp-generation";
import { getMcpStatus } from "@/lib/mcp-status";

export function registerMaintenanceTools(tools: McpTools) {
  tools.register("get_mcp_status", { title: "读取 MCP 运行状态", description: "读取版本、已授权工具及草稿／生成请求／操作日志计数，用于接入排障。",
    inputSchema: z.strictObject({}), annotations: read }, async () => json({ serverVersion: MCP_SERVER_VERSION, ...getMcpStatus(),
    enabledTools: Object.keys(toolAccess).filter(name => tools.permits(name as keyof typeof toolAccess)) }));
  tools.register("maintain_mcp_state", { title: "清理过期 MCP 草稿和缓存", description: "按批次清理过期草稿正文和不可用的生成响应缓存，保留请求幂等墓碑和已保存记录入口。返回本批清理数量。",
    inputSchema: z.strictObject({ limit: z.number().int().min(1).max(1000).optional() }), annotations: edit }, async ({ limit }) => json(maintainMcpState(limit)));
}
