import * as z from "zod/v4";
import { getDb, inTransaction } from "./db";
import { mcpWorkspaceBinding } from "./mcp-runtime";
import { mcpCachePolicy } from "./mcp-cache";
import { mcpCreateWithResult, mcpCreateOnce, readMcpOperationResult } from "./mcp-state";
import { mcpRevision } from "./mcp-revision";
import { mcpContextPage, mcpContextRevision, type ContextPageInput } from "./mcp-context";
import { captureResumeDraft, previewResumeDraftEdit } from "./mcp-resume-draft";
import { mcpResumeModuleSchema, type McpResumeModule } from "./mcp-resume-contract";
import { isValidModuleContentInput, normalizeContent } from "./modules";
import { getApplicationById } from "./applications";
import { updateMcpApplication } from "./mcp-write";
import { McpOperationError, classifyMcpError } from "./mcp-errors";
import { threeWayMerge, sameJson, type Json, type MergeChoice } from "./mcp-rebase-merge";
import { applicationEditInputSchema, type ApplicationEditInput, type ApplicationRebaseInput, type ResumeRebaseInput } from "./mcp-rebase-types";

type Snapshot = { id: number; binding: string; sourceRevision: string; original: Json };
const invalid = (message: string): never => { throw new McpOperationError("INVALID_ARGUMENT", message); };
const conflict = (message: string): never => { throw new McpOperationError("CONFLICT", message); };
const asJson = (v: unknown): Json => JSON.parse(JSON.stringify(v));

// Server-retained originals cannot be forged by supplying an edited base plus its public revision hash.
// These are runtime cache results: existing TTL/quota/restore cleanup applies; no business tables or snapshots change.
function captureBase(kind: string, id: number, sourceRevision: string, original: Json) {
  const binding = mcpWorkspaceBinding();
  // Rotate capture keys at TTL boundaries so an expired original can be captured afresh even if the record is unchanged.
  // A boundary crossed mid-pagination yields the normal context CONFLICT and requires a fresh first page.
  const epoch = Math.floor(Date.now() / (mcpCachePolicy().ttlHours * 3_600_000));
  const baseToken = mcpRevision("content-context", ["rebase-base-v1", binding, kind, id, sourceRevision, epoch]);
  const snapshot = mcpCreateWithResult(`rebase-base:${kind}`, baseToken, { id, sourceRevision, binding },
    () => ({ id, sourceRevision, binding, original }), () => true);
  return { mode: "capture", baseToken, ...snapshot };
}
function base(kind: string, id: number, token: string): Snapshot {
  const snapshot = readMcpOperationResult(`rebase-base:${kind}`, token) as Snapshot;
  if (snapshot.id !== id || snapshot.binding !== mcpWorkspaceBinding()) conflict("base 来源或工作区/恢复世代不匹配，请重新读取并捕获 base");
  return snapshot;
}
function merge(b: Json, p: Json, c: Json, choices: MergeChoice[], atomic: string[][] = []) {
  try { return threeWayMerge(b, p, c, choices, atomic); }
  catch (error) { return invalid(error instanceof Error ? error.message : "三方比较参数无效"); }
}
function checkCurrent(expected: string | undefined, actual: string, choices: MergeChoice[]) {
  if (expected && expected !== actual) conflict("比较后来源再次变化，请重读并重新比较");
  if (choices.length && !expected) invalid("选择冲突时必须带上比较返回的 currentRevision");
}
function draftView(context: ReturnType<typeof captureResumeDraft>) {
  return asJson({ title: context.resume.title, modules: context.modules.map(row => ({ key: row.key, type: row.type, label: row.label, content: row.content })),
    metadata: { template: context.resume.template, style_overrides: context.resume.style_overrides, base_version_id: context.resume.base_version_id,
      moduleOrder: context.modules.map(row => ({ key: row.key, sort: row.sort })), templateDefinition: context.template } });
}
type DraftView = { title: string; modules: McpResumeModule[]; metadata: Json };
// Retain all unknown fields for comparison. Strict save validation below reports rather than strips them.
function draft(value: unknown): DraftView {
  z.object({ title: z.string(), modules: z.array(z.object({ key: z.string(), type: z.string(), label: z.string(), content: z.json() })), metadata: z.json() }).parse(value);
  return value as DraftView;
}
function preservesProvided(value: Json, normalized: Json): boolean {
  if (Array.isArray(value)) return Array.isArray(normalized) && value.length === normalized.length && value.every((v, i) => preservesProvided(v, normalized[i]!));
  if (value !== null && typeof value === "object") return normalized !== null && typeof normalized === "object" && !Array.isArray(normalized)
    && Object.entries(value).every(([k, v]) => Object.hasOwn(normalized, k) && preservesProvided(v, normalized[k]!));
  return sameJson(value, normalized);
}
function previewBlocker(action: () => unknown): string[] {
  try { action(); return []; }
  catch (error) {
    const classified = classifyMcpError(error);
    if (!["INVALID_ARGUMENT", "NOT_FOUND", "CONFLICT"].includes(classified.code)) throw error;
    return [classified.message];
  }
}

export function previewResumeDraftRebase(input: ResumeRebaseInput) {
  return inTransaction(() => {
    const currentContext = captureResumeDraft(input.resumeId), currentRevision = mcpContextRevision(currentContext), current = draftView(currentContext);
    if (input.mode === "capture") {
      if (input.expectedRevision !== currentRevision) conflict("草稿已变化，请重新读取后捕获 base");
      return mcpContextPage(captureBase("resume", input.resumeId, currentRevision, current), input.page ?? {});
    }
    if (!input.baseToken || !input.proposed) return invalid("rebase 需要 baseToken 和 proposed");
    const proposedInput = input.proposed;
    const snapshot = base("resume", input.resumeId, input.baseToken), original = draft(snapshot.original);
    checkCurrent(input.expectedRevision, currentRevision, input.choices);
    if (new Set(proposedInput.modules.map(m => m.key)).size !== proposedInput.modules.length) invalid("模块 key 重复");
    for (const row of proposedInput.modules) if (!isValidModuleContentInput(row.type, row.content)) invalid("模块结构或稳定 ID 无效");
    const byKey = new Map(proposedInput.modules.map(row => [row.key, row]));
    const proposed = asJson({ ...original, ...proposedInput, modules: [
      ...original.modules.map(row => byKey.get(row.key) ?? row), ...proposedInput.modules.filter(row => !original.modules.some(old => old.key === row.key)),
    ] });
    // Metadata is outside the existing save contract. Acknowledge current metadata explicitly; never silently overwrite it.
    const metadataChanged = !sameJson(original.metadata, draft(current).metadata);
    const metaChoice = input.choices.filter(c => c.path.length === 1 && c.path[0] === "metadata");
    if (input.choices.some(c => c.path[0] === "metadata" && c.path.length !== 1)) invalid("元数据选择路径无效");
    if (metaChoice.length > 1 || (metaChoice.length && (!metadataChanged || metaChoice[0]!.take !== "current"))) invalid("元数据只允许选择 current；修改模板/排序请使用相应工具并重读");
    const choices = input.choices.filter(c => c.path[0] !== "metadata");
    const safe = merge(snapshot.original, proposed, current, []);
    const result = merge(snapshot.original, proposed, current, choices);
    if (metadataChanged) result.conflicts.push({ path: ["metadata"], reason: "metadata-changed-use-current", base: { present: true, value: original.metadata }, proposed: { present: true, value: original.metadata },
      current: { present: true, value: draft(current).metadata }, resolution: metaChoice[0]?.take ?? null });
    const toProposal = (value: Json) => {
      const v = draft(value), c = draft(current);
      return { resumeId: input.resumeId, expectedRevision: currentRevision, title: v.title,
        modules: v.modules.filter(row => !sameJson(asJson(row), asJson(c.modules.find(old => old.key === row.key) ?? null))) };
    };
    const safeProposal = toProposal(safe.value), proposal = toProposal(result.value);
    const sourceBlockers: string[] = [];
    for (const row of proposedInput.modules) {
      const sources = [original.modules.find(m => m.key === row.key), draft(current).modules.find(m => m.key === row.key)].filter(m => m !== undefined);
      if (sources.some(m => !mcpResumeModuleSchema.safeParse(m).success)) sourceBlockers.push(`模块 ${row.key} 的来源含当前保存契约未支持的字段；不能用不完整提案覆盖`);
    }
    function issues(value: Json, edit: ReturnType<typeof toProposal>) {
      const blockers = [...sourceBlockers];
      // Existing preview/save cannot remove modules or change type. Do not pretend those choices were applied.
      const merged = draft(value);
      if (draft(current).modules.some(row => !merged.modules.some(m => m.key === row.key))) blockers.push("现有保存工具不支持删除模块；请在网页处理并重新读取");
      for (const row of edit.modules) {
        if (!mcpResumeModuleSchema.safeParse(row).success) blockers.push(`模块 ${row.key} 含无法保存的字段；请核对，不会静默丢弃`);
        else if (!preservesProvided(asJson(row.content), asJson(normalizeContent(row.type, row.content)))) blockers.push(`模块 ${row.key} 的合并字段会被规范化改写；请核对 description/descriptionItems、排序或头像参数后重新提交 proposed`);
      }
      if (!blockers.length) blockers.push(...previewBlocker(() => previewResumeDraftEdit(edit, {})));
      return blockers;
    }
    const blockers = issues(result.value, proposal), safeBlockers = issues(safe.value, safeProposal);
    const unresolved = result.conflicts.filter(c => !c.resolution).length;
    return mcpContextPage({ mode: "rebase", baseToken: input.baseToken, baseRevision: snapshot.sourceRevision, currentRevision,
      original: snapshot.original, proposed, current, conflicts: result.conflicts, unresolved, blockers, safeBlockers, safeProposal: safeBlockers.length ? null : safeProposal,
      prepared: !unresolved && !blockers.length ? { tool: "preview_resume_draft_edit", arguments: proposal } : null,
      next: "safeProposal 在冲突处保留 current，仅供审阅；选择冲突并重新比较后，调用 prepared 的预览工具，读全预览后再调用 save_resume_draft_edit。" }, input.page ?? {});
  });
}

function application(id: number) {
  const app = getApplicationById(id);
  if (!app) throw new McpOperationError("NOT_FOUND", "投递不存在");
  return app;
}
function applicationView(app: ReturnType<typeof application>) {
  return asJson({ notes: app.notes, jd: app.jd,
    lifecycle: { stage: app.stage, terminal_stage: app.terminal_stage, terminal_reason: app.terminal_reason },
    resume: { resume_id: app.resume_id, resume_version_id: app.resume_version_id } });
}
const atomic = [["lifecycle"], ["resume"]];
function applicationProposal(value: Json, current: Json) {
  const v = value as Record<string, Json>, c = current as Record<string, Json>, fields: Record<string, Json> = {};
  for (const name of ["notes", "jd"]) if (!sameJson(v[name], c[name])) fields[name] = v[name]!;
  for (const name of ["lifecycle", "resume"]) if (!sameJson(v[name], c[name])) {
    const group = v[name] as Record<string, Json>, old = c[name] as Record<string, Json>;
    for (const [k, val] of Object.entries(group)) if (!sameJson(val, old[k])) fields[k] = val;
  }
  // Leaving rejected clears attribution in the domain layer, not by writing invalid null/empty fields.
  if (fields.stage && fields.stage !== "rejected") { delete fields.terminal_stage; delete fields.terminal_reason; }
  return fields;
}
export function previewApplicationRebase(input: ApplicationRebaseInput) {
  return inTransaction(() => {
    const app = application(input.applicationId), currentRevision = mcpRevision("application", app), current = applicationView(app);
    if (input.mode === "capture") {
      if (input.expectedRevision !== currentRevision) conflict("投递已变化，请重新读取后捕获 base");
      return mcpContextPage(captureBase("application", input.applicationId, currentRevision, current), input.page ?? {});
    }
    if (!input.baseToken || !input.proposed) return invalid("rebase 需要 baseToken 和 proposed");
    const snapshot = base("application", input.applicationId, input.baseToken);
    checkCurrent(input.expectedRevision, currentRevision, input.choices);
    const proposed = structuredClone(snapshot.original) as Record<string, Json>;
    for (const [k, val] of Object.entries(input.proposed)) {
      if (["stage", "terminal_stage", "terminal_reason"].includes(k)) (proposed.lifecycle as Record<string, Json>)[k] = val;
      else if (["resume_id", "resume_version_id"].includes(k)) (proposed.resume as Record<string, Json>)[k] = val;
      else proposed[k] = val;
    }
    const resume = proposed.resume as Record<string, Json>;
    if (input.proposed.resume_id != null && input.proposed.resume_version_id == null ||
        input.proposed.resume_version_id === null && resume.resume_id !== null) invalid("重新绑定简历时必须明确提供发布版本 ID，避免隐式选版");
    const lifecycle = proposed.lifecycle as Record<string, Json>;
    if (lifecycle.stage !== "rejected" && (input.proposed.terminal_stage !== undefined || input.proposed.terminal_reason !== undefined)) invalid("非终止阶段不能提交终止信息");
    if (lifecycle.stage !== "rejected") { lifecycle.terminal_stage = null; lifecycle.terminal_reason = ""; }
    if (input.proposed.resume_id === null) {
      if (input.proposed.resume_version_id != null) invalid("清除简历绑定时不能提供发布版本");
      resume.resume_version_id = null;
    }
    const result = merge(snapshot.original, proposed, current, input.choices, atomic), safe = merge(snapshot.original, proposed, current, [], atomic);
    const proposal = { applicationId: input.applicationId, expectedRevision: currentRevision, fields: applicationProposal(result.value, current) };
    const noChanges = !Object.keys(proposal.fields).length;
    function issues(edit: typeof proposal): string[] {
      if (!Object.keys(edit.fields).length) return [];
      const parsed = applicationEditInputSchema.safeParse(edit);
      if (!parsed.success) return ["合并结果不符合投递字段契约，请核对关联简历或终止信息"];
      return previewBlocker(() => prepareApplicationEdit(parsed.data));
    }
    const safeProposal = { ...proposal, fields: applicationProposal(safe.value, current) };
    const blockers = issues(proposal), safeBlockers = issues(safeProposal);
    return mcpContextPage({ mode: "rebase", baseToken: input.baseToken, baseRevision: snapshot.sourceRevision, currentRevision,
      original: snapshot.original, proposed, current, conflicts: result.conflicts, unresolved: result.unresolved, blockers, safeBlockers, noChanges,
      safeProposal: safeBlockers.length ? null : safeProposal,
      prepared: !result.unresolved && !blockers.length && !noChanges ? { tool: "preview_application_edit", arguments: proposal } : null,
      next: "选择冲突后以 currentRevision 重新比较；随后调用 preview_application_edit，读全预览后使用 save_application_edit 和新的幂等键。" }, input.page ?? {});
  });
}

function prepareApplicationEdit(input: ApplicationEditInput) {
  const before = application(input.applicationId);
  if (mcpRevision("application", before) !== input.expectedRevision) conflict("投递在比较后已变化，请重新读取并比较");
  const db = getDb();
  // Exercise the same domain validation and normalization, rolling back every table including lifecycle/snapshot writes.
  db.exec("SAVEPOINT mcp_rebase_preview");
  let after: Json;
  try { updateMcpApplication(input.applicationId, { expectedRevision: input.expectedRevision, ...input.fields }, false); after = applicationView(application(input.applicationId)); }
  finally { db.exec("ROLLBACK TO mcp_rebase_preview"); db.exec("RELEASE mcp_rebase_preview"); }
  const previewToken = mcpRevision("content-preview", ["application-edit-v1", mcpWorkspaceBinding(), input, after]);
  return { before: applicationView(before), after, input, previewToken };
}
export function previewApplicationEdit(input: ApplicationEditInput, page: ContextPageInput = {}) {
  return inTransaction(() => { const prepared = prepareApplicationEdit(input); return { ...mcpContextPage(prepared, page), previewToken: prepared.previewToken }; });
}
export function saveApplicationEdit(input: ApplicationEditInput & { previewToken: string; idempotencyKey: string }) {
  const { idempotencyKey, previewToken, ...edit } = input;
  return mcpCreateOnce("save_application_edit", idempotencyKey, { ...edit, previewToken }, () => {
    if (prepareApplicationEdit(edit).previewToken !== previewToken) conflict("提交内容与预览不符，请重新预览");
    updateMcpApplication(edit.applicationId, { expectedRevision: edit.expectedRevision, ...edit.fields }, false);
    return { id: edit.applicationId };
  }, id => !!getDb().prepare("SELECT 1 FROM applications WHERE id=?").get(id));
}
