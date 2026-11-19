import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { exportEncryptedBackup, postEncryptedBackup, rewriteEncryptedBackup } from "./backup-helpers";
import { publishResume } from "./resume-version-helpers";
import type { RowRecord } from "../../src/lib/backup-records";

for (const width of [390, 1280]) test(`投递删除 ${width}px：确认归属、只读核对与完整级联范围`, async ({ page, request }, testInfo) => {
  test.setTimeout(120_000);
  const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
  const result = { mistakes: [{ question_index: 1, gap: "待确认实际范围", improved_answer: "根据记录补充" }], drills: [{ question_index: 1, question: "如何验证兼容性？" }], resume_suggestions: [{ question_index: 1, suggestion: "补充实际验证范围" }] };
  const provider = createServer(async (incoming, outgoing) => {
    for await (const chunk of incoming) void chunk;
    outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
    outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(result) } }] })}\n\ndata: [DONE]\n\n`);
  });
  await listenForFetch(provider);
  const address = provider.address(); if (!address || typeof address === "string") throw new Error("Missing provider address");
  try {
    expect((await request.put("/api/settings", { data: { base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-application-deletion", api_format: "openai_chat", model_evaluate: "synthetic", model_question: "synthetic" } })).ok()).toBe(true);
    const resume = await request.post("/api/resumes", { data: { title: "保留简历 <T> &amp;", modules: { summary: { text: "原稿内部  空格，尚未上线" } } } });
    expect(resume.status()).toBe(201); const resumeId = (await resume.json()).id; const version = await publishResume(request, resumeId);
    const company = "目标投递 <T> &amp; " + "兼容性研究_".repeat(6); const role = "接口开发_".repeat(6);
    const created = await request.post("/api/applications", { data: { company, role, jd: "接口维护 <T> &amp;", stage: "applied", resume_id: resumeId, resume_version_id: version.id, batch_name: "秋招" } });
    expect(created.status()).toBe(201); const appId = (await created.json()).id;
    const otherCreated = await request.post("/api/applications", { data: { company: "保留投递", role: "接口开发", jd: "另一岗位", resume_id: resumeId, resume_version_id: version.id } });
    expect(otherCreated.status()).toBe(201); const otherId = (await otherCreated.json()).id;
    const rounds: number[] = [];
    for (const applicationId of [appId, appId, otherId]) {
      const response = await request.post(`/api/applications/${applicationId}/interviews`, { data: { round_name: `技术面${rounds.length + 1}`, status: "scheduled", interview_time: "2099-11-03T01:02:03.000Z", notes: "原手记 <T> &amp;" } });
      expect(response.status()).toBe(201); rounds.push((await response.json()).id);
    }
    const endpoint = `/api/applications/${appId}/interviews/${rounds[0]}/review`;
    const initial = await (await request.get(endpoint)).json();
    const draft = await request.put(endpoint, { data: { expected_hash: initial.input_hash, questions: [{ question: "如何验证？", answer: "尚未上线", stuck: "范围待确认", feedback: "未记录" }] } }); expect(draft.status()).toBe(200);
    const generated = await request.post(endpoint, { data: { expected_hash: (await draft.json()).input_hash } }); expect(generated.status()).toBe(200); const recap = (await generated.json()).latest;
    for (const action of ["mistakes", "drills", "resume_suggestions"]) expect((await request.post(`${endpoint}/export`, { data: { recap_id: recap.id, action } })).status()).toBe(200);
    expect((await request.post(`/api/applications/${appId}/preparation/tasks`, { data: { title: "投递下一步 <T> &amp;" } })).status()).toBe(201);
    const records = async () => {
      let rows: RowRecord[] = []; const backup = await exportEncryptedBackup(request); expect(backup.response.ok()).toBe(true);
      await rewriteEncryptedBackup(backup.bytes, entries => { rows = entries.filter((row): row is RowRecord => row.kind === "row"); }); return rows;
    };
    const reviewCard = (await records()).find(row => row.table === "review_cards"); expect(reviewCard).toBeTruthy();
    expect((await request.post(`/api/reviews/${reviewCard!.data.id}`, { data: { answer: "复习原答 <T> &amp;", grade: "good", expected_review_count: 0, request_id: randomUUID() } })).status()).toBe(200);
    const original = await records(); const appBefore = await (await request.get(`/api/applications/${appId}`)).json(); const otherBefore = await (await request.get(`/api/applications/${otherId}`)).json();
    let writes = 0; let reads = 0; let deleted = false; let readMode: "foreign" | "fail" | "normal" = "foreign";
    await page.route(`**/api/applications/${appId}`, async route => {
      if (route.request().method() === "DELETE") {
        writes++; const response = await route.fetch(); expect(response.status()).toBe(200); deleted = true; await route.fulfill({ status: 200, json: { ok: false } }); return;
      }
      if (deleted) {
        reads++;
        if (readMode === "foreign") { await route.fulfill({ status: 200, json: otherBefore }); return; }
        if (readMode === "fail") { await route.fulfill({ status: 503, json: { error: "核对暂不可用" } }); return; }
      }
      await route.continue();
    });
    await page.setViewportSize({ width, height: 900 }); await page.goto("/applications");
    await page.locator('a[href="/"]').first().click(); await expect(page).toHaveURL(/\/$/); await page.goBack();
    const card = page.locator("div[draggable]").filter({ has: page.getByRole("heading", { name: company, exact: true }) });
    const trigger = card.getByRole("button", { name: "删除卡片", exact: true }); const confirm = page.getByRole("dialog", { name: "确认删除投递记录？", exact: true });
    await trigger.click(); await expect(confirm).toBeVisible(); await page.goForward(); await expect(page).toHaveURL(/\/$/); await expect(confirm).toHaveCount(0); expect(writes).toBe(0);
    await page.goBack(); await page.getByPlaceholder("搜索公司、岗位或笔记...").fill("接口"); await expect(trigger).toBeVisible();
    for (const cancel of ["取消", "Escape"]) {
      await trigger.evaluate(node => { (node as HTMLButtonElement).focus(); (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click(); }); await expect(confirm).toBeVisible();
      if (cancel === "Escape") await page.keyboard.press("Escape"); else await confirm.getByRole("button", { name: "取消", exact: true }).click();
      await expect(confirm).toHaveCount(0); await expect(trigger).toBeFocused();
      await expect.poll(() => trigger.evaluate(node => Number(getComputedStyle(node.parentElement!).opacity))).toBe(1); expect(writes).toBe(0);
    }
    expect(await records()).toEqual(original); await trigger.click();
    for (const text of [`#${appId}`, company, role, appBefore.created_at, appBefore.updated_at, "投递快照", "阶段履历", "复盘", "准备待办", "简历", "收藏", "复习", "追练"]) await expect(confirm).toContainText(text);
    expect(await confirm.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true); await page.screenshot({ path: testInfo.outputPath(`application-confirm-${width}.png`), animations: "disabled" });
    await confirm.getByRole("button", { name: "确认删除", exact: true }).click();
    const error = page.getByRole("alert").filter({ hasText: "删除结果尚未确认" }); await expect(error).toBeVisible();
    const retry = page.getByRole("button", { name: "重新读取删除状态", exact: true }); await expect(retry).toBeInViewport(); await expect(page.getByRole("group", { name: "投递删除状态", exact: true })).toBeFocused(); expect(writes).toBe(1); expect(reads).toBe(1);
    await expect(trigger).toBeDisabled(); await expect(page.getByRole("button", { name: /登记新投递/ })).toBeDisabled(); await expect(card.getByRole("button", { name: "编辑卡片", exact: true })).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: testInfo.outputPath(`application-unknown-${width}.png`), animations: "disabled" });
    readMode = "fail"; await retry.click(); await expect(error).toContainText("核对暂不可用"); expect(writes).toBe(1); expect(reads).toBe(2);
    readMode = "normal"; await retry.evaluate(node => { (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click(); });
    await expect(page.getByRole("heading", { name: "保留投递", exact: true })).toBeVisible(); await expect(card).toHaveCount(0); expect(writes).toBe(1); expect(reads).toBe(3);
    await expect(page.getByPlaceholder("搜索公司、岗位或笔记...")).toHaveValue("接口"); expect(await (await request.get(`/api/applications/${otherId}`)).json()).toEqual(otherBefore);
    const after = await records(); const targetRounds = new Set(rounds.slice(0, 2));
    const deletedRows = original.filter(row => row.table === "applications" ? row.data.id === appId
      : ["application_stage_history", "application_interviews", "application_preparation_resources", "application_preparation_tasks"].includes(row.table) ? row.data.application_id === appId
      : ["application_interview_questions", "application_interview_recaps"].includes(row.table) ? targetRounds.has(Number(row.data.interview_id))
      : ["application_interview_recap_exports", "application_interview_recap_contexts"].includes(row.table) && row.data.recap_id === recap.id);
    const removed = new Set(deletedRows); expect(after).toEqual(original.filter(row => !removed.has(row)));
    for (const name of ["applications", "application_stage_history", "application_interviews", "application_interview_questions", "application_interview_recaps", "application_interview_recap_exports", "application_interview_recap_contexts", "application_preparation_resources", "application_preparation_tasks"]) expect(deletedRows.some(row => row.table === name), name).toBe(true);
  } finally {
    await page.goto("/"); await page.unrouteAll({ behavior: "wait" }); provider.closeAllConnections(); await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
  }
});
