import { getDb, inTransaction } from "./db";
import { loadResume } from "./resumes";
import { captureResumeDraft } from "./mcp-resume-draft";
import { getResumeVersion, listResumeVersions, publishResumeVersion, branchResumeVersion } from "./resume-versions";
import { assertMcpContext, mcpContextPage, mcpContextRevision, type ContextPageInput } from "./mcp-context";
import { mcpCreateOnce } from "./mcp-state";
import { mcpRevision } from "./mcp-revision";
import { McpOperationError } from "./mcp-errors";
import type { ModuleData } from "./modules";

function selectedVersion(resumeId: number, versionId: number) {
  const version = getResumeVersion(resumeId, versionId);
  if (!version) throw new McpOperationError("NOT_FOUND", "所选版本不存在或不属于该简历");
  return version;
}
function capture(resumeId: number, versionId?: number) {
  return { workflow: "resume-version", draft: captureResumeDraft(resumeId), versions: listResumeVersions(resumeId),
    selectedVersion: versionId === undefined ? null : selectedVersion(resumeId, versionId),
    instructions: "发布会冻结正文和排版；branch 会将选定版本写入当前草稿，需先预览差异。所有写操作使用本上下文 revision。历史版本和已投递快照不随草稿改变。" };
}
export function getResumeVersionContext(resumeId: number, versionId: number | undefined, page: ContextPageInput) {
  return inTransaction(() => mcpContextPage(capture(resumeId, versionId), page));
}
function differences(before: NonNullable<ReturnType<typeof loadResume>>, after: NonNullable<ReturnType<typeof loadResume>>) {
  const contentOf = (entry: ModuleData | null) => entry === null ? null :
    { key: entry.key, type: entry.type, label: entry.label, sort: entry.sort, content: entry.content };
  const keys = new Set([...before.modules, ...after.modules].map(module => module.key));
  return { title: { before: before.resume.title, after: after.resume.title },
    layout: { before: { template: before.resume.template, overrides: before.resume.style_overrides, resolved: before.resume.resolved_style },
      after: { template: after.resume.template, overrides: after.resume.style_overrides, resolved: after.resume.resolved_style } },
    modules: [...keys].flatMap(key => {
      const left = contentOf(before.modules.find(module => module.key === key) ?? null), right = contentOf(after.modules.find(module => module.key === key) ?? null);
      return JSON.stringify(left) === JSON.stringify(right) ? [] : [{ key, before: left, after: right }];
    }) };
}
export function compareResumeVersions(input: { resumeId: number; beforeVersionId?: number; afterVersionId?: number }, page: ContextPageInput) {
  return inTransaction(() => {
    if (input.beforeVersionId !== undefined) selectedVersion(input.resumeId, input.beforeVersionId);
    if (input.afterVersionId !== undefined) selectedVersion(input.resumeId, input.afterVersionId);
    const before = loadResume(input.resumeId, input.beforeVersionId), after = loadResume(input.resumeId, input.afterVersionId);
    if (!before || !after) throw new McpOperationError("NOT_FOUND", "简历不存在");
    return mcpContextPage({ ...input, before, after, changes: differences(before, after) }, page);
  });
}
export function publishMcpResumeVersion(input: { resumeId: number; expectedRevision: string; name: string; description?: string; idempotencyKey: string }) {
  const { idempotencyKey, ...payload } = input;
  return mcpCreateOnce("publish_resume_version", idempotencyKey, payload, () => {
    const context = capture(input.resumeId); assertMcpContext(context, input.expectedRevision);
    return { id: publishResumeVersion(input.resumeId, { name: input.name, description: input.description, draft_revision: context.versions.draft_revision }).id };
  }, id => !!getDb().prepare("SELECT 1 FROM resume_versions WHERE id=? AND resume_id=?").get(id, input.resumeId));
}
type Branch = { resumeId: number; versionId: number; expectedRevision: string };
function prepareBranch(input: Branch) {
  const context = capture(input.resumeId, input.versionId); assertMcpContext(context, input.expectedRevision);
  const changes = differences(loadResume(input.resumeId)!, loadResume(input.resumeId, input.versionId)!);
  return { changes, selectedVersion: context.selectedVersion, previewToken: mcpRevision("content-preview", ["resume-version-branch", mcpContextRevision(context), changes]) };
}
export function previewResumeVersionBranch(input: Branch, page: ContextPageInput) {
  return inTransaction(() => { const result = prepareBranch(input); return { ...mcpContextPage(result, page), previewToken: result.previewToken }; });
}
export function branchMcpResumeVersion(input: Branch & { previewToken: string; idempotencyKey: string }) {
  const { idempotencyKey, ...payload } = input;
  return mcpCreateOnce("branch_resume_version", idempotencyKey, payload, () => {
    const prepared = prepareBranch(input);
    if (prepared.previewToken !== input.previewToken) throw new McpOperationError("CONFLICT", "版本分支预览已变化");
    branchResumeVersion(input.resumeId, input.versionId, loadResume(input.resumeId)!.resume.draftRevision);
    return { id: input.resumeId };
  }, id => !!getDb().prepare("SELECT 1 FROM resumes WHERE id=?").get(id));
}
