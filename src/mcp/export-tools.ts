import * as z from "zod/v4";
import { getResumeExportContext, exportMcpResume } from "@/lib/mcp-resume-export";
import { readMcpArtifact } from "@/lib/mcp-artifacts";
import { contextPageInput } from "./content-tools";
import { id, json, key, read, revision, write } from "./records";
import { requireReads } from "./source-access";
import type { McpTools } from "./tools";

export const anonymizeConfigSchema = z.strictObject({
  name: z.strictObject({ enabled: z.boolean(), mode: z.enum(["surname_only", "placeholder", "keep"]), customPlaceholder: z.string().max(200).optional() }),
  phone: z.strictObject({ enabled: z.boolean(), mode: z.enum(["prefix_only", "mask_middle", "placeholder", "remove"]) }),
  email: z.strictObject({ enabled: z.boolean(), mode: z.enum(["mask_account", "placeholder", "remove"]) }),
  location: z.strictObject({ enabled: z.boolean(), mode: z.enum(["city_only", "placeholder", "remove"]) }),
  birthday: z.strictObject({ enabled: z.boolean(), mode: z.enum(["year_only", "placeholder", "remove"]) }),
  links: z.strictObject({ enabled: z.boolean(), mode: z.enum(["domain_only", "remove"]) }),
  avatar: z.strictObject({ enabled: z.boolean() }),
  customRules: z.array(z.strictObject({ id: z.string().max(100), source: z.string().max(2000), replacement: z.string().max(2000), matchCase: z.boolean().optional() })).max(100),
});
export function registerExportTools(tools: McpTools) {
  const source = z.strictObject({ resumeId: id, versionId: id.optional(), anonymizeConfig: anonymizeConfigSchema.optional(), confirmedIssueIds: z.array(z.string().max(20_000)).max(100).optional() });
  const resumeReads = () => requireReads(tools, "get_resume", "get_resume_export_context");
  tools.register("get_resume_export_context", { title: "预览简历文件导出", description: "完整读取确切草稿或发布版本、实际匿名化输出、冻结排版和导出检查结果。数字确认以当前问题 ID 为准。", inputSchema: z.strictObject({ source, ...contextPageInput }), annotations: read }, async ({ source, ...page }) => {
    resumeReads(); return json(getResumeExportContext(source, page));
  });
  tools.register("export_resume", { title: "导出简历文件", description: "按已预览来源生成 Markdown、PDF 或 DOCX。返回固定产物标识、大小和校验和；相同幂等键重放原产物，读取使用 read_export_artifact。", inputSchema: z.strictObject({ source, format: z.enum(["markdown", "pdf", "docx"]), expectedRevision: revision, idempotencyKey: key }), annotations: write }, async (input, ctx) => {
    resumeReads(); return json(await exportMcpResume(input, ctx.mcpReq.signal));
  });
  tools.register("read_export_artifact", { title: "分段读取导出文件", description: "按产物标识读取至多 8000 字节，返回 base64 和下一字节偏移。每段单独解码再拼接。重连可继续读取；备份恢复后旧产物失效。", inputSchema: z.strictObject({ artifactId: revision, offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(), length: z.number().int().min(1).max(8000).optional() }), annotations: read }, async input => json(readMcpArtifact(input, creator => {
    if (creator === "export_resume") resumeReads();
    else requireReads(tools, "get_resume", "get_project", "get_portfolio_context");
  })));
}
