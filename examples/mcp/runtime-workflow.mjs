import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { readAllPages, readArtifact, readContext, uploadBytes, waitForJob } from "./helpers.mjs";

/** Synthetic external-Agent results; the server never calls a model in this workflow. */
export async function runRuntimeWorkflow(call, { projectId, advanceRepository, prefix = randomUUID() }) {
  const uploaded = await uploadBytes(call, { bytes: Buffer.from("姓名：示例人物\n参与 SQLite 数据工具维护。"),
    filename: "resume.txt", purpose: "resume", idempotencyKey: prefix + ":upload" });
  const extractionKey = prefix + ":extract";
  const extraction = await call("start_mcp_job", { operation: "extract_uploaded_file", arguments: { uploadId: uploaded.uploadId, ocrMode: "off", idempotencyKey: extractionKey } });
  const extracted = await waitForJob(call, extraction.jobId);
  assert.equal(extracted.job.status, "succeeded");
  const document = await readContext(call, "get_file_extraction", { idempotencyKey: extractionKey });
  assert.ok(document.value.text.includes("参与 SQLite"));
  const source = { extractionKey, target: { kind: "resume" } };
  const basis = await readContext(call, "get_file_import_context", { source });
  const proposalKey = prefix + ":proposal";
  await call("submit_file_import", { source, expectedRevision: basis.revision, idempotencyKey: proposalKey,
    result: { title: "文件导入示例", basic: { name: "示例人物" }, summary: { text: "参与 SQLite 数据工具维护。" } } });
  const preview = await readContext(call, "preview_file_import", { proposalKey });
  const importArgs = { proposalKey, kind: "resume", previewToken: preview.previewToken, idempotencyKey: prefix + ":import" };
  const resume = await call("save_file_import", importArgs);
  assert.deepEqual(await call("save_file_import", importArgs), resume);
  const templateBasis = await readContext(call, "get_resume_template_context");
  const templateArgs = { name: "MCP 自定义样式", templateRef: "classic", expectedRevision: templateBasis.revision, idempotencyKey: prefix + ":template" };
  const template = await call("create_resume_template", templateArgs);
  const edit = { templateId: template.id, name: "文件履历样式", style: { accent: "#115599" },
    expectedRevision: (await readContext(call, "get_resume_template_context", { templateId: template.id })).revision };
  const templatePreview = await readContext(call, "preview_resume_template", edit, true);
  const templateSave = { ...edit, previewToken: templatePreview.previewToken, idempotencyKey: prefix + ":template-save" };
  await call("save_resume_template", templateSave);
  const layout = { resumeId: resume.id, template: "custom:" + template.id, expectedRevision: (await readContext(call, "get_resume_layout_context", { resumeId: resume.id })).revision };
  const layoutPreview = await readContext(call, "preview_resume_layout", layout, true);
  await call("save_resume_layout", { ...layout, previewToken: layoutPreview.previewToken, idempotencyKey: prefix + ":layout" });
  const image = await sharp({ create: { width: 64, height: 80, channels: 3, background: "#115599" } }).png().toBuffer();
  const avatar = await uploadBytes(call, { bytes: image, filename: "avatar.png", purpose: "avatar", idempotencyKey: prefix + ":avatar-upload" });
  const avatarBasis = await readContext(call, "get_resume_avatar_context", { resumeId: resume.id });
  const avatarArgs = { resumeId: resume.id, moduleKey: avatarBasis.value.modules.find(module => module.type === "basic").key,
    uploadId: avatar.uploadId, expectedRevision: avatarBasis.revision, idempotencyKey: prefix + ":avatar" };
  await call("set_resume_avatar", avatarArgs);
  const exportSource = { resumeId: resume.id };
  const exportBasis = await readContext(call, "get_resume_export_context", { source: exportSource });
  assert.equal(exportBasis.value.canExport, true, "示例导出存在阻塞项，必须先逐项核对");
  const exportJob = await call("start_mcp_job", { operation: "export_resume", arguments: { source: exportSource, format: "markdown",
    expectedRevision: exportBasis.revision, idempotencyKey: prefix + ":export" } });
  const exported = await waitForJob(call, exportJob.jobId); assert.equal(exported.job.status, "succeeded");
  const artifact = exported.result;
  assert.ok((await readArtifact(call, artifact)).toString().includes("参与 SQLite"));
  const found = await readAllPages(call, "search_records_page", { query: "SQLite", domains: ["resume"], limit: 2 });
  assert.ok(found.some(row => row.id === resume.id));
  let evidence;
  if (advanceRepository) {
    const capture = async (key, baselineCaptureKey) => call("capture_project_repository", { projectId, repositoryIndex: 0, baselineCaptureKey,
      expectedCatalogRevision: (await readContext(call, "get_repository_catalog")).revision,
      expectedProjectRevision: (await readContext(call, "get_project_material_context", { projectId })).revision, idempotencyKey: key });
    const baseCaptureKey = prefix + ":base-capture", nextCaptureKey = prefix + ":next-capture";
    await capture(baseCaptureKey);
    const base = await readContext(call, "get_repository_capture", { idempotencyKey: baseCaptureKey });
    await call("save_repository_evidence", { projectId, captureKey: baseCaptureKey, fileIndexes: base.value.files.map(file => file.index),
      expectedCaptureRevision: base.revision, expectedProjectRevision: (await readContext(call, "get_project_material_context", { projectId })).revision, idempotencyKey: prefix + ":base-evidence" });
    await advanceRepository(); await capture(nextCaptureKey, baseCaptureKey);
    const diffSource = { projectId, baseCaptureKey, nextCaptureKey }, diff = await readContext(call, "get_repository_evidence_diff", diffSource);
    const update = { ...diffSource, expectedRevision: diff.revision, selections: diff.value.changes.filter(row => row.kind === "modified" || row.kind === "added")
      .map(row => ({ locator: row.locator, action: "upsert" })) };
    assert.ok(update.selections.length);
    const changes = await readContext(call, "preview_repository_evidence_update", update, true);
    evidence = { ...update, previewToken: changes.previewToken, idempotencyKey: prefix + ":evidence-update" };
    await call("save_repository_evidence_update", evidence);
    const history = await readAllPages(call, "list_repository_evidence_history", { projectId, limit: 2 });
    assert.ok(history.some(row => row.change_kind === "modified"));
  }
  return { resumeId: resume.id, importArgs, templateArgs, templateSave, avatarArgs, exportJobId: exportJob.jobId, artifact, evidence };
}

export async function resumeRuntimeWorkflow(call, saved) {
  assert.deepEqual(await call("save_file_import", saved.importArgs), { id: saved.resumeId });
  await call("create_resume_template", saved.templateArgs);
  await call("save_resume_template", saved.templateSave);
  await call("set_resume_avatar", saved.avatarArgs);
  assert.equal((await call("get_mcp_job", { jobId: saved.exportJobId })).status, "succeeded");
  assert.ok((await readArtifact(call, saved.artifact)).length > 0);
  if (saved.evidence) await call("save_repository_evidence_update", saved.evidence);
}
