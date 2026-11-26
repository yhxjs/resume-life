import * as z from "zod/v4";
import { MCP_SEARCH_DOMAINS, searchRecordsPage } from "@/lib/mcp-search";
import { APPLICATION_STAGES } from "@/lib/applications-types";
import type { McpTools } from "./tools";
import { id, json, page, read } from "./records";
import { toolAccess } from "./config.mjs";

export function registerSearchTools(tools: McpTools) {
  tools.register("search_records_page", { title: "筛选并分页检索全部资料",
    description: "按固定领域顺序、领域内 ID 倒序检索所有匹配记录，返回命中片段和完整读取入口。domains 可限定领域；projectId 适用于项目、项目材料、练习；stages 适用于投递。createdFrom 含开始时刻，createdTo 不含结束时刻，均需时区。游标绑定筛选、权限和匹配结果；变化返回 CONFLICT，须重新开始。",
    inputSchema: z.strictObject({ query: z.string().trim().min(2).max(100), domains: z.array(z.enum(MCP_SEARCH_DOMAINS)).min(1).max(MCP_SEARCH_DOMAINS.length).optional(),
      projectId: id.optional(), stages: z.array(z.enum(APPLICATION_STAGES)).min(1).max(APPLICATION_STAGES.length).optional(),
      createdFrom: z.iso.datetime({ offset: true }).optional(), createdTo: z.iso.datetime({ offset: true }).optional(), ...page }), annotations: read },
    async input => json(searchRecordsPage(input, tool => tools.permits(tool as keyof typeof toolAccess))));
}
