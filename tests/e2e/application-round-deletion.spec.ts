import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup, rewriteEncryptedBackup } from "./backup-helpers";
import type { RowRecord } from "../../src/lib/backup-records";

for (const width of [390, 1280]) test(`面试轮次删除 ${width}px：确认归属、未知结果只读恢复与级联范围`, async ({ page, request }, testInfo) => {
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
    expect((await request.put("/api/settings", { data: { base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-round-deletion", api_format: "openai_chat", model_evaluate: "synthetic", model_question: "synthetic" } })).ok()).toBe(true);
    const company = "公司 <T> &amp; " + "兼容性研究_".repeat(6); const role = "接口开发_".repeat(6); const roundName = "技术一面 <T> &amp; " + "兼容性验证_".repeat(6);
    const created = await request.post("/api/applications", { data: { company, role, jd: "接口维护" } }); expect(created.status()).toBe(201); const appId = (await created.json()).id;
    const otherCreated = await request.post("/api/applications", { data: { company: "另一投递", role: "前端开发", jd: "另一岗位" } }); expect(otherCreated.status()).toBe(201); const otherId = (await otherCreated.json()).id;
    const makeRound = async (applicationId: number, name: string, time: string) => {
      const saved = await request.post(`/api/applications/${applicationId}/interviews`, { data: { round_name: name, status: "scheduled", interview_time: time, notes: "原手记 <T> &amp;", interviewer: "甲面试官", location: "电话", reminder_minutes: 30 } }); expect(saved.status()).toBe(201); return saved.json();
    };
    const target = await makeRound(appId, roundName, "2099-11-03T01:02:03.000Z");
    const survivor = await makeRound(appId, "保留二面", "2099-11-04T01:02:03.000Z");
    await makeRound(otherId, "其他投递轮次", "2099-11-05T01:02:03.000Z");
    const buildReview = async (roundId: number) => {
      const endpoint = `/api/applications/${appId}/interviews/${roundId}/review`; const initial = await (await request.get(endpoint)).json();
      const draft = await request.put(endpoint, { data: { expected_hash: initial.input_hash, questions: [{ question: "如何验证？", answer: "尚未上线", stuck: "范围待确认", feedback: "未记录" }] } }); expect(draft.status()).toBe(200);
      const generated = await request.post(endpoint, { data: { expected_hash: (await draft.json()).input_hash } }); expect(generated.status()).toBe(200); const recap = (await generated.json()).latest;
      for (const action of ["mistakes", "drills", "resume_suggestions"]) expect((await request.post(`${endpoint}/export`, { data: { recap_id: recap.id, action } })).status()).toBe(200);
      return recap;
    };
    const targetRecap = await buildReview(target.id); await buildReview(survivor.id);
    const records = async () => {
      const backup = await exportEncryptedBackup(request); expect(backup.response.ok()).toBe(true); let rows: RowRecord[] = [];
      await rewriteEncryptedBackup(backup.bytes, records => { rows = records.filter((row): row is RowRecord => row.kind === "row"); }); return rows;
    };
    const original = await records(); const appBefore = await (await request.get(`/api/applications/${appId}`)).json(); const otherBefore = await (await request.get(`/api/applications/${otherId}`)).json();
    let writes = 0; let reads = 0; let deleted = false; let corruptList = true;
    const endpoint = `/api/applications/${appId}/interviews`;
    await page.route(`**${endpoint}**`, async route => {
      const method = route.request().method(); const path = new URL(route.request().url()).pathname;
      if (method === "DELETE" && path === `${endpoint}/${target.id}`) {
        writes++; const response = await route.fetch(); expect(response.status()).toBe(200); deleted = true; await route.fulfill({ status: 200, json: { ok: false } }); return;
      }
      if (method === "GET" && path === endpoint && deleted) {
        reads++;
        if (corruptList) { corruptList = false; await route.fulfill({ status: 200, json: [{ id: survivor.id, application_id: appId }] }); return; }
      }
      await route.continue();
    });
    await page.setViewportSize({ width, height: 900 }); await page.goto(`/applications/${appId}/prepare`);
    await page.locator('a[href="/"]').first().click(); await expect(page).toHaveURL(/\/$/); await page.goBack();
    const row = page.getByRole("region", { name: "真实面试记录" }).getByRole("listitem").filter({ has: page.getByRole("heading", { name: roundName, exact: true }) });
    const open = async () => { await row.getByRole("button", { name: "编辑记录", exact: true }).click(); await expect(page.getByRole("dialog", { name: `编辑面试轮次 · ${company}`, exact: true })).toBeVisible(); };
    const parent = page.getByRole("dialog", { name: `编辑面试轮次 · ${company}`, exact: true }); const trigger = parent.getByRole("button", { name: "删除本轮面试", exact: true }); const confirm = page.getByRole("dialog", { name: "确认删除该轮面试？", exact: true });
    await open(); await trigger.click(); await expect(confirm).toBeVisible(); await page.goForward(); await expect(page).toHaveURL(/\/$/); await expect(confirm).toHaveCount(0); expect(writes).toBe(0);
    await page.goBack(); await open(); const draft = "未保存 <T> &amp;\n内部  空格";
    await parent.getByRole("textbox", { name: "轮次名称 *", exact: true }).fill("本地修改尚未保存"); await parent.getByRole("textbox", { name: "轮次备忘 / 面试要点手记", exact: true }).fill(draft);
    for (const cancel of ["取消", "Escape"]) {
      await trigger.evaluate(node => { (node as HTMLButtonElement).focus(); (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click(); }); await expect(confirm).toBeVisible();
      if (cancel === "Escape") await page.keyboard.press("Escape"); else await confirm.getByRole("button", { name: "取消", exact: true }).click();
      await expect(confirm).toHaveCount(0); await expect(trigger).toBeFocused(); await expect(parent.getByRole("textbox", { name: "轮次备忘 / 面试要点手记", exact: true })).toHaveValue(draft); expect(writes).toBe(0);
    }
    expect(await records()).toEqual(original);
    await trigger.click(); for (const text of [`投递 #${appId}`, company, role, `轮次 #${target.id}`, roundName, target.interview_time, target.created_at, "逐题记录", "全部复盘", "追练", "保留"]) await expect(confirm).toContainText(text);
    expect(await confirm.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true); await page.screenshot({ path: testInfo.outputPath(`round-confirm-${width}.png`), animations: "disabled" });
    await confirm.getByRole("button", { name: "确认删除", exact: true }).click(); await expect(parent.getByRole("alert")).toContainText("删除结果尚未确认"); expect(writes).toBe(1); expect(reads).toBe(1);
    await expect(trigger).toBeDisabled(); await expect(parent.getByRole("button", { name: "更新轮次", exact: true })).toBeDisabled(); await expect(parent.getByRole("textbox", { name: "轮次备忘 / 面试要点手记", exact: true })).toHaveValue(draft);
    await page.screenshot({ path: testInfo.outputPath(`round-unknown-${width}.png`), animations: "disabled" });
    await parent.getByRole("button", { name: "重新读取删除状态", exact: true }).evaluate(node => { (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click(); });
    await expect(parent).toHaveCount(0); await expect(row).toHaveCount(0); expect(writes).toBe(1); expect(reads).toBe(2);
    const appAfter = await (await request.get(`/api/applications/${appId}`)).json(); expect(appAfter).toEqual({ ...appBefore, interviews: appBefore.interviews.filter((item: { id: number }) => item.id !== target.id),
      interview_rounds_count: appBefore.interview_rounds_count - 1, latest_round: survivor.round_name, latest_round_status: survivor.status,
      next_interview_at: survivor.interview_time, updated_at: expect.any(String) });
    expect(await (await request.get(`/api/applications/${otherId}`)).json()).toEqual(otherBefore);
    const after = await records(); const table = (rows: RowRecord[], name: string) => rows.filter(row => row.table === name);
    expect(table(after, "applications")).toEqual(table(original, "applications").map(row => row.data.id === appId ? { ...row, data: { ...row.data, next_interview_at: survivor.interview_time, updated_at: expect.any(String) } } : row));
    for (const name of ["notebook_entries", "review_cards", "drills", "drill_questions", "application_preparation_tasks", "application_preparation_resources"]) expect(table(after, name), name).toEqual(table(original, name));
    expect(table(after, "application_interviews")).toEqual(table(original, "application_interviews").filter(row => row.data.id !== target.id));
    for (const name of ["application_interview_questions", "application_interview_recaps"]) expect(table(after, name), name).toEqual(table(original, name).filter(row => row.data.interview_id !== target.id));
    expect(table(after, "application_interview_recap_exports")).toEqual(table(original, "application_interview_recap_exports").filter(row => row.data.recap_id !== targetRecap.id));
  } finally {
    await page.goto("/"); provider.closeAllConnections(); await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
  }
});
