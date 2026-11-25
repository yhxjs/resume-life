import * as z from "zod/v4";
import { listMcpBankDirections, listMcpDiscovered } from "@/lib/mcp-discovery";
import { id, json, page, read } from "./records";
import type { McpTools } from "./tools";

export function registerDiscoveryTools(tools: McpTools) {
  const q = z.string().max(100).optional();
  for (const [name, kind, title] of [["list_intros", "intro", "发现自我介绍"], ["list_jd_portraits", "jd_portrait", "发现 JD 画像"],
    ["list_interview_series", "interview_series", "发现进阶面试系列"]] as const) {
    tools.register(name, { title, description: "独立分页列表，可按 q 检索岗位文字；返回完整记录的读取入口。无需先绑定投递。",
      inputSchema: z.strictObject({ ...page, q, ...(kind === "jd_portrait" ? {} : { resumeId: id.optional() }) }), annotations: read },
    async input => json(listMcpDiscovered(kind, { ...input, resumeId: typeof input.resumeId === "number" ? input.resumeId : undefined })));
  }
  tools.register("list_bank_directions", { title: "发现题库方向", description: "分页列出已有题库方向和题数，支持 q 检索；用 direction 筛选 list_bank_entries。",
    inputSchema: z.strictObject({ ...page, q }), annotations: read }, async input => json(listMcpBankDirections(input)));
}
