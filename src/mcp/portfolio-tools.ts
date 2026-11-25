import * as z from "zod/v4";
import { getJargonContext, jargonResultSchema, saveJargonResult } from "@/lib/mcp-jargon";
import { getPortfolioSources, getPortfolioContext, exportMcpPortfolio } from "@/lib/mcp-portfolio";
import { PORTFOLIO_TEMPLATES } from "@/lib/portfolio-templates";
import { anonymizeConfigSchema } from "./export-tools";
import { contextPageInput } from "./content-tools";
import { id, json, key, read, revision, write } from "./records";
import { requireReads } from "./source-access";
import type { McpTools } from "./tools";

export function registerPortfolioTools(tools: McpTools) {
  const text = z.string().trim().min(1).max(40_000);
  tools.register("get_jargon_generation_context", { title: "读取黑话解码上下文", description: "读取完整原文、生产规则和结果 schema，由外部 Agent 分析；不调用服务端模型。", inputSchema: z.strictObject({ text, ...contextPageInput }), annotations: read }, async ({ text, ...page }) => json(getJargonContext(text, page)));
  tools.register("save_jargon_result", { title: "保存外部黑话解码结果", description: "校验原文引文、风险分档、结构和问题规则后保存；使用相同来源 revision 与幂等键。", inputSchema: z.strictObject({ text, expectedRevision: revision, result: jargonResultSchema, idempotencyKey: key }), annotations: write }, async input => {
    requireReads(tools, "get_jargon_generation_context"); return json(saveJargonResult(input));
  });
  const portfolioReads = () => requireReads(tools, "get_resume", "get_project", "get_portfolio_context");
  tools.register("get_portfolio_sources", { title: "读取作品集选材", description: "完整分页读取简历版本、项目档案、作品集模板与默认匿名化配置。", inputSchema: z.strictObject(contextPageInput), annotations: read }, async page => {
    portfolioReads(); return json(getPortfolioSources(page));
  });
  const link = z.string().max(2000);
  const options = z.strictObject({ resumeId: id, versionId: id.optional(), selectedProjects: z.array(z.strictObject({ projectId: id, featured: z.boolean().optional(), order: z.number().finite().optional(),
    customLinks: z.strictObject({ demoUrl: link.optional(), repoUrl: link.optional(), docUrl: link.optional() }).optional() })).max(50),
    themeMode: z.enum(["auto", "light", "dark"]).optional(), siteTemplate: z.enum(PORTFOLIO_TEMPLATES.map(template => template.id)).optional(), accentColor: z.string().regex(/^#[a-fA-F0-9]{6}$/).optional(),
    siteTitle: z.string().max(200).optional(), siteSubtitle: z.string().max(500).optional(), anonymizeConfig: anonymizeConfigSchema.optional() });
  tools.register("get_portfolio_context", { title: "预览作品集匿名化输出", description: "选择简历版本与项目，完整读取实际匿名化正文、链接、模板和来源修订。默认使用网页相同匿名化配置。", inputSchema: z.strictObject({ options, ...contextPageInput }), annotations: read }, async ({ options, ...page }) => {
    portfolioReads(); return json(getPortfolioContext(options, page));
  });
  tools.register("export_portfolio", { title: "导出离线作品集 ZIP", description: "按已预览内容打包静态主页和简历文件，返回固定产物标识及校验和；不部署到网络。", inputSchema: z.strictObject({ options, expectedRevision: revision, idempotencyKey: key }), annotations: write }, async (input, ctx) => {
    portfolioReads(); return json(await exportMcpPortfolio(input, ctx.mcpReq.signal));
  });
}
