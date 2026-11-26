import path from "node:path";
import { createHash } from "node:crypto";
import { inTransaction } from "./db";
import { loadResume } from "./resumes";
import { loadCustomTemplate } from "./custom-templates";
import { resolveStyle } from "./templates";
import { isLocalAvatarUrl, type BasicContent } from "./modules";
import { readUploadFile, uploadPathFromUrl } from "./upload-storage";
import { anonymizeResumeData, DEFAULT_ANONYMIZE_CONFIG, isAnonymizeConfig, type AnonymizeConfig } from "./resume-anonymize";
import { inspectResumeForExport } from "./resume-export-check";
import { resumeToMarkdown } from "./resume-markdown";
import { resumeToDocx } from "./resume-docx";
import { generateResumePdf, renderResumeToHtml } from "./pdf-render";
import { assertMcpContext, mcpContextPage, mcpContextRevision, type ContextPageInput } from "./mcp-context";
import { McpOperationError } from "./mcp-errors";
import { createMcpArtifact } from "./mcp-artifacts";

export type ResumeExportSource = { resumeId: number; versionId?: number; anonymizeConfig?: AnonymizeConfig; confirmedIssueIds?: string[] };
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_REPLACEMENTS = 100_000;

function prepareOutput(original: NonNullable<ReturnType<typeof loadResume>>, source: ResumeExportSource) {
  let reservedBytes = Buffer.byteLength(JSON.stringify([original, source]));
  let replacements = 0;
  const checkBudget = () => {
    if (reservedBytes > MAX_SOURCE_BYTES || replacements > MAX_REPLACEMENTS) {
      throw new McpOperationError("INVALID_ARGUMENT", "简历导出来源或脱敏替换超过预算（4 MiB / 100000 次），请精简正文或替换规则");
    }
  };
  const config = source.anonymizeConfig;
  if (config?.name.enabled && config.name.mode === "placeholder") {
    reservedBytes += original.modules.filter(module => module.type === "basic").length
      * Buffer.byteLength(config.name.customPlaceholder || "某候选人");
  }
  checkBudget();
  // 不扣除旧文本：替换链中途膨胀后再缩短也必须在分配前受限，标题和正文共用预算。
  return config ? anonymizeResumeData(original, config, rule => {
    reservedBytes += Buffer.byteLength(rule.replacement);
    replacements++;
    checkBudget();
  }) : structuredClone(original);
}

function prepare(source: ResumeExportSource) {
  const original = loadResume(source.resumeId, source.versionId);
  if (!original) throw new McpOperationError("NOT_FOUND", "简历或发布版本不存在");
  if (original.corruptedKeys.length || original.resume.styleCorrupted) throw new McpOperationError("INVALID_ARGUMENT", "正文或排版数据损坏，不能导出");
  if (source.anonymizeConfig !== undefined && !isAnonymizeConfig(source.anonymizeConfig)) throw new McpOperationError("INVALID_ARGUMENT", "匿名化配置无效");
  const data = prepareOutput(original, source);
  const customs = !original.resume.resolved_style && original.resume.template.startsWith("custom:") ? [loadCustomTemplate(Number(original.resume.template.slice(7)))] : [];
  data.resume.resolved_style = original.resume.resolved_style ?? resolveStyle(original.resume.template, customs, original.resume.style_overrides);
  const confirmed = new Set(source.confirmedIssueIds ?? []);
  const originalCheck = inspectResumeForExport({ title: original.resume.title, modules: original.modules, confirmedIssueIds: confirmed });
  const outputCheck = inspectResumeForExport({ title: data.resume.title, modules: data.modules, confirmedIssueIds: confirmed });
  const basic = data.modules.find(module => module.type === "basic")?.content as Partial<BasicContent> | undefined;
  const avatarPath = basic?.avatar && isLocalAvatarUrl(basic.avatar) ? uploadPathFromUrl(basic.avatar) : null;
  const avatar = avatarPath ? readUploadFile(path.basename(avatarPath)) : null;
  const avatarBytes = avatar?.contentType.startsWith("image/") ? avatar.bytes : undefined;
  const context = { workflow: "resume-export", source, original, output: data, originalCheck, outputCheck,
    avatarSha256: avatarBytes ? createHash("sha256").update(avatarBytes).digest("hex") : null, defaultAnonymizeConfig: DEFAULT_ANONYMIZE_CONFIG,
    canExport: originalCheck.canExport && outputCheck.canExport,
    instructions: "预览包含实际导出正文与排版。按业务规则核对阻塞项后，可用 confirmedIssueIds 重读上下文。export_resume 需当前 revision。产物用 read_export_artifact 分段 base64 读取，逐段解码后按字节拼接并核对 sha256。" };
  return { context, data, avatarBytes };
}
export function getResumeExportContext(source: ResumeExportSource, page: ContextPageInput) {
  return inTransaction(() => mcpContextPage(prepare(source).context, page));
}
export async function exportMcpResume(input: { source: ResumeExportSource; format: "markdown" | "pdf" | "docx"; expectedRevision: string; idempotencyKey: string }, signal: AbortSignal) {
  const { idempotencyKey, ...payload } = input;
  return createMcpArtifact("export_resume", idempotencyKey, payload, async signal => {
    const prepared = inTransaction(() => { const value = prepare(input.source); assertMcpContext(value.context, input.expectedRevision); return value; });
    if (!prepared.context.canExport) throw new McpOperationError("CONFLICT", "导出存在未核对阻塞项，请读取导出上下文");
    const { data, avatarBytes } = prepared;
    signal.throwIfAborted();
    const bytes = input.format === "markdown" ? Buffer.from(resumeToMarkdown(data.resume.title, data.modules), "utf8")
      : input.format === "docx" ? await resumeToDocx(data.resume.title, data.modules, { style: data.resume.resolved_style!, avatar: avatarBytes })
        : await generateResumePdf(renderResumeToHtml(data, []), signal);
    signal.throwIfAborted();
    return { bytes, filename: `resume-${input.source.resumeId}${input.source.versionId ? `-v${input.source.versionId}` : "-draft"}.${input.format === "markdown" ? "md" : input.format}`,
      mimeType: input.format === "markdown" ? "text/markdown; charset=utf-8" : input.format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sourceRevision: mcpContextRevision(prepared.context), validate: () => assertMcpContext(prepare(input.source).context, input.expectedRevision) };
  }, signal);
}
