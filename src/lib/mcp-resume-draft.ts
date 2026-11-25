import * as z from "zod/v4";
import { getDb, inTransaction, now } from "./db";
import { createResume, copyResume } from "./resume-creation";
import { loadResume } from "./resumes";
import { isModuleKey, isValidModuleContentInput, normalizeContent } from "./modules";
import { writeResumeDraftContent } from "./resume-draft-store";
import { mcpResumeModuleSchema, type McpResumeModule } from "./mcp-resume-contract";
import { assertMcpContext, mcpContextPage, mcpContextRevision, type ContextPageInput } from "./mcp-context";
import { McpOperationError } from "./mcp-errors";
import { mcpRevision } from "./mcp-revision";
import { mcpCreateOnce } from "./mcp-state";
import { avatarUrlFromContent, removeUnreferencedUploadsByUrls } from "./upload-storage";

function capture(resumeId: number) {
  const db = getDb(), resume = db.prepare("SELECT id,title,template,style_overrides,base_version_id,created_at,updated_at FROM resumes WHERE id=?").get(resumeId);
  if (!resume) throw new McpOperationError("NOT_FOUND", "简历不存在");
  const raw = db.prepare("SELECT module_key,type,label,sort,content FROM resume_modules WHERE resume_id=? ORDER BY sort,id").all(resumeId) as
    { module_key: string; type: string; label: string; sort: number; content: string }[];
  const modules = raw.map(row => {
    let content: unknown;
    try { content = JSON.parse(row.content); } catch { throw new McpOperationError("INVALID_ARGUMENT", "草稿模块损坏，请先在网页核对"); }
    if (!isModuleKey(row.type) || !isValidModuleContentInput(row.type, content)) throw new McpOperationError("INVALID_ARGUMENT", "草稿模块结构无效，请先核对原文");
    return { key: row.module_key, type: row.type, label: row.label, sort: row.sort, content };
  });
  return { workflow: "resume-draft", resume, modules, raw,
    moduleSchema: z.toJSONSchema(mcpResumeModuleSchema),
    instructions: "modules 提交所选模块的完整内容，未提交模块保留。已有模块不能改 type；新 key 追加模块。条目及子项须有稳定且唯一的 id。预览返回规范化后的实际保存值。发布另在网页操作。" };
}

export function getResumeDraftContext(resumeId: number, page: ContextPageInput) {
  return inTransaction(() => mcpContextPage(capture(resumeId), page));
}

export function createMcpResumeDraft(input: { title: string; source?: { resumeId: number; expectedRevision: string }; idempotencyKey: string }) {
  const { idempotencyKey, ...payload } = input;
  return mcpCreateOnce("create_resume_draft", idempotencyKey, payload, () => {
    if (!input.source) return { id: createResume({ title: input.title }).id };
    assertMcpContext(capture(input.source.resumeId), input.source.expectedRevision);
    const copied = copyResume(input.source.resumeId);
    if (!copied) throw new McpOperationError("NOT_FOUND", "来源简历不存在");
    writeResumeDraftContent(copied.id, { title: input.title, updates: [], at: now() });
    return { id: copied.id };
  }, id => !!getDb().prepare("SELECT 1 FROM resumes WHERE id=?").get(id));
}

type DraftEdit = { resumeId: number; expectedRevision: string; title?: string; modules: McpResumeModule[] };
function prepare(input: DraftEdit) {
  const context = capture(input.resumeId);
  assertMcpContext(context, input.expectedRevision);
  if (new Set(input.modules.map(row => row.key)).size !== input.modules.length) throw new McpOperationError("INVALID_ARGUMENT", "不能重复修改同一模块");
  const before = new Map(context.modules.map(row => [row.key, row]));
  const modules = input.modules.map(raw => {
    const parsed = mcpResumeModuleSchema.safeParse(raw);
    if (!parsed.success || !isValidModuleContentInput(raw.type, raw.content)) throw new McpOperationError("INVALID_ARGUMENT", "模块结构无效或条目 ID 重复");
    const old = before.get(raw.key);
    if (old && old.type !== raw.type) throw new McpOperationError("INVALID_ARGUMENT", "不能改变已有模块的结构类型");
    return { key: raw.key, type: raw.type, label: raw.label, content: normalizeContent(raw.type, raw.content) };
  });
  const labels = new Map(context.modules.map(row => [row.key, row.label.trim()]));
  for (const entry of modules) labels.set(entry.key, entry.label);
  if (new Set(labels.values()).size !== labels.size) throw new McpOperationError("INVALID_ARGUMENT", "模块名称不能重复");
  const title = input.title ?? String(context.resume.title);
  const changes = modules.map(module => ({ key: module.key, before: before.get(module.key) ?? null, after: module }));
  const previewToken = mcpRevision("content-preview", [mcpContextRevision(context), title, modules]);
  return { title, modules, changes, titleBefore: context.resume.title, previewToken, sourceRevision: input.expectedRevision };
}

export function previewResumeDraftEdit(input: DraftEdit, page: ContextPageInput) {
  return inTransaction(() => { const preview = prepare(input); return { ...mcpContextPage(preview, page), previewToken: preview.previewToken }; });
}

export function saveResumeDraftEdit(input: DraftEdit & { previewToken: string; idempotencyKey: string }) {
  const { idempotencyKey, ...payload } = input;
  const previousAvatars: string[] = [];
  const result = mcpCreateOnce("save_resume_draft_edit", idempotencyKey, payload, () => {
    const prepared = prepare(input);
    if (prepared.previewToken !== input.previewToken) throw new McpOperationError("CONFLICT", "保存内容与预览不符，请重新预览");
    const db = getDb(), at = now(), existing = loadResume(input.resumeId)!;
    for (const entry of existing.modules) {
      if (entry.type !== "basic") continue;
      const avatar = avatarUrlFromContent(JSON.stringify(entry.content));
      if (avatar) previousAvatars.push(avatar);
    }
    let nextSort = Math.max(-1, ...existing.modules.map(row => row.sort)) + 1;
    const updates: { key: string; content: string }[] = [];
    for (const entry of prepared.modules) {
      if (existing.modules.some(row => row.key === entry.key)) {
        updates.push({ key: entry.key, content: JSON.stringify(entry.content) });
        db.prepare("UPDATE resume_modules SET label=?,updated_at=? WHERE resume_id=? AND module_key=?").run(entry.label, at, input.resumeId, entry.key);
      } else {
        db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,sort,content,updated_at) VALUES(?,?,?,?,?,?,?)")
          .run(input.resumeId, entry.key, entry.type, entry.label, nextSort++, JSON.stringify(entry.content), at);
      }
    }
    writeResumeDraftContent(input.resumeId, { title: prepared.title, updates, at });
    return { id: input.resumeId };
  }, id => !!getDb().prepare("SELECT 1 FROM resumes WHERE id=?").get(id));
  // 业务写入和幂等回执都提交后再清理；共享草稿及历史版本的引用由存储层复核。
  removeUnreferencedUploadsByUrls(previousAvatars);
  return result;
}
