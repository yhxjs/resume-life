import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";

const opening = { initial_offer: "模拟方案，奖金尚未确认", hr_response: "模拟 HR 开场：请核对保证收入", hr_tactics: "澄清",
  hr_mindset: { looseness: 20, current_attitude: "模拟态度", estimated_package: "模拟方案", tactics_label: "模拟澄清", internal_pressure: "模拟预算" },
  mentor_analysis: { user_argument_score: 5, strengths: ["已有期望"], vulnerabilities: ["薪数未知"], tactical_tips: "核对保证收入",
    suggested_replies: [{ title: "核对", content: "请确认保证薪数", rationale: "区分保证与浮动" }] } };
const report = { final_package_summary: "模拟结束，尚未达成", score: 75, leverage_efficiency: "保证收入仍待核实", turn_critiques: [], real_world_tips: ["核对书面方案"], mentor_summary: "只是模拟练习" };

for (const width of [390, 1280]) {
  test(`谈薪历史删除 ${width}px：取消零写入，坏响应只读恢复，旧列表不能复活已删记录`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000);
    const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
    let finalizing = false; let modelCalls = 0;
    const provider = createServer(async (incoming, outgoing) => {
      let body = ""; for await (const chunk of incoming) body += chunk;
      modelCalls++; const reply = finalizing ? report : opening;
      if (JSON.parse(body).stream) {
        outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
        outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(reply) } }] })}\n\ndata: [DONE]\n\n`);
      } else {
        outgoing.writeHead(200, { "Content-Type": "application/json" });
        outgoing.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(reply) } }] }));
      }
    });
    await listenForFetch(provider);
    const address = provider.address(); if (!address || typeof address === "string") throw new Error("Missing provider address");
    try {
      expect((await request.put("/api/settings", { data: { base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-salary-deletion-key",
        api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic" } })).ok()).toBe(true);
      const endpoint = "/api/tools/salary-negotiations"; const ids: number[] = [];
      const title = "Role_".repeat(30) + "原始岗位 <T> &amp;";
      for (let index = 0; index < 2; index++) {
        const created = await request.post(endpoint, { data: { target_role: index === 0 ? title : "完整保留的另一场演练", expected_salary: "税前30k，薪数待确认" } });
        expect(created.status()).toBe(201); ids.push((await created.json()).id);
      }
      finalizing = true;
      const original = await (await request.get(`${endpoint}/${ids[0]}`)).json();
      expect((await request.post(`${endpoint}/${ids[0]}/finalize`, { data: { expected_revision: original.revision } })).status()).toBe(200); expect(modelCalls).toBe(3);
      const before = await (await request.get(endpoint)).json(); const other = await (await request.get(`${endpoint}/${ids[1]}`)).json();
      const firstEndpoint = `${endpoint}/${ids[0]}`;
      let deletes = 0; let checks = 0; let refreshes = 0;
      await page.route(`**${endpoint}**`, async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === firstEndpoint && route.request().method() === "DELETE") {
          deletes++; const response = await route.fetch(); expect(response.status()).toBe(200);
          return route.fulfill({ json: { ok: false } });
        }
        if (path === firstEndpoint && deletes > 0) {
          checks++;
          if (checks === 1) return route.fulfill({ status: 503, json: { error: "合成删除核对失败" } });
          if (checks === 2) return route.fulfill({ json: other });
        }
        if (path === endpoint && deletes > 0) {
          refreshes++;
          if (refreshes === 1) return route.fulfill({ status: 503, json: { error: "合成历史刷新失败" } });
          // 页面会话确认已删的 ID 即使出现在旧列表，也不能复活。
          return route.fulfill({ json: before });
        }
        return route.continue();
      });
      await page.setViewportSize({ width, height: 900 }); await page.goto("/tools/salary");
      const first = page.getByRole("group", { name: `谈薪演练 #${ids[0]}`, exact: true });
      const second = page.getByRole("group", { name: `谈薪演练 #${ids[1]}`, exact: true });
      await expect(first).toBeVisible(); await expect(second).toBeVisible();
      const draft = "未提交的新岗位 <T> &amp;";
      const input = page.getByRole("textbox", { name: "目标岗位与职级（必填）", exact: true }); await input.fill(draft);
      await first.getByRole("button", { name: "删除", exact: true }).click();
      const confirmation = page.getByRole("dialog", { name: "删除历史记录", exact: true });
      await expect(confirmation).toContainText(`谈薪演练 #${ids[0]}「${title}」`);
      await expect(confirmation).toContainText("所有谈判回合及复盘将一并清除");
      await expect(page.getByRole("button", { name: "开局！进入薪资博弈对决", exact: true })).toBeDisabled();
      await confirmation.getByRole("button", { name: "取消", exact: true }).click(); expect(deletes).toBe(0); await expect(input).toHaveValue(draft);
      await first.getByRole("button", { name: "删除", exact: true }).click();
      await confirmation.getByRole("button", { name: "删除", exact: true }).click();
      const alert = page.getByRole("alert").filter({ hasText: "删除结果尚未确认" });
      await expect(alert).toContainText("合成删除核对失败");
      await expect(first.getByRole("button", { name: "删除", exact: true })).toBeDisabled();
      await expect(second.getByRole("button", { name: "删除", exact: true })).toBeDisabled(); await expect(input).toHaveValue(draft);
      const retry = page.getByRole("button", { name: "重新读取删除状态", exact: true });
      await retry.click(); await expect(alert).toContainText("历史记录结构异常");
      expect(deletes).toBe(1); expect(checks).toBe(2); expect(modelCalls).toBe(3);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`salary-delete-unknown-${width}.png`), fullPage: true });
      await retry.click();
      await expect(page.getByRole("alert").filter({ hasText: "谈判历史加载失败：合成历史刷新失败" })).toBeVisible();
      expect((await request.get(firstEndpoint)).status()).toBe(404);
      await page.getByRole("button", { name: "重试加载", exact: true }).click();
      await expect(first).toHaveCount(0); await expect(second).toBeVisible();
      await expect(second.getByRole("button", { name: "删除", exact: true })).toBeEnabled();
      await expect(input).toHaveValue(draft); await expect(page.getByRole("button", { name: "开局！进入薪资博弈对决", exact: true })).toBeEnabled();
      expect(deletes).toBe(1); expect(checks).toBe(3); expect(modelCalls).toBe(3); expect(refreshes).toBe(2);
      expect(await (await request.get(`${endpoint}/${ids[1]}`)).json()).toEqual(other);
      expect((await (await request.get(endpoint)).json()).total).toBe(before.total - 1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`salary-delete-recovered-${width}.png`), fullPage: true });
    } finally {
      provider.closeAllConnections(); await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
      expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
    }
  });
}
