import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readContext } from "./content-workflow.mjs";
import { readArtifact } from "./helpers.mjs";
export { readArtifact } from "./helpers.mjs";

/** Binary offsets count bytes; decode each base64 chunk before concatenating. */

/** Synthetic candidate facts and model output; this example never calls a provider. */
export async function runDeliveryWorkflow(call, { resumeId: originalId, projectId, prefix = randomUUID() }) {
  const receipts = [], artifacts = [];
  const save = async (name, args) => { const result = await call(name, args); receipts.push({ name, args, result }); return result; };
  const context = (name, args = {}, preview = false) => readContext(call, name, args, preview);
  const previewSave = async (previewTool, saveTool, proposal, key) => save(saveTool, { ...proposal,
    previewToken: (await context(previewTool, proposal, true)).previewToken, idempotencyKey: prefix + ":" + key });
  const catalog = await context("get_workflow_catalog");
  assert.ok(catalog.value.workflows.every(workflow => workflow.available));
  const draft = await save("create_resume_draft", { title: "MCP 交付示例", source: { resumeId: originalId,
    expectedRevision: (await context("get_resume_draft_context", { resumeId: originalId })).revision }, idempotencyKey: prefix + ":draft" });
  const resumeId = draft.id;
  await previewSave("preview_resume_draft_edit", "save_resume_draft_edit", { resumeId,
    expectedRevision: (await context("get_resume_draft_context", { resumeId })).revision, modules: [
      { key: "basic", type: "basic", label: "基本信息", content: { name: "示例候选人", phone: "13800138000", email: "example@example.com", location: "香港", birthday: "", links: "" } },
      { key: "summary", type: "summary", label: "自我评价", content: { text: "参与本地数据库维护。" } },
    ] }, "edit");
  const first = await save("publish_resume_version", { resumeId, name: "诊断前",
    expectedRevision: (await context("get_resume_version_context", { resumeId })).revision, idempotencyKey: prefix + ":first-version" });
  const application = await save("create_application", { company: "MCP 交付示例公司", role: "数据库工程师", jd: "维护本地数据库", stage: "interested",
    resume_id: resumeId, resume_version_id: first.id, idempotencyKey: prefix + ":application" });
  const diagnosisContext = await call("get_ai_workflow_context", { kind: "diagnosis", applicationId: application.id });
  const diagnosisDraft = await call("submit_ai_draft", { kind: "diagnosis", applicationId: application.id, expectedSourceRevision: diagnosisContext.sourceRevision,
    idempotencyKey: prefix + ":diagnosis", result: { match: 7, summary: "明确经验范围。", modules: [
      { module_key: "skills", scores: { depth: 7, structure: 7, authenticity: 7, completeness: 7 }, gaps: "", suggestions: [{ item_id: "", field: "items", reason: "保留参与程度", draft: ["参与本地数据库维护"] }] },
      { module_key: "summary", scores: { depth: 7, structure: 7, authenticity: 7, completeness: 7 }, gaps: "", suggestions: [] },
    ] } });
  const diagnosis = await call("save_ai_draft", { draftId: diagnosisDraft.draftId, expectedRevision: diagnosisDraft.sourceRevision });
  const adoptionSource = { resumeId, diagnosisId: diagnosis.id };
  await previewSave("preview_diagnosis_adoption", "save_diagnosis_adoption", { ...adoptionSource,
    expectedRevision: (await context("get_diagnosis_adoption_context", adoptionSource)).revision, selections: [{ moduleKey: "skills", suggestionIndex: 0 }] }, "adopt");
  const layout = await context("get_resume_layout_context", { resumeId });
  await previewSave("preview_resume_layout", "save_resume_layout", { resumeId, expectedRevision: layout.revision, removeKeys: ["summary"],
    moduleOrder: ["basic", "skills"], template: "classic", styleOverrides: { accent: "#112233", baseSize: 12 } }, "layout");
  const published = await save("publish_resume_version", { resumeId, name: "岗位交付版",
    expectedRevision: (await context("get_resume_version_context", { resumeId })).revision, idempotencyKey: prefix + ":published" });
  const comparison = await context("compare_resume_versions", { resumeId, beforeVersionId: first.id, afterVersionId: published.id }, true);
  assert.ok(comparison.value.changes.modules.length > 0);
  const source = { resumeId, versionId: published.id };
  const exportContext = await context("get_resume_export_context", { source });
  assert.equal(exportContext.value.canExport, true);
  const anonymousSource = { ...source, anonymizeConfig: exportContext.value.defaultAnonymizeConfig };
  const anonymous = await context("get_resume_export_context", { source: anonymousSource });
  for (const format of ["markdown", "docx"]) {
    const artifact = await save("export_resume", { source: anonymousSource, expectedRevision: anonymous.revision, format, idempotencyKey: prefix + ":export-" + format });
    artifacts.push(artifact);
    const bytes = await readArtifact(call, artifact);
    if (format === "markdown") { assert.ok(bytes.toString().includes("参与本地数据库维护")); assert.ok(!bytes.toString().includes("13800138000")); }
  }
  await call("update_application", { id: application.id, expectedRevision: (await call("get_application", { id: application.id })).application.revision,
    resume_id: resumeId, resume_version_id: published.id, stage: "applied" });
  const historical = { resumeId, versionId: first.id };
  await previewSave("preview_resume_version_branch", "branch_resume_version", { ...historical,
    expectedRevision: (await context("get_resume_version_context", historical)).revision }, "branch");
  assert.equal((await call("get_application", { id: application.id })).application.resume_version_id, published.id);

  const bank = { direction: "MCP 交付示例", kind: "tech", text: "如何核对 SQLite 事务？\n如何重试？\n如何重试？" };
  const bankKey = prefix + ":bank";
  await previewSave("preview_bank_import", "save_bank_import", bank, "bank");
  const imported = await context("get_bank_import_result", { idempotencyKey: bankKey });
  assert.equal(imported.value.createdCount, 2); assert.equal(imported.value.skippedCount, 1);
  const category = await save("create_notebook_category", { name: "交付示例分类", expectedRevision: (await context("get_notebook_organization_context")).revision,
    idempotencyKey: prefix + ":category" });
  await save("rename_notebook_category", { categoryId: category.id, name: "交付示例数据库", expectedRevision: (await context("get_notebook_organization_context", { categoryId: category.id })).revision,
    idempotencyKey: prefix + ":rename" });
  const notebookId = (await call("list_notebook", { limit: 1 })).items[0].id;
  await save("move_notebook_entry", { notebookId, categoryId: category.id, expectedRevision: (await context("get_notebook_organization_context", { notebookId })).revision,
    idempotencyKey: prefix + ":move" });
  const materialId = (await call("list_project_materials", { parentId: projectId, limit: 1 })).items[0].id;
  const materialSource = { projectId, materialId };
  await previewSave("preview_project_material_edit", "save_project_material_edit", { ...materialSource,
    expectedRevision: (await context("get_project_material_context", materialSource)).revision, filename: "示例事实确认.md" }, "material");
  const repository = await context("get_repository_catalog");
  assert.equal(repository.value.repositories.length, 1);
  const expectedProjectRevision = (await context("get_project_material_context", { projectId })).revision;
  const captureKey = prefix + ":capture";
  await save("capture_project_repository", { projectId, repositoryIndex: 0, expectedCatalogRevision: repository.revision, expectedProjectRevision, idempotencyKey: captureKey });
  const captured = await context("get_repository_capture", { idempotencyKey: captureKey });
  assert.ok(!captured.value.snapshot.includes("PRIVATE_FIXTURE_VALUE"));
  const file = captured.value.files.find(file => file.locator.endsWith("src/transaction.ts"));
  assert.ok(file);
  const evidence = await save("save_repository_evidence", { projectId, captureKey, fileIndexes: [file.index], expectedCaptureRevision: captured.revision,
    expectedProjectRevision, idempotencyKey: prefix + ":evidence" });
  const text = "参与 SQLite 校验，与同事进行例行协作。";
  const jargon = await save("save_jargon_result", { text, expectedRevision: (await context("get_jargon_generation_context", { text })).revision,
    idempotencyKey: prefix + ":jargon", result: { target_summary: "例行协作职责", punchline: "未识别到明确风险线索", overall_risk_score: 12,
      risk_ratings: { overtime: 1, stability: 2, resources: 1, management: 1 }, items: [],
      company_profile: { team_style: "信息不足", risk_flags: [], culture_summary: "原文只说明常规协作，不能据此判断实际团队情况。" }, golden_questions: [] } });
  assert.ok((await call("search_records", { query: "SQLite" })).careerRecords.some(record => record.id === jargon.id && record.fullContent.kind === "jargon_decoding"));
  await context("get_portfolio_sources");
  const options = { ...source, selectedProjects: [{ projectId }], siteTemplate: "sidebar" };
  const portfolio = await save("export_portfolio", { options, expectedRevision: (await context("get_portfolio_context", { options })).revision, idempotencyKey: prefix + ":portfolio" });
  artifacts.push(portfolio);
  assert.equal((await readArtifact(call, portfolio)).subarray(0, 2).toString(), "PK");
  return { receipts, artifacts, bankKey, captureKey, resumeId, versionId: published.id, applicationId: application.id, diagnosisId: diagnosis.id, jargonId: jargon.id, materialIds: evidence.materialIds };
}

export async function resumeDeliveryWorkflow(call, result) {
  for (const receipt of result.receipts) assert.deepEqual(await call(receipt.name, receipt.args), receipt.result);
  for (const artifact of result.artifacts) await readArtifact(call, artifact);
  assert.equal((await readContext(call, "get_bank_import_result", { idempotencyKey: result.bankKey })).value.createdCount, 2);
  assert.ok((await readContext(call, "get_repository_capture", { idempotencyKey: result.captureKey })).value.files.length > 0);
}

/** Two independent stdio processes share one SQLite file, as two external Agents would. */
export async function verifyConcurrentDelivery(callA, callB, { resumeId, versionId }) {
  const key = randomUUID();
  const bank = { direction: "并发回执示例", kind: "tech", text: "如何验证并发提交只有一份记录？" };
  const preview = await readContext(callA, "preview_bank_import", bank, true);
  const request = { ...bank, previewToken: preview.previewToken, idempotencyKey: key + ":bank" };
  const [first, second] = await Promise.all([callA("save_bank_import", request), callB("save_bank_import", request)]);
  assert.deepEqual(first, second); assert.equal(first.createdCount, 1);
  const before = (await readContext(callA, "get_resume_version_context", { resumeId })).revision;
  const results = await Promise.allSettled([
    callA("publish_resume_version", { resumeId, name: "并发候选一", expectedRevision: before, idempotencyKey: key + ":version-a" }),
    callB("publish_resume_version", { resumeId, name: "并发候选二", expectedRevision: before, idempotencyKey: key + ":version-b" }),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.find(result => result.status === "rejected").reason.code, "CONFLICT");
  const source = { resumeId, versionId };
  const exportArgs = { source, expectedRevision: (await readContext(callA, "get_resume_export_context", { source })).revision,
    format: "markdown", idempotencyKey: key + ":export" };
  const artifacts = await Promise.all([callA("export_resume", exportArgs), callB("export_resume", exportArgs)]);
  assert.deepEqual(artifacts[0], artifacts[1]); await readArtifact(callB, artifacts[0]);
}
