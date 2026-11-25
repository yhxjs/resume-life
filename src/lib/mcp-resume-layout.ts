import { getDb, inTransaction, now } from "./db";
import { captureResumeDraft } from "./mcp-resume-draft";
import { RESUME_TEMPLATES, DEFAULT_STYLE, isTemplateRef, resolveStyle, sanitizeStyleOverrides } from "./templates";
import { readCustomTemplate, type StoredCustomTemplate } from "./custom-templates";
import { writeResumeLayout } from "./resume-layout-store";
import { assertMcpContext, mcpContextPage, mcpContextRevision, type ContextPageInput } from "./mcp-context";
import { McpOperationError } from "./mcp-errors";
import { mcpRevision } from "./mcp-revision";
import { mcpCreateOnce } from "./mcp-state";
import { listResumeAvatarUrls, removeUnreferencedUploadsByUrls } from "./upload-storage";

function capture(resumeId: number) {
  const draft = captureResumeDraft(resumeId);
  const templates = (getDb().prepare("SELECT id,name,style,created_at,updated_at FROM resume_templates ORDER BY id").all() as StoredCustomTemplate[]).map(readCustomTemplate);
  return { workflow: "resume-layout", draft, builtinTemplates: RESUME_TEMPLATES, customTemplates: templates, styleFields: DEFAULT_STYLE,
    instructions: "removeKeys 移除模块；moduleOrder 为移除后所有模块 key 的完整唯一顺序。styleOverrides 替换整份覆盖参数，{} 重置；预览显示归一化后值及 resolvedStyle。模板或草稿变化时重新读取。" };
}
export type LayoutProposal = { resumeId: number; expectedRevision: string; removeKeys?: string[]; moduleOrder?: string[]; template?: string; styleOverrides?: Record<string, unknown> };
function prepare(input: LayoutProposal) {
  const context = capture(input.resumeId); assertMcpContext(context, input.expectedRevision);
  const removed = input.removeKeys ?? [], existing = context.draft.modules.map(module => module.key);
  if (new Set(removed).size !== removed.length || removed.some(key => !existing.includes(key))) throw new McpOperationError("INVALID_ARGUMENT", "移除列表包含重复或不存在的模块");
  const retained = existing.filter(key => !removed.includes(key)), order = input.moduleOrder ?? retained;
  if (new Set(order).size !== order.length || order.length !== retained.length || order.some(key => !retained.includes(key))) throw new McpOperationError("INVALID_ARGUMENT", "排序必须包含移除后全部模块且不能重复");
  const template = input.template ?? String(context.draft.resume.template);
  if (!isTemplateRef(template)) throw new McpOperationError("INVALID_ARGUMENT", "模板引用无效");
  if (template.startsWith("custom:")) {
    const custom = context.customTemplates.find(row => row.id === Number(template.slice(7)));
    if (!custom || custom.corrupted) throw new McpOperationError("INVALID_ARGUMENT", "自定义模板不存在或损坏");
  }
  let currentOverrides: Record<string, unknown>;
  try {
    currentOverrides = JSON.parse(String(context.draft.resume.style_overrides));
    if (!currentOverrides || typeof currentOverrides !== "object" || Array.isArray(currentOverrides)) throw new Error("Invalid style overrides");
  }
  catch { if (input.styleOverrides === undefined) throw new McpOperationError("INVALID_ARGUMENT", "排版数据损坏，请显式提交 styleOverrides 修复"); currentOverrides = {}; }
  const styleOverrides = sanitizeStyleOverrides(input.styleOverrides ?? currentOverrides);
  if (input.styleOverrides && Object.keys(input.styleOverrides).some(key => !(key in styleOverrides))) throw new McpOperationError("INVALID_ARGUMENT", "包含不支持的样式字段");
  const saved = { removeKeys: removed, moduleOrder: order, template, styleOverrides };
  return { before: { modules: context.draft.modules, template: context.draft.resume.template, styleOverrides: currentOverrides },
    after: { modules: order.map((key, sort) => ({ ...context.draft.modules.find(module => module.key === key)!, sort })), template, styleOverrides,
      resolvedStyle: resolveStyle(template, context.customTemplates, styleOverrides) }, saved,
    previewToken: mcpRevision("content-preview", ["resume-layout", mcpContextRevision(context), saved]) };
}
export function getResumeLayoutContext(resumeId: number, page: ContextPageInput) { return inTransaction(() => mcpContextPage(capture(resumeId), page)); }
export function previewResumeLayout(input: LayoutProposal, page: ContextPageInput) {
  return inTransaction(() => { const result = prepare(input); return { ...mcpContextPage(result, page), previewToken: result.previewToken }; });
}
export function saveResumeLayout(input: LayoutProposal & { previewToken: string; idempotencyKey: string }) {
  const { idempotencyKey, ...payload } = input;
  let previousAvatars: string[] = [];
  const result = mcpCreateOnce("save_resume_layout", idempotencyKey, payload, () => {
    const prepared = prepare(input);
    if (prepared.previewToken !== input.previewToken) throw new McpOperationError("CONFLICT", "排版预览已变化");
    previousAvatars = listResumeAvatarUrls(getDb(), input.resumeId);
    writeResumeLayout(input.resumeId, { ...prepared.saved, at: now() });
    return { id: input.resumeId };
  }, id => !!getDb().prepare("SELECT 1 FROM resumes WHERE id=?").get(id));
  removeUnreferencedUploadsByUrls(previousAvatars);
  return result;
}
