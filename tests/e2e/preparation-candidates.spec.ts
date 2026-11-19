import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup, rewriteEncryptedBackup } from "./backup-helpers";
import type { RowRecord } from "../../src/lib/backup-records";

for (const width of [390, 1280]) test(`关联候选 ${width}px：坏页拒绝、原游标重读与未知关联保护`, async ({ page, request }, testInfo) => {
  test.setTimeout(120_000);
  const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
  const provider = createServer(async (incoming, outgoing) => {
    for await (const chunk of incoming) void chunk;
    const result = { role: "接口开发，级别未明确", must_skills: [], followups: [], company_style: { style: "材料不足，无法推断", signals: [] } };
    outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
    outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(result) } }] })}\n\ndata: [DONE]\n\n`);
  });
  await listenForFetch(provider);
  const address = provider.address(); if (!address || typeof address === "string") throw new Error("Missing provider address");
  try {
    expect((await request.put("/api/settings", { data: { base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-preparation-candidates", api_format: "openai_chat", model_evaluate: "synthetic", model_question: "synthetic" } })).ok()).toBe(true);
    const appResponse = await request.post("/api/applications", { data: { company: "候选列表核对", role: "接口开发", jd: "接口维护" } });
    expect(appResponse.status()).toBe(201); const appId = (await appResponse.json()).id;
    const ids: number[] = [];
    for (let index = 1; index <= 21; index++) {
      const response = await request.post("/api/tools/jd-portraits", { data: { jd: `候选${index} Array<T> &amp;，尚未上线` } });
      expect(response.status(), await response.text()).toBe(201); ids.push((await response.json()).id);
    }
    const base = `/api/applications/${appId}/preparation`;
    const records = async () => {
      let rows: RowRecord[] = []; const backup = await exportEncryptedBackup(request); expect(backup.response.ok()).toBe(true);
      await rewriteEncryptedBackup(backup.bytes, entries => { rows = entries.filter((row): row is RowRecord => row.kind === "row"); }); return rows;
    };
    const before = await records(); const cursors: (string | null)[] = []; const writes: string[] = [];
    await page.route(new RegExp(`${base}/resources(?:\\?.*)?$`), async route => {
      const method = route.request().method(); const response = await route.fetch(); expect(response.ok()).toBe(true);
      if (method === "GET") {
        const url = new URL(route.request().url()); expect(url.searchParams.get("candidates")).toBe("true"); cursors.push(url.searchParams.get("cursor"));
        const result = await response.json();
        if (cursors.length === 1) result.items[0].href = `/intros/${result.items[0].id}`;
        if (cursors.length === 3) { result.items = [{ ...result.items[0], id: ids.at(-1), href: `/tools/jd/${ids.at(-1)}` }]; result.nextCursor = null; }
        await route.fulfill({ response, json: result });
      } else {
        writes.push(method); await route.fulfill({ status: 200, json: { ok: false } });
      }
    });
    await page.setViewportSize({ width, height: 900 }); await page.goto(`/applications/${appId}/prepare`);
    await page.getByRole("button", { name: "关联已有JD 考点画像", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "关联已有JD 考点画像", exact: true });
    await expect(picker.getByRole("alert")).toContainText("链接与记录不符");
    await expect(picker.getByRole("button", { name: "关联", exact: true })).toHaveCount(0); expect(writes).toEqual([]);
    await picker.getByRole("button", { name: "重试加载列表", exact: true }).click();
    await expect(picker.getByRole("button", { name: "关联", exact: true })).toHaveCount(20);
    await picker.getByRole("button", { name: "加载更多", exact: true }).click();
    await expect(picker.getByRole("alert")).toContainText("顺序无效");
    await expect(picker.getByRole("button", { name: "关联", exact: true })).toHaveCount(20);
    await picker.getByRole("button", { name: "重试加载更多", exact: true }).click();
    await expect(picker.getByRole("button", { name: "关联", exact: true })).toHaveCount(21);
    expect(cursors).toEqual([null, null, String(ids[1]), String(ids[1])]); expect(writes).toEqual([]);
    await expect(picker.getByRole("heading", { name: "候选1 Array<T> &amp;，尚未上线", exact: true })).toBeVisible();
    await picker.getByRole("button", { name: "关联", exact: true }).first().click();
    await expect(picker.getByRole("alert")).toContainText("关联结果尚未确认，请关闭此窗口并刷新资料核对");
    await expect(picker.getByRole("button", { name: "重试关联", exact: true })).toHaveCount(0);
    const associate = picker.getByRole("button", { name: "关联", exact: true });
    for (let index = 0; index < 21; index++) await expect(associate.nth(index)).toBeDisabled();
    expect(writes).toEqual(["POST"]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`candidate-unconfirmed-${width}.png`), animations: "disabled" });
    await picker.getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("button", { name: "刷新资料", exact: true }).click();
    const portraits = page.getByRole("region", { name: "JD 考点画像", exact: true });
    await expect(portraits.getByRole("heading", { name: "候选21 Array<T> &amp;，尚未上线", exact: true })).toBeVisible();
    expect(writes).toEqual(["POST"]);
    const unlink = await request.delete(`${base}/resources`, { data: { kind: "portrait", id: ids.at(-1) } }); expect(unlink.ok()).toBe(true);
    expect(await records()).toEqual(before);
  } finally {
    await page.goto("/"); await page.unrouteAll({ behavior: "wait" });
    provider.closeAllConnections(); await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
  }
});
