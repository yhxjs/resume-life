import path from "node:path";
import { createHash } from "node:crypto";
import { inTransaction } from "./db";
import { assemblePortfolioData, loadPortfolioSources } from "./portfolio";
import type { PortfolioExportOptions } from "./portfolio-types";
import { processPortfolioAnonymization } from "./portfolio-anonymize";
import { createPortfolioZip } from "./portfolio-generator";
import { PORTFOLIO_TEMPLATES } from "./portfolio-templates";
import { DEFAULT_ANONYMIZE_CONFIG } from "./resume-anonymize";
import { isLocalAvatarUrl, type BasicContent } from "./modules";
import { readUploadFile, uploadPathFromUrl } from "./upload-storage";
import { assertMcpContext, mcpContextPage, mcpContextRevision, type ContextPageInput } from "./mcp-context";
import { createMcpArtifact } from "./mcp-artifacts";
import { reportMcpProgress } from "./mcp-progress";

export function getPortfolioSources(page: ContextPageInput) {
  return inTransaction(() => mcpContextPage({ ...loadPortfolioSources(), templates: PORTFOLIO_TEMPLATES, defaultAnonymizeConfig: DEFAULT_ANONYMIZE_CONFIG }, page));
}
function capture(options: PortfolioExportOptions) {
  const ordered = { ...options, selectedProjects: options.selectedProjects.map((item, index) => ({ ...item, order: item.order ?? index })).sort((a, b) => a.order - b.order) };
  const original = assemblePortfolioData(ordered), output = processPortfolioAnonymization(original);
  const avatarSources = output.resumeSnapshot.modules.filter(module => module.type === "basic").map(module => {
    const avatar = (module.content as BasicContent).avatar;
    const file = avatar && isLocalAvatarUrl(avatar) ? uploadPathFromUrl(avatar) : null;
    const data = file ? readUploadFile(path.basename(file)) : null;
    return { key: module.key, sha256: data ? createHash("sha256").update(data.bytes).digest("hex") : null };
  });
  return { workflow: "portfolio", options, original, output, avatarSources,
    instructions: "output 是按匿名化规则生成文件的实际数据，项目正文及自定义链接须核对。selectedProjects 的 order 决定展示顺序。导出使用本 revision，生成离线 ZIP 产物；不执行部署或公开发布。" };
}
export function getPortfolioContext(options: PortfolioExportOptions, page: ContextPageInput) { return inTransaction(() => mcpContextPage(capture(options), page)); }
export async function exportMcpPortfolio(input: { options: PortfolioExportOptions; expectedRevision: string; idempotencyKey: string }, signal: AbortSignal) {
  const { idempotencyKey, ...payload } = input;
  return createMcpArtifact("export_portfolio", idempotencyKey, payload, async signal => {
    const context = inTransaction(() => { const value = capture(input.options); assertMcpContext(value, input.expectedRevision); return value; });
    reportMcpProgress("packaging", 0, 1, "files");
    const bytes = await createPortfolioZip(context.output, signal);
    reportMcpProgress("packaging", 1, 1, "files");
    return { bytes, filename: `portfolio-${input.options.resumeId}.zip`, mimeType: "application/zip", sourceRevision: mcpContextRevision(context),
      validate: () => assertMcpContext(capture(input.options), input.expectedRevision) };
  }, signal);
}
