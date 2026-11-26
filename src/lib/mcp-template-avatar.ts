import { getDb, inTransaction, now } from "./db";
import { RESUME_TEMPLATES, DEFAULT_STYLE, customRef, resolveStyle, normalizeStyle, type ResumeStyle, type ResumeStyleOverrides } from "./templates";
import { listCustomTemplates, createCustomTemplate, normalizeTemplateUpdate, updateCustomTemplate } from "./template-store";
import { mcpContextPage, assertMcpContext, mcpContextRevision, type ContextPageInput } from "./mcp-context";
import { mcpCreateOnce } from "./mcp-state";
import { McpOperationError } from "./mcp-errors";
import { captureResumeDraft } from "./mcp-resume-draft";
import { readMcpUploadBytes } from "./mcp-uploads";
import { normalizeAvatar } from "./avatar-upload";
import { normalizeContent, type BasicContent } from "./modules";
import { saveUploadFile, removeUnreferencedUploadsByUrls } from "./upload-storage";
import { writeResumeDraftContent } from "./resume-draft-store";
import { assertOperationActive } from "./operation-deadline";
import { assertDataGeneration } from "./data-generation";
import { mcpCleanupScope, withMcpWorkLease } from "./mcp-work-leases";

function templateContext(templateId?: number) {
  const templates = listCustomTemplates();
  const selected = templateId === undefined ? null : templates.find(row => row.id === templateId);
  if (templateId !== undefined && !selected) throw new McpOperationError("NOT_FOUND", "模板不存在");
  const drafts = templateId === undefined ? [] : getDb().prepare("SELECT id,title,template,style_overrides,updated_at FROM resumes WHERE template=? ORDER BY id").all(customRef(templateId));
  return { builtins: RESUME_TEMPLATES, defaultStyle: DEFAULT_STYLE, customTemplates: templates, selected: selected ?? null, affectedDrafts: drafts,
    instructions: "创建时可使用内置或自定义 templateRef 复制，保存新模板不会切换现有简历。修改只影响当前引用模板的草稿；已发布版本使用冻结样式。用 resume-layout 单独选择模板。" };
}
export function getTemplateContext(templateId: number | undefined, page: ContextPageInput) { return inTransaction(() => mcpContextPage(templateContext(templateId), page)); }
export function createMcpTemplate(input: { name: string; style?: Record<string, unknown>; templateRef?: string; expectedRevision: string; idempotencyKey: string }) {
  const { idempotencyKey, ...payload } = input;
  return mcpCreateOnce("create_resume_template", idempotencyKey, payload, () => {
    const context = templateContext(); assertMcpContext(context, input.expectedRevision);
    if (input.style !== undefined && input.templateRef !== undefined) throw new McpOperationError("INVALID_ARGUMENT", "创建时只能选择 style 或 templateRef");
    let style: ResumeStyle | null;
    if (input.templateRef !== undefined) {
      const valid = RESUME_TEMPLATES.some(row => row.key === input.templateRef) || context.customTemplates.some(row => customRef(row.id) === input.templateRef && !row.corrupted);
      if (!valid) throw new McpOperationError("INVALID_ARGUMENT", "来源模板不存在或已损坏");
      style = resolveStyle(input.templateRef, context.customTemplates);
    } else style = normalizeStyle(input.style ?? {});
    if (!style) throw new McpOperationError("INVALID_ARGUMENT", "样式参数无效");
    return { id: createCustomTemplate({ name: input.name, style }).id };
  }, id => !!getDb().prepare("SELECT 1 FROM resume_templates WHERE id=?").get(id));
}
type TemplateEdit = { templateId: number; expectedRevision: string; name?: string; style?: Record<string, unknown> };
function templateProposal(input: TemplateEdit) {
  const context = templateContext(input.templateId); assertMcpContext(context, input.expectedRevision);
  const patch = normalizeTemplateUpdate(input), before = context.selected!;
  const after = { ...before, name: patch.name ?? before.name, style: patch.style ?? before.style, corrupted: patch.style ? false : before.corrupted ?? false };
  const customs = context.customTemplates.map(row => row.id === input.templateId ? after : row);
  const affectedDrafts = context.affectedDrafts.map(row => {
    let overrides: ResumeStyleOverrides = {};
    try {
      const parsed: unknown = JSON.parse(String(row.style_overrides));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid overrides");
      overrides = parsed as ResumeStyleOverrides;
    } catch { throw new McpOperationError("INVALID_ARGUMENT", "引用草稿的样式已损坏，请先修复"); }
    return { id: row.id, title: row.title, beforeCorrupted: before.corrupted === true,
      before: resolveStyle(String(row.template), context.customTemplates, overrides), after: resolveStyle(String(row.template), customs, overrides) };
  });
  return { before, after, affectedDrafts, previewToken: mcpContextRevision({ source: input.expectedRevision, after, affectedDrafts }) };
}
export function previewMcpTemplate(input: TemplateEdit, page: ContextPageInput) {
  return inTransaction(() => { const proposal = templateProposal(input); return { ...mcpContextPage(proposal, page), previewToken: proposal.previewToken }; });
}
export function saveMcpTemplate(input: TemplateEdit & { previewToken: string; idempotencyKey: string }) {
  const { idempotencyKey, ...payload } = input;
  return mcpCreateOnce("save_resume_template", idempotencyKey, payload, () => {
    const prepared = templateProposal(input);
    if (prepared.previewToken !== input.previewToken) throw new McpOperationError("CONFLICT", "模板预览已改变");
    if (!updateCustomTemplate(input.templateId, { name: input.name, style: input.style })) throw new McpOperationError("NOT_FOUND", "模板不存在");
    return { id: input.templateId };
  }, id => !!getDb().prepare("SELECT 1 FROM resume_templates WHERE id=?").get(id));
}
export function getAvatarContext(resumeId: number, page: ContextPageInput) {
  return inTransaction(() => mcpContextPage(captureResumeDraft(resumeId), page));
}
export async function setMcpAvatar(input: { resumeId: number; moduleKey: string; uploadId: string | null; expectedRevision: string; idempotencyKey: string }, signal: AbortSignal) {
  const { idempotencyKey, ...payload } = input;
  const exists = (id: number) => !!getDb().prepare("SELECT 1 FROM resumes WHERE id=?").get(id);
  if (getDb().prepare("SELECT 1 FROM mcp_creation_receipts WHERE tool='set_resume_avatar' AND request_key=?").get(idempotencyKey)) {
    return mcpCreateOnce("set_resume_avatar", idempotencyKey, payload, () => { throw new Error("Avatar receipt disappeared"); }, exists);
  }
  return withMcpWorkLease("parse", signal, async activeSignal => {
    const validate = () => {
      const context = captureResumeDraft(input.resumeId); assertMcpContext(context, input.expectedRevision);
      const resumeModule = context.modules.find(row => row.key === input.moduleKey);
      if (resumeModule?.type !== "basic") throw new McpOperationError("INVALID_ARGUMENT", "头像只能写入指定的基本信息模块");
      return normalizeContent("basic", resumeModule.content) as BasicContent;
    };
    inTransaction(validate);
    let freshUrl: string | undefined, previousUrl: string | undefined, committed = false;
    try {
      if (input.uploadId !== null) {
        const upload = readMcpUploadBytes(input.uploadId, "avatar"), avatar = await normalizeAvatar(upload.bytes);
        activeSignal.throwIfAborted(); assertOperationActive(); assertDataGeneration();
        freshUrl = (await saveUploadFile(avatar.bytes, avatar.extension)).url;
      }
      activeSignal.throwIfAborted();
      const result = mcpCreateOnce("set_resume_avatar", idempotencyKey, payload, () => {
        const basic = validate(); previousUrl = basic.avatar;
        writeResumeDraftContent(input.resumeId, { updates: [{ key: input.moduleKey, content: JSON.stringify({ ...basic, avatar: freshUrl ?? "" }) }], at: now() });
        return { id: input.resumeId };
      }, exists);
      committed = true; return result;
    } finally {
      // A competing same-key commit may have selected a different newly written file.
      mcpCleanupScope(() => removeUnreferencedUploadsByUrls([...(freshUrl ? [freshUrl] : []), ...(committed && previousUrl ? [previousUrl] : [])]));
    }
  });
}
