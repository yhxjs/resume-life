import { getDb, inTransaction } from "./db";
import { INTRO_KINDS, validateGeneratedIntroComments, validateGeneratedIntroVersions, validateIntroSentences, type IntroKind } from "./intro";
import { INTRO_COMMENT_SYSTEM_PROMPT, INTRO_SYSTEM_PROMPT } from "./intro-llm";
import { loadIntroResumeContext } from "./intro-resume-context";
import { createIntroRecord, loadIntroRecord } from "./intro-store";
import { saveIntroVersion } from "./intro-versions";
import { resolveResumeVersionId } from "./resume-versions";
import { assertMcpContext, mcpContextPage, type ContextPageInput } from "./mcp-context";
import { McpOperationError } from "./mcp-errors";
import { mcpCreateOnce } from "./mcp-state";

export type IntroGenerationSource = { mode: "create"; resumeId: number; versionId: number; jd: string }
  | { mode: "regenerate" | "comment"; introId: number; kind: IntroKind };

function capture(source: IntroGenerationSource) {
  if (source.mode === "create") {
    resolveResumeVersionId(source.resumeId, source.versionId);
    return { workflow: "intro" as const, source, kinds: [...INTRO_KINDS], rules: INTRO_SYSTEM_PROMPT,
      untrusted: { jd: source.jd, resumeContext: loadIntroResumeContext(source.resumeId, source.versionId) }, version: null };
  }
  const intro = loadIntroRecord(source.introId);
  const version = intro?.versions.find(row => row.kind === source.kind);
  if (!intro || !version) throw new McpOperationError("NOT_FOUND", "自我介绍版本不存在");
  if (source.mode === "comment" && (version.read_error || "error" in validateIntroSentences(version.sentences))) {
    throw new McpOperationError("INVALID_ARGUMENT", "原稿异常，无法逐句点评");
  }
  return { workflow: "intro" as const, source, kinds: [source.kind],
    rules: source.mode === "comment" ? INTRO_COMMENT_SYSTEM_PROMPT : INTRO_SYSTEM_PROMPT,
    untrusted: { jd: intro.jd, ...(source.mode === "regenerate" ? { resumeContext: loadIntroResumeContext(intro.resume_id, intro.resume_version_id) } : {}),
      sentences: version.sentences },
    resumeId: intro.resume_id, versionId: intro.resume_version_id, version };
}

export function getIntroGenerationContext(source: IntroGenerationSource, page: ContextPageInput) {
  return inTransaction(() => mcpContextPage(capture(source), page));
}

export function saveGeneratedIntro(input: { source: Exclude<IntroGenerationSource, { mode: "comment" }>; expectedRevision: string; result: unknown; idempotencyKey: string }) {
  if (input.source.mode === "comment") throw new McpOperationError("INVALID_ARGUMENT", "点评请使用 save_intro_comments");
  const { idempotencyKey, ...payload } = input;
  return mcpCreateOnce("save_generated_intro", idempotencyKey, payload, () => {
    const context = capture(input.source);
    assertMcpContext(context, input.expectedRevision);
    const versions = validateGeneratedIntroVersions(input.result, context.kinds);
    if (!versions) throw new McpOperationError("INVALID_ARGUMENT", "介绍版本、句子或点评不完整，或内容超限");
    if (input.source.mode === "create") {
      return { id: createIntroRecord({ ...input.source, resumeContext: context.untrusted.resumeContext!, versions }) };
    }
    const source = input.source;
    const result = saveIntroVersion(source.introId, source.kind, context.version!.revision, versions[0]!.sentences, { jd: context.untrusted.jd });
    if (result.status !== 200) throw new McpOperationError(result.status === 404 ? "NOT_FOUND" : "CONFLICT", "原稿已变化，请重新读取");
    return { id: source.introId };
  }, id => !!getDb().prepare("SELECT 1 FROM intros WHERE id=?").get(id));
}

export function saveIntroComments(input: { introId: number; kind: IntroKind; expectedRevision: string; comments: string[]; idempotencyKey: string }) {
  const { idempotencyKey, ...payload } = input;
  return mcpCreateOnce("save_intro_comments", idempotencyKey, payload, () => {
    const context = capture({ mode: "comment", introId: input.introId, kind: input.kind });
    assertMcpContext(context, input.expectedRevision);
    const sentences = context.version!.sentences;
    const comments = validateGeneratedIntroComments({ comments: input.comments }, sentences.length);
    if (!comments) throw new McpOperationError("INVALID_ARGUMENT", "点评须与原句一一对应、非空且不超限");
    const result = saveIntroVersion(input.introId, input.kind, context.version!.revision,
      sentences.map((sentence, index) => ({ text: sentence.text, comment: comments[index]! })), { jd: context.untrusted.jd });
    if (result.status !== 200) throw new McpOperationError(result.status === 404 ? "NOT_FOUND" : "CONFLICT", "原稿已变化，请重新读取");
    return { id: input.introId };
  }, id => !!getDb().prepare("SELECT 1 FROM intro_versions WHERE intro_id=? AND kind=?").get(id, input.kind));
}
