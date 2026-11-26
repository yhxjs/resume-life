import { createHash, randomUUID } from "node:crypto";
import { bindInputs, createReceipt, readContext, recoverReceipt, uploadBytes, waitForJob } from "./helpers.mjs";
import { toolAccess } from "../../src/mcp/config.mjs";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const failure = (code, message) => Object.assign(new Error(message), { code, retryable: false });

// Explicit receipt contracts: adding a write capability alone must not enable automatic replay.
// The discovery integration test checks these against the server's actual input schemas.
export const WORKFLOW_WRITE_TOOLS = Object.freeze([
  "begin_mcp_upload", "extract_uploaded_file", "submit_file_import", "save_file_import",
  "create_resume_template", "save_resume_template", "set_resume_avatar",
  "create_application", "create_preparation_task", "schedule_application_interview", "submit_ai_draft",
  "submit_review", "bookmark_practice_question", "save_notebook_note", "save_generated_practice",
  "create_practice_session", "submit_practice_answer", "save_intro_edit", "create_project", "add_project_material",
  "start_mock_interview", "answer_mock_interview", "finish_mock_interview", "save_interview_series_result",
  "answer_series_interview", "finish_series_interview", "save_generated_intro", "save_intro_comments",
  "save_project_summary", "save_interview_training_result", "create_resume_draft", "save_resume_draft_edit",
  "save_resume_layout", "save_diagnosis_adoption", "publish_resume_version", "branch_resume_version", "export_resume",
  "save_bank_import", "create_notebook_category", "rename_notebook_category", "move_notebook_entry",
  "save_repository_evidence_update", "save_project_material_edit", "capture_project_repository", "save_repository_evidence",
  "save_jargon_result", "export_portfolio", "save_career_result", "save_application_edit",
]);

/**
 * Serializable, caller-reviewed plan. External model outputs enter as variables; the runner never invokes a model.
 * Persist requests before sending and results before advancing. Re-running uses the same plan and initial variables.
 * Writes that lack a server receipt are rejected; their outcome cannot safely be guessed after process death.
 * @param {(name: string, args?: object) => Promise<unknown>} call
 * @param {{id: string, variables?: object, steps: Array<{id: string, kind: string, tool?: string, arguments?: object}>}} plan
 * @param {{store: ReturnType<typeof import('./workflow-store.mjs').openWorkflowStore>, signal?: AbortSignal, reconnect?: () => Promise<void>, onCheckpoint?: (journal: {steps: Record<string, {status: string}>}) => Promise<void> | void, pollMs?: number}} options
 */
export async function runWorkflow(call, plan, { store, signal, reconnect, onCheckpoint, pollMs = 200 } = {}) {
  if (!store || !/^[A-Za-z0-9._:-]{8,128}$/.test(plan.id ?? "") || !Array.isArray(plan.steps) || !plan.steps.length || plan.steps.length > 100) throw new Error("工作流计划无效");
  const frozen = JSON.parse(JSON.stringify(plan));
  const ids = new Set();
  for (const step of frozen.steps) {
    if (!/^[A-Za-z_]\w{0,63}$/.test(step.id ?? "") || ["__proto__", "prototype", "constructor"].includes(step.id) || ids.has(step.id)) throw new Error("步骤 ID 无效或重复");
    ids.add(step.id);
    if (!["read", "context", "preview", "write", "job", "upload"].includes(step.kind)) throw new Error("步骤类型无效");
    if (["read", "context", "preview"].includes(step.kind) && toolAccess[step.tool] !== "read") throw new Error("读取步骤只能使用只读工具");
    if (step.kind === "write" && toolAccess[step.tool] !== "write") throw new Error("写入步骤只能使用业务写工具");
    if (step.kind === "write" && !WORKFLOW_WRITE_TOOLS.includes(step.tool)) throw failure("INVALID_ARGUMENT", "写入步骤需要支持原请求回执的工具；后台任务和上传请使用 job/upload 步骤");
    if (step.kind === "job" && !["export_resume", "export_portfolio", "capture_project_repository", "extract_uploaded_file"].includes(step.tool)) throw new Error("不支持的后台操作");
  }
  const fingerprint = hash(frozen), ownership = store.acquire(frozen.id);
  let journal, acceptedJournal = false;
  try {
    const status = await call("get_mcp_status");
    if (!/^[a-f0-9]{64}$/.test(status.workspaceBinding ?? "")) throw failure("CONFIGURATION", "服务器缺少工作流恢复绑定，请升级 MCP");
    journal = ownership.load();
    if (journal && (journal.fingerprint !== fingerprint || journal.binding !== status.workspaceBinding)) throw failure("CONFLICT", "流程参数或数据库恢复世代已变化；保留原记录，核对后建立新流程");
    journal ??= { version: 1, id: frozen.id, fingerprint, binding: status.workspaceBinding, plan: frozen, status: "running", steps: {}, updatedAt: new Date().toISOString() };
    acceptedJournal = true;
    const reconnectBound = reconnect ? async () => {
      await reconnect();
      const current = await call("get_mcp_status");
      if (current.workspaceBinding !== journal.binding) throw failure("CONFLICT", "重连后的数据库实例或恢复世代已变化；请回到原实例核对已提交请求");
    } : undefined;
    const save = async () => { journal.updatedAt = new Date().toISOString(); ownership.save(journal); await onCheckpoint?.(structuredClone(journal)); };
    const variables = { input: frozen.variables ?? {}, steps: /** @type {Record<string, unknown>} */ ({}) };
    journal.status = "running"; await save();
    for (const step of frozen.steps) {
      signal?.throwIfAborted();
      // JSON-loaded journals have Object.prototype too; only persisted own steps count.
      let checkpoint = Object.hasOwn(journal.steps, step.id) ? journal.steps[step.id] : undefined;
      if (checkpoint?.status === "succeeded") { variables.steps[step.id] = checkpoint.result; continue; }
      if (checkpoint?.terminal) throw failure(checkpoint.error.code, "原步骤为终态错误，需要核对后建立新流程：" + step.id);
      if (!checkpoint) {
        const args = bindInputs(step.arguments ?? {}, variables);
        const key = hash([frozen.id, step.id]);
        if (step.kind === "write" && step.tool === "submit_review") args.requestId ??= randomUUID();
        else if (["write", "job", "upload"].includes(step.kind)) args.idempotencyKey ??= key;
        if (step.kind === "write") createReceipt(step.tool, args);
        checkpoint = journal.steps[step.id] = { status: "pending", arguments: args };
        await save();
      }
      const args = structuredClone(checkpoint.arguments);
      try {
        let result;
        if (step.kind === "write") result = await recoverReceipt(call, createReceipt(step.tool, args), { signal, reconnect: reconnectBound });
        else if (step.kind === "context" || step.kind === "preview") result = await readContext(call, step.tool, args, step.kind === "preview", { signal });
        else if (step.kind === "upload") {
          const { base64, ...upload } = args;
          if (typeof base64 !== "string" || base64.length > 14_000_000) throw failure("INVALID_ARGUMENT", "上传步骤需要有界的原始 base64 字节");
          const bytes = Buffer.from(base64, "base64");
          if (bytes.toString("base64") !== base64) throw failure("INVALID_ARGUMENT", "上传编码无效");
          result = await uploadBytes(call, { ...upload, bytes }, { signal });
        } else if (step.kind === "job") {
          if (!checkpoint.jobId) {
            const job = await recoverReceipt(call, createReceipt("start_mcp_job", { operation: step.tool, arguments: args }), { signal, reconnect: reconnectBound });
            checkpoint.jobId = job.jobId; await save();
          }
          const completed = await waitForJob(call, checkpoint.jobId, { signal, intervalMs: pollMs });
          if (completed.job.status !== "succeeded" || !completed.result) throw failure(completed.job.errorCode ?? "CONFLICT", "后台任务没有可恢复结果，请核对原任务");
          result = completed.result;
        } else result = await call(step.tool, args);
        checkpoint.status = "succeeded"; checkpoint.result = result; delete checkpoint.error;
        variables.steps[step.id] = result; await save();
      } catch (error) {
        checkpoint.error = { code: typeof error.code === "string" ? error.code : "TRANSPORT", requestId: error.requestId ?? null };
        checkpoint.terminal = error.retryable === false && !["CONFLICT", "FORBIDDEN", "CONFIGURATION", "INVALID_ARGUMENT"].includes(error.code);
        journal.status = "needs_attention"; await save(); throw error;
      }
    }
    journal.status = "succeeded"; await save();
    return { id: frozen.id, status: journal.status, results: variables.steps };
  } catch (error) {
    // Binding, cancellation and checkpoint callbacks can fail outside the tool-call catch.
    // Never rewrite a journal rejected above for a different plan or workspace.
    if (acceptedJournal && journal.status === "running") {
      journal.status = "needs_attention"; journal.updatedAt = new Date().toISOString(); ownership.save(journal);
    }
    throw error;
  } finally { ownership.release(); }
}
