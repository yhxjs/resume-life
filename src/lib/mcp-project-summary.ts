import { getDb, inTransaction } from "./db";
import { assertMcpContext, mcpContextPage, mcpContextRevision, type ContextPageInput } from "./mcp-context";
import { McpOperationError } from "./mcp-errors";
import { mcpRevision } from "./mcp-revision";
import { mcpCreateOnce } from "./mcp-state";
import { adoptSummaryChanges, type SummaryUnitKey } from "./project-summary-diff";
import { captureProjectSummaryInput, listProjectSummaryHistory, prepareProjectSummaryProposal, saveProjectSummary } from "./project-summary-history";
import { PROJECT_RESUME_SYSTEM_PROMPT, PROJECT_SUMMARY_SYSTEM_PROMPT } from "./project-summary-llm";
import { hasProjectSummaryContent, isEmptyGeneratedProjectSummary, isGeneratedProjectSummary, normalizeSummary, parseSummary, validateGeneratedProjectResume } from "./summary";
import { fitPage, pageParams, type PageInput } from "./mcp-read";

export type ProjectSummarySource = { projectId: number; mode: "full" | "resume-only" };
type ProposalInput = ProjectSummarySource & { expectedRevision: string; result: unknown; acceptedKeys?: string[] };

function capture(source: ProjectSummarySource) {
  // External models may read more than a single Web model request; never silently trim materials.
  const input = captureProjectSummaryInput(source.projectId, Number.MAX_SAFE_INTEGER);
  const archive = parseSummary(input.project.summary);
  if (!input.materialText.trim() && !hasProjectSummaryContent(archive)) throw new McpOperationError("INVALID_ARGUMENT", "请先补充项目材料或档案");
  return { input, context: { workflow: "project-summary", source, revisionId: input.revisionId, materials: input.materials,
    rules: source.mode === "full" ? PROJECT_SUMMARY_SYSTEM_PROMPT : PROJECT_RESUME_SYSTEM_PROMPT,
    untrusted: { projectName: input.project.name, archive, materialText: input.materialText } } };
}

export function getProjectSummaryContext(source: ProjectSummarySource, page: ContextPageInput) {
  return inTransaction(() => mcpContextPage(capture(source).context, page));
}

function proposal(input: ProposalInput) {
  const source = { projectId: input.projectId, mode: input.mode };
  const { context, input: captured } = capture(source);
  assertMcpContext(context, input.expectedRevision);
  const generated = input.mode === "full" ?
    isGeneratedProjectSummary(input.result) && !isEmptyGeneratedProjectSummary(input.result) ? normalizeSummary(input.result) : null :
    (() => { const resume = validateGeneratedProjectResume(input.result); return resume ? { ...context.untrusted.archive, ...resume } : null; })();
  if (!generated) throw new McpOperationError("INVALID_ARGUMENT", "项目总结结构无效、为空或超出字段上限");
  const preview = prepareProjectSummaryProposal(input.projectId, generated, captured.materials, captured.revisionId, captured.project.name);
  const changed = new Set(preview.comparison.map(change => change.key));
  const acceptedKeys = input.acceptedKeys ?? [...changed];
  if (new Set(acceptedKeys).size !== acceptedKeys.length || acceptedKeys.some(key => !changed.has(key as SummaryUnitKey))) {
    throw new McpOperationError("INVALID_ARGUMENT", "采纳字段必须是预览中的不同变更字段");
  }
  const summary = adoptSummaryChanges(context.untrusted.archive, generated, {}, acceptedKeys as SummaryUnitKey[]).summary;
  const previewToken = mcpRevision("content-preview", [source, mcpContextRevision(context), generated, acceptedKeys, summary]);
  return { ...preview, acceptedKeys: acceptedKeys as SummaryUnitKey[], savedSummary: summary, previewToken, sourceRevision: input.expectedRevision };
}

export function previewProjectSummary(input: ProposalInput, page: ContextPageInput) {
  return inTransaction(() => {
    const preview = proposal(input);
    return { ...mcpContextPage(preview, page), previewToken: preview.previewToken };
  });
}

export function saveMcpProjectSummary(input: ProposalInput & { previewToken: string; idempotencyKey: string }) {
  const { idempotencyKey, ...payload } = input;
  return mcpCreateOnce("save_project_summary", idempotencyKey, payload, () => {
    const preview = proposal(input);
    if (input.previewToken !== preview.previewToken) throw new McpOperationError("CONFLICT", "提案或采纳字段与预览不符，请重新预览");
    const saved = saveProjectSummary(input.projectId, { summary: preview.savedSummary, expectedRevisionId: preview.revisionId,
      proposal: { generated: preview.summary, acceptedKeys: preview.acceptedKeys, source: "ai", materialFingerprint: preview.materialFingerprint } });
    return { id: saved.id };
  }, id => !!getDb().prepare("SELECT 1 FROM project_summary_history WHERE id=? AND project_id=?").get(id, input.projectId));
}

export function listMcpProjectSummaryHistory(projectId: number, input: PageInput) {
  const { limit, idCursor } = pageParams(input);
  const result = listProjectSummaryHistory(projectId, idCursor, limit);
  const items = result.items.map(row => ({ id: row.id, source: row.source, createdAt: row.createdAt,
    fullContent: { tool: "read_record_section", kind: "project_summary_history", id: row.id } }));
  return fitPage(items, result.nextCursor, row => String(row.id));
}
