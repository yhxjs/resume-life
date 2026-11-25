import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ResumeLifeClient } from "./client.mjs";
import { runTrainingWorkflow, resumeTrainingWorkflow } from "./training-workflow.mjs";

// Synthetic example results. A real Agent supplies its own model's output after reading the context.
export const examplePortrait = { role: "本地工具集成工程师", must_skills: [{ name: "SQLite", weight: 8, why: "JD 要求维护本地数据库" }],
  followups: [{ topic: "事务与并发", questions: ["如何避免多进程并发更新覆盖资料？"] }], company_style: { style: "JD 未说明团队风格", signals: [] } };
export const exampleReview = { mistakes: [], drills: [{ question_index: 1, question: "如何验证恢复备份后旧请求不会重复写入？" }], resume_suggestions: [] };

/** Run against either SDK or a real Host adapter whose call(name,args) returns the structured data. */
export async function runApplicationWorkflow(call, { prefix = String(randomUUID()), referenceTime = Date.now() } = {}) {
  const applicationArgs = { company: "MCP 示例公司", role: "软件工程师", stage: "applied", jd: "维护本地 SQLite 数据库与工具集成。", idempotencyKey: prefix + ":application" };
  const application = await call("create_application", applicationArgs);
  assert.deepEqual(await call("create_application", applicationArgs), application);
  const applicationId = application.id;
  const app = async () => (await call("get_application", { id: applicationId })).application;
  const plan = await call("get_preparation_plan", { applicationId });
  await call("generate_preparation_plan", { applicationId, expectedRevision: plan.revision, contextKey: plan.contextKey });
  const taskArgs = { applicationId, expectedRevision: (await app()).revision, title: "整理 SQLite 并发经验", idempotencyKey: prefix + ":task" };
  const task = await call("create_preparation_task", taskArgs);
  assert.deepEqual(await call("create_preparation_task", taskArgs), task);
  await call("update_preparation_task", { applicationId, taskId: task.id, expectedRevision: (await app()).revision, done: true });
  const context = await call("get_ai_workflow_context", { kind: "jd", applicationId });
  const draftArgs = { kind: "jd", applicationId, expectedSourceRevision: context.sourceRevision, idempotencyKey: prefix + ":portrait", result: examplePortrait };
  const portraitDraft = await call("submit_ai_draft", draftArgs);
  assert.equal((await call("submit_ai_draft", draftArgs)).draftId, portraitDraft.draftId);
  const savedPortrait = await call("save_ai_draft", { draftId: portraitDraft.draftId, expectedRevision: portraitDraft.sourceRevision });
  assert.equal((await call("save_ai_draft", { draftId: portraitDraft.draftId, expectedRevision: portraitDraft.sourceRevision })).id, savedPortrait.id);
  const materials = await call("list_application_preparation_resources", { applicationId, kind: "portrait" });
  assert.ok(materials.items.some(item => item.id === savedPortrait.id));
  const roundArgs = { applicationId, expectedRevision: (await app()).revision, idempotencyKey: prefix + ":round", round_name: "技术面",
    interview_time: new Date(referenceTime + 86_400_000).toISOString() };
  const round = await call("schedule_application_interview", roundArgs);
  assert.deepEqual(await call("schedule_application_interview", roundArgs), round);
  await call("reschedule_application_interview", { applicationId, interviewId: round.id, expectedRevision: (await app()).revision,
    interview_time: new Date(referenceTime + 172_800_000).toISOString() });
  const questions = await call("get_application_interview_questions", { applicationId, interviewId: round.id });
  await call("save_application_interview_questions", { applicationId, interviewId: round.id, expectedRevision: questions.revision,
    questions: [{ question: "你会如何处理 SQLite 写锁竞争？", answer: "限定等待预算，在事务内复核版本；冲突时保留原始输入。", stuck: "", feedback: "希望进一步说明恢复后的校验。" }] });
  const reviewContext = await call("get_ai_workflow_context", { kind: "review", applicationId, interviewId: round.id });
  const reviewDraft = await call("submit_ai_draft", { kind: "review", applicationId, interviewId: round.id,
    expectedSourceRevision: reviewContext.sourceRevision, idempotencyKey: prefix + ":review", result: exampleReview });
  const savedReview = await call("save_ai_draft", { draftId: reviewDraft.draftId, expectedRevision: reviewDraft.sourceRevision });
  await call("get_interview_review", { id: savedReview.id });
  await call("update_application_interview", { applicationId, interviewId: round.id, expectedRevision: (await app()).revision, status: "completed", location: "线上", notes: "逐题记录与复盘已归档。" });
  assert.equal((await app()).next_interview_at, "");
  return { applicationId, taskId: task.id, interviewId: round.id, portraitId: savedPortrait.id, reviewId: savedReview.id,
    portraitDraftId: portraitDraft.draftId, reviewDraftId: reviewDraft.draftId };
}

async function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-mcp-example-"));
  let client;
  try {
    const dataDirectory = path.join(temporary, "data");
    const fixture = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL("../../scripts/check-mcp-training-fixture.mjs", import.meta.url)), temporary],
      { cwd: temporary, env: { ...process.env, RESUME_LIFE_DATA_DIR: dataDirectory }, windowsHide: true, encoding: "utf8" }));
    const options = { dataDirectory, preset: "collaboration", cwd: temporary };
    client = await ResumeLifeClient.connect(options);
    const result = await runApplicationWorkflow((name, args) => client.call(name, args));
    const draft = await client.call("get_ai_draft", { id: result.reviewDraftId });
    assert.deepEqual(JSON.parse((await client.readFull(draft.fullContent)).payload), exampleReview);
    const training = await runTrainingWorkflow((name, args) => client.call(name, args), fixture);
    await client.close();
    client = await ResumeLifeClient.connect(options);
    await resumeTrainingWorkflow((name, args) => client.call(name, args), training);
    console.log(JSON.stringify({ ok: true, isolatedDemo: true, ...result, practiceSessionId: training.session.id, mockInterviewId: training.mock.id }, null, 2));
  } finally {
    await client?.close();
    if (path.dirname(path.resolve(temporary)) !== path.resolve(os.tmpdir()) || !path.basename(temporary).startsWith("resume-life-mcp-example-")) throw new Error("Unsafe demo cleanup path");
    fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
