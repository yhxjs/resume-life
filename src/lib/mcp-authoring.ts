import { getDb, inTransaction } from "./db";
import { type IntroKind, validateIntroSentences } from "./intro";
import { loadIntroRecord } from "./intro-store";
import { saveIntroVersion } from "./intro-versions";
import { McpOperationError } from "./mcp-errors";
import { mcpRevision } from "./mcp-revision";
import { mcpCreateOnce } from "./mcp-state";
import { createProjectRecord, loadProjectRow } from "./projects";
import { createProjectMaterial } from "./project-materials";
import { fitPage, pageParams, type PageInput } from "./mcp-read";
import { mcpProjectRevision } from "./mcp-project-revision";

type IntroEdit = { introId: number; kind: IntroKind; expectedRevision: string; texts: string[] };

function prepareIntroEdit(input: IntroEdit) {
  const previous = loadIntroRecord(input.introId)?.versions.find(version => version.kind === input.kind);
  if (!previous) throw new McpOperationError("NOT_FOUND", "自我介绍版本不存在");
  if (previous.revision !== input.expectedRevision) throw new McpOperationError("CONFLICT", "版本已变更，请重新预览");
  if (previous.read_error) throw new McpOperationError("INVALID_ARGUMENT", "历史原稿异常，不能编辑");
  // Identical sentences retain their comments in occurrence order, including moves.
  // Consume each occurrence once so inserting a duplicate cannot copy its feedback.
  const comments = new Map<string, string[]>();
  for (const sentence of previous.sentences) {
    const matches = comments.get(sentence.text) ?? [];
    matches.push(sentence.comment);
    comments.set(sentence.text, matches);
  }
  const checked = validateIntroSentences(input.texts.map(text => ({ text, comment: comments.get(text)?.shift() ?? "" })));
  if ("error" in checked) throw new McpOperationError("INVALID_ARGUMENT", checked.error);
  const changes = Array.from({ length: Math.max(previous.sentences.length, checked.sentences.length) }, (_, i) => ({
    line: i + 1, before: previous.sentences[i]?.text ?? null, after: checked.sentences[i]?.text ?? null,
  })).filter(change => change.before !== change.after);
  const previewToken = mcpRevision("intro-preview", [input.introId, input.kind, previous.revision, checked.sentences]);
  return { sentences: checked.sentences, preview: { id: input.introId, kind: input.kind, revision: previous.revision, previewToken, changes } };
}

export function previewIntroEdit(input: IntroEdit & PageInput) {
  const { limit, idCursor } = pageParams(input);
  const { changes, ...preview } = inTransaction(() => prepareIntroEdit(input).preview);
  const remaining = changes.filter(change => change.line > (idCursor ?? 0));
  const page = fitPage(remaining.slice(0, limit), remaining.length > limit ? String(remaining[limit - 1]!.line) : null, change => String(change.line));
  return { ...preview, changeCount: changes.length, changes: page.items, nextCursor: page.nextCursor };
}
export function saveIntroEdit(input: IntroEdit & { previewToken: string; idempotencyKey: string }) {
  const { idempotencyKey, ...payload } = input;
  return mcpCreateOnce("save_intro_edit", idempotencyKey, payload, () => {
    const { sentences, preview } = prepareIntroEdit(input);
    if (preview.previewToken !== input.previewToken) throw new McpOperationError("CONFLICT", "提交内容与预览不符，请重新确认");
    if (preview.changes.length) {
      const result = saveIntroVersion(input.introId, input.kind, input.expectedRevision, sentences);
      if (result.status !== 200) throw new McpOperationError(result.status === 404 ? "NOT_FOUND" : result.status === 409 ? "CONFLICT" : "INVALID_ARGUMENT", "无法保存此版原稿");
    }
    return { id: input.introId };
  }, id => !!getDb().prepare("SELECT 1 FROM intro_versions WHERE intro_id=? AND kind=?").get(id, input.kind));
}

export function createMcpProject(input: { name: string; idempotencyKey: string }) {
  return mcpCreateOnce("create_project", input.idempotencyKey, { name: input.name }, () => ({ id: createProjectRecord(input.name) }), id => !!loadProjectRow(id));
}

export function addMcpProjectMaterial(input: { projectId: number; title: string; content: string; expectedRevision: string; idempotencyKey: string }) {
  const { idempotencyKey, ...payload } = input;
  return mcpCreateOnce("add_project_material", idempotencyKey, payload, () => {
    const project = loadProjectRow(input.projectId);
    if (!project) throw new McpOperationError("NOT_FOUND", "项目不存在");
    if (mcpProjectRevision(project) !== input.expectedRevision) throw new McpOperationError("CONFLICT", "项目或材料已变更，请重新读取");
    const id = createProjectMaterial(input.projectId, { title: input.title, content: input.content, source: "paste", filename: "" });
    if (id === null) throw new McpOperationError("NOT_FOUND", "项目不存在");
    return { id };
  }, id => !!getDb().prepare("SELECT 1 FROM project_materials WHERE id=? AND project_id=?").get(id, input.projectId));
}
