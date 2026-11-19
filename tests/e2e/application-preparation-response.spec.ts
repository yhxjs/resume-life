import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup, rewriteEncryptedBackup } from "./backup-helpers";
import type { RowRecord } from "../../src/lib/backup-records";

for (const width of [390, 1280]) test(`准备页回包 ${width}px：串投递拒绝、坏确认保留草稿与只读核对`, async ({ page, request }, testInfo) => {
  test.setTimeout(120_000);
  const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
  const provider = createServer(async (incoming, outgoing) => {
    for await (const chunk of incoming) void chunk;
    const result = { role: "接口开发，级别未明确", must_skills: [], followups: [], company_style: { style: "材料不足，无法推断", signals: [] } };
    outgoing.writeHead(200, { "Content-Type": "text/event-stream" }); outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(result) } }] })}\n\ndata: [DONE]\n\n`);
  });
  await listenForFetch(provider); const address = provider.address(); if (!address || typeof address === "string") throw new Error("Missing provider address");
  try {
    expect((await request.put("/api/settings", { data: { base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-preparation-response", api_format: "openai_chat", model_evaluate: "synthetic", model_question: "synthetic" } })).ok()).toBe(true);
    const appResponse = await request.post("/api/applications", { data: { company: "当前公司 <T> &amp;", role: "接口开发", jd: "接口维护" } }); expect(appResponse.status()).toBe(201); const appId = (await appResponse.json()).id;
    const otherResponse = await request.post("/api/applications", { data: { company: "另一投递绝不能显示", role: "另一岗位", jd: "另一个 JD" } }); expect(otherResponse.status()).toBe(201); const otherId = (await otherResponse.json()).id;
    const portraitResponse = await request.post("/api/tools/jd-portraits", { data: { jd: "用于确认恢复的原始岗位 <T> &amp;" } }); expect(portraitResponse.status(), await portraitResponse.text()).toBe(201); const portraitId = (await portraitResponse.json()).id;
    const base = `/api/applications/${appId}/preparation`; const otherSnapshot = await (await request.get(`/api/applications/${otherId}/preparation`)).json();
    const read = async () => { const response = await request.get(base); expect(response.ok()).toBe(true); return response.json(); };
    const records = async () => { let rows: RowRecord[] = []; const backup = await exportEncryptedBackup(request); expect(backup.response.ok()).toBe(true); await rewriteEncryptedBackup(backup.bytes, entries => { rows = entries.filter((row): row is RowRecord => row.kind === "row"); }); return rows; };
    const before = await records(); let readMode: "foreign" | "normal" | "fail" = "foreign"; const methods: string[] = [];
    await page.route(`**${base}`, async route => {
      if (readMode === "foreign") await route.fulfill({ status: 200, json: otherSnapshot });
      else if (readMode === "fail") await route.fulfill({ status: 503, json: { error: "资料读取暂不可用" } }); else await route.continue();
    });
    await page.route(`**${base}/tasks`, async route => { const method = route.request().method(); methods.push(method); const response = await route.fetch(); expect(response.ok()).toBe(true); await route.fulfill({ status: 200, json: method === "POST" ? {} : { ok: false } }); });
    await page.route(`**${base}/resources`, async route => { const method = route.request().method(); methods.push(method); const response = await route.fetch(); expect(response.ok()).toBe(true); await route.fulfill({ status: 200, json: method === "POST" ? { ok: true, preparation: otherSnapshot } : { ok: false, preparation: (await response.json()).preparation } }); });
    await page.setViewportSize({ width, height: 900 }); await page.goto(`/applications/${appId}/prepare`);
    await expect(page.getByRole("alert").filter({ has: page.getByRole("button", { name: "重新加载", exact: true }) })).toContainText("投递不符"); await expect(page.getByRole("heading", { name: /另一投递绝不能显示/ })).toHaveCount(0); expect(methods).toEqual([]);
    readMode = "normal"; await page.getByRole("button", { name: "重新加载", exact: true }).click(); await expect(page.getByRole("heading", { name: "当前公司 <T> &amp; · 接口开发", exact: true })).toBeVisible();
    const tasks = page.getByRole("region", { name: "准备待办", exact: true }); const input = tasks.getByRole("textbox", { name: "新待办", exact: true }); const add = tasks.getByRole("button", { name: "添加", exact: true });
    const title = "未保存原话 <T> &amp;，尚未上线，内部  空格"; await input.fill(title); await add.click();
    const alert = page.getByRole("alert").filter({ has: page.getByRole("button", { name: "刷新资料", exact: true }) }); const refresh = alert.getByRole("button", { name: "刷新资料", exact: true });
    await expect(alert).toContainText("写入结果尚未确认"); await expect(input).toHaveValue(title); await expect(add).toBeDisabled(); expect(methods).toEqual(["POST"]); expect((await read()).tasks).toHaveLength(1);
    await expect(page.getByText("添加待办成功", { exact: true })).toHaveCount(0); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: testInfo.outputPath(`preparation-unconfirmed-${width}.png`), animations: "disabled" });
    for (const mode of ["foreign", "fail"] as const) {
      readMode = mode; await refresh.click(); await expect(alert).toContainText("资料刷新失败"); await expect(add).toBeDisabled(); await expect(input).toHaveValue(title); await expect(page.getByRole("heading", { name: /另一投递绝不能显示/ })).toHaveCount(0); expect(methods).toEqual(["POST"]);
    }
    readMode = "normal"; await refresh.click(); await expect(alert).toHaveCount(0); await expect(tasks.getByRole("checkbox", { name: title, exact: true })).toBeVisible(); await expect(input).toHaveValue(title); expect(methods).toEqual(["POST"]); await input.fill("");
    const checkbox = tasks.getByRole("checkbox", { name: title, exact: true }); await checkbox.check(); await expect(alert).toContainText("写入结果尚未确认"); await expect(checkbox).toBeDisabled(); await expect(checkbox).not.toBeChecked(); expect((await read()).tasks[0].done).toBe(true);
    await refresh.click(); await expect(alert).toHaveCount(0); await expect(checkbox).toBeChecked();
    await tasks.getByRole("button", { name: `删除待办：${title}`, exact: true }).click(); await expect(alert).toContainText("写入结果尚未确认"); await expect(checkbox).toBeVisible(); expect((await read()).tasks).toHaveLength(0);
    await refresh.click(); await expect(alert).toHaveCount(0); await expect(checkbox).toHaveCount(0); expect(methods).toEqual(["POST", "PATCH", "DELETE"]);
    await page.getByRole("button", { name: "关联已有JD 考点画像", exact: true }).click(); const picker = page.getByRole("dialog", { name: "关联已有JD 考点画像", exact: true }); await picker.getByRole("button", { name: "关联", exact: true }).click();
    await expect(picker.getByRole("alert")).toContainText("关联结果尚未确认"); await expect(picker.getByRole("button", { name: "关联", exact: true })).toBeDisabled(); await expect(picker.getByRole("button", { name: "重试关联", exact: true })).toHaveCount(0); await expect(picker).toBeVisible(); await picker.getByRole("button", { name: "关闭", exact: true }).click(); await expect(alert).toContainText("投递不符");
    await expect(page.getByRole("heading", { name: /另一投递绝不能显示/ })).toHaveCount(0); expect((await read()).resources.portrait.items.map((item: { id: number }) => item.id)).toEqual([portraitId]);
    await refresh.click(); await expect(alert).toHaveCount(0); const portraits = page.getByRole("region", { name: "JD 考点画像", exact: true }); await expect(portraits.getByRole("heading", { name: "用于确认恢复的原始岗位 <T> &amp;", exact: true })).toBeVisible();
    await portraits.getByRole("button", { name: "取消关联", exact: true }).click(); await expect(alert).toContainText("写入结果尚未确认"); await expect(portraits.getByRole("button", { name: "取消关联", exact: true })).toBeDisabled();
    await refresh.click(); await expect(alert).toHaveCount(0); await expect(portraits.getByRole("button", { name: "取消关联", exact: true })).toHaveCount(0); expect(methods).toEqual(["POST", "PATCH", "DELETE", "POST", "DELETE"]);
    expect(await records()).toEqual(before); expect(await (await request.get(`/api/applications/${otherId}/preparation`)).json()).toEqual(otherSnapshot);
  } finally {
    await page.goto("/"); await page.unrouteAll({ behavior: "wait" }); provider.closeAllConnections(); await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
  }
});
