import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup, rewriteEncryptedBackup } from "./backup-helpers";
import type { BackupRecord } from "../../src/lib/backup-records";

for (const width of [390, 1280]) test(`逐题复盘确认 ${width}px：离页清理、取消焦点与真实导出`, async ({ page, request }, testInfo) => {
  test.setTimeout(120_000);
  const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
  let calls = 0;
  const result = { mistakes: [{ question_index: 1, gap: "验证范围缺少记录", improved_answer: "待确认实际分工" }],
    drills: [{ question_index: 1, question: "如何确认兼容性？" }], resume_suggestions: [{ question_index: 1, suggestion: "补充已确认的验证范围" }] };
  const provider = createServer(async (incoming, outgoing) => {
    for await (const chunk of incoming) void chunk; calls++;
    outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
    outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(result) } }] })}\n\ndata: [DONE]\n\n`);
  });
  await listenForFetch(provider);
  const address = provider.address(); if (!address || typeof address === "string") throw new Error("Missing provider address");
  try {
    expect((await request.put("/api/settings", { data: { base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-review-confirmation", api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic" } })).ok()).toBe(true);
    const company = "公司 <T> &amp; " + "兼容性研究_".repeat(8); const role = "接口开发_".repeat(8); const roundName = "技术一面 <T> &amp;";
    const created = await request.post("/api/applications", { data: { company, role, jd: "负责范围待确认" } }); expect(created.status()).toBe(201); const appId = (await created.json()).id;
    const roundResponse = await request.post(`/api/applications/${appId}/interviews`, { data: { round_name: roundName, status: "completed" } }); expect(roundResponse.status()).toBe(201); const roundId = (await roundResponse.json()).id;
    const endpoint = `/api/applications/${appId}/interviews/${roundId}/review`; const question = { question: "接口兼容性如何验证？", answer: "参与联调，尚未上线", stuck: "范围待确认", feedback: "未记录" };
    const initial = await (await request.get(endpoint)).json();
    const saved = await request.put(endpoint, { data: { expected_hash: initial.input_hash, questions: [question] } }); expect(saved.status()).toBe(200);
    const generated = await request.post(endpoint, { data: { expected_hash: (await saved.json()).input_hash } }); expect(generated.status()).toBe(200); const before = await generated.json(); const recap = before.latest;
    const records = async () => {
      const backup = await exportEncryptedBackup(request); expect(backup.response.ok()).toBe(true); let resultRecords: BackupRecord[] = [];
      await rewriteEncryptedBackup(backup.bytes, rows => { resultRecords = rows.filter(row => row.kind === "row"); }); return resultRecords;
    };
    const originalRecords = await records(); let writes = 0;
    await page.route(`**/api/applications/${appId}/interviews/${roundId}/review**`, async route => { if (["POST", "PUT"].includes(route.request().method())) writes++; await route.continue(); });
    await page.setViewportSize({ width, height: 900 }); await page.goto(`/applications/${appId}/prepare`);
    const open = async () => { await page.getByRole("region", { name: "真实面试记录" }).getByRole("button", { name: "逐题复盘", exact: true }).click(); await expect(page.getByRole("textbox", { name: "怎么回答", exact: true })).toBeVisible(); };
    const parent = page.getByRole("dialog", { name: `逐题复盘 · ${roundName}`, exact: true });
    const draft = "未保存 <T> &amp;\n内部  空格，尚未上线";
    const actions = [
      { key: "discard", trigger: "关闭", title: "放弃未保存的逐题记录？", accept: "放弃编辑" },
      { key: "mistakes", trigger: "加入错题本", title: "加入错题本？", accept: "确认加入" },
      { key: "resume_suggestions", trigger: "创建修改待办", title: "创建修改待办？", accept: "确认创建" },
      { key: "drills", trigger: "开始追练", title: "开始追练？", accept: "创建并开始" },
    ];
    // 先建立同一 SPA 的前进记录，确认存在时可以离开而不点击遮罩后方。
    await page.locator('a[href="/"]').first().click(); await expect(page).toHaveURL(/\/$/); await page.goBack();
    for (const action of actions) {
      await open(); await parent.getByRole("textbox", { name: "怎么回答", exact: true }).fill(draft);
      const trigger = parent.getByRole("button", { name: action.trigger, exact: true }); const confirm = page.getByRole("dialog", { name: action.title, exact: true });
      await trigger.click(); await expect(confirm).toBeVisible(); await page.goForward(); await expect(page).toHaveURL(/\/$/); await expect(confirm).toHaveCount(0); expect(writes).toBe(0);
      await page.goBack(); await open(); await parent.getByRole("textbox", { name: "怎么回答", exact: true }).fill(draft);
      for (const cancel of ["取消", "Escape"]) {
        await trigger.evaluate(node => { (node as HTMLButtonElement).focus(); (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click(); }); await expect(confirm).toBeVisible();
        if (cancel === "Escape") await page.keyboard.press("Escape"); else await confirm.getByRole("button", { name: "取消", exact: true }).click();
        await expect(confirm).toHaveCount(0); await expect(trigger).toBeFocused(); await expect(parent.getByRole("textbox", { name: "怎么回答", exact: true })).toHaveValue(draft); expect(writes).toBe(0);
      }
      await trigger.click(); for (const text of [`投递 #${appId}`, company, role, `轮次 #${roundId}`, roundName]) await expect(confirm).toContainText(text);
      if (action.key !== "discard") { await expect(confirm).toContainText(`复盘 #${recap.id}`); await expect(confirm).toContainText(recap.created_at); }
      expect(await confirm.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`review-${action.key}-${width}.png`), animations: "disabled" });
      await confirm.getByRole("button", { name: "取消", exact: true }).click();
      await parent.getByRole("button", { name: "关闭", exact: true }).click();
      await page.getByRole("dialog", { name: "放弃未保存的逐题记录？", exact: true }).getByRole("button", { name: "放弃编辑", exact: true }).click(); await expect(parent).toHaveCount(0);
    }
    expect(await records()).toEqual(originalRecords); expect(await (await request.get(endpoint)).json()).toEqual(before);
    await open();
    for (const action of actions.filter(item => item.key !== "discard")) {
      await parent.getByRole("button", { name: action.trigger, exact: true }).click();
      await page.getByRole("dialog", { name: action.title, exact: true }).getByRole("button", { name: action.accept, exact: true }).click();
      if (action.key === "drills") await expect(page).toHaveURL(/\/drills\/\d+$/); else await expect(parent.getByRole("button", { name: action.key === "mistakes" ? "已加入错题本" : "已创建待办", exact: true })).toBeVisible();
    }
    expect(writes).toBe(3); expect(calls).toBe(1);
    const after = await (await request.get(endpoint)).json(); expect(after.questions).toEqual(before.questions); expect(after.input_hash).toBe(before.input_hash); expect(after.history).toEqual(before.history);
    expect(after.latest.questions).toEqual(recap.questions); expect(after.latest.result).toEqual(recap.result); expect(after.latest.exports).toEqual({ mistakes: true, resume_suggestions: true, drills: expect.any(Number) });
    const drill = await (await request.get(`/api/drills/${after.latest.exports.drills}`)).json(); expect(drill.questions).toHaveLength(1);
    const finalRecords = await records();
    const rows = (records: BackupRecord[], name: string) => records.filter(record => record.kind === "row" && record.table === name);
    for (const table of ["notebook_entries", "review_cards", "application_preparation_tasks", "drills", "drill_questions"]) expect(rows(finalRecords, table).length, table).toBe(rows(originalRecords, table).length + 1);
    for (const table of ["applications", "application_interviews", "application_interview_questions", "application_interview_recaps"]) expect(rows(finalRecords, table), table).toEqual(rows(originalRecords, table));
  } finally {
    await page.goto("/"); provider.closeAllConnections(); await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
  }
});
