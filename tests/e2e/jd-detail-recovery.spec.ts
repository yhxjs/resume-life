import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";

for (const width of [390, 1280]) {
  for (const { removed, timeout } of [true, false].flatMap(removed => [false, true].map(timeout => ({ removed, timeout })))) {
    test(`JD 删除恢复 ${width}px：${removed ? "实际删除" : "未执行删除"}，${timeout ? "408 超时" : "异常响应"}后核对`, async ({ page, request }, testInfo) => {
      test.setTimeout(90_000);
      const baseline = await exportEncryptedBackup(request);
      expect(baseline.response.ok()).toBe(true);
      const jd = "仅参与维护，未上线。API_" + "X".repeat(240) + " <T> &amp;";
      const result = {
        role: "Role_".repeat(6),
        must_skills: [{ name: "LongSkill_".repeat(8), weight: 7, why: "只按 JD 准备，不能认定已掌握。" }],
        followups: [{ topic: "Topic_".repeat(6), questions: ["API_".repeat(26) + "如何验证？"] }],
        company_style: { style: "信息不足，尚需核实。", signals: [] },
      };
      const provider = createServer(async (incoming, outgoing) => {
        for await (const chunk of incoming) void chunk;
        outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
        outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(result) } }] })}\n\ndata: [DONE]\n\n`);
      });
      await listenForFetch(provider);
      const address = provider.address();
      if (!address || typeof address === "string") throw new Error("Missing provider address");
      try {
        expect((await request.put("/api/settings", { data: {
          base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-jd-detail-key",
          api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic",
        } })).ok()).toBe(true);
        const ids: number[] = [];
        for (let i = 0; i < 2; i++) {
          const response = await request.post("/api/tools/jd-portraits", { data: { jd: `${jd}\n记录${i}` } });
          expect(response.status(), await response.text()).toBe(201);
          ids.push((await response.json()).id);
        }
        const endpoint = `/api/tools/jd-portraits/${ids[0]}`;
        const otherEndpoint = `/api/tools/jd-portraits/${ids[1]}`;
        const other = await (await request.get(otherEndpoint)).json();
        let deletes = 0;
        let checks = 0;
        await page.route(`**${endpoint}`, async (route) => {
          if (route.request().method() === "DELETE") {
            deletes++;
            if (!removed && deletes === 1) return route.fulfill({ status: timeout ? 408 : 503, json: { error: "合成删除未执行" } });
            const response = await route.fetch();
            expect(response.status()).toBe(200);
            if (removed) return timeout ? route.fulfill({ status: 408, json: { error: "合成删除已执行，等待超时" } }) : route.fulfill({ status: 200, body: "{broken" });
            return route.fulfill({ response });
          }
          if (deletes > 0 && ++checks === 1) return route.fulfill({ status: 503, json: { error: "合成状态读取失败" } });
          return route.continue();
        });
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/tools/jd/${ids[0]}`);
        await expect(page.getByRole("heading", { level: 1 })).toContainText(result.role);
        await page.getByText("查看完整原始 JD 文本要求", { exact: true }).click();
        expect(await page.getByRole("region", { name: "原始 JD", exact: true }).textContent()).toBe(`${jd}\n记录0`);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`jd-detail-${width}.png`), fullPage: true });
        const remove = page.getByRole("button", { name: "删除画像", exact: true });
        await remove.click();
        await page.getByRole("dialog", { name: "删除记录" }).getByRole("button", { name: "取消", exact: true }).click();
        expect(deletes).toBe(0);
        await remove.click();
        await page.getByRole("dialog", { name: "删除记录" }).getByRole("button", { name: "删除", exact: true }).click();
        await expect(page.getByRole("alert").filter({ hasText: "删除结果尚未确认" })).toBeVisible();
        await expect(remove).toBeDisabled();
        expect(deletes).toBe(1);
        expect((await request.get(endpoint)).status()).toBe(removed ? 404 : 200);
        await page.screenshot({ path: testInfo.outputPath(`jd-delete-unknown-${width}.png`) });
        await page.getByRole("button", { name: "重新读取删除状态", exact: true }).click();
        if (!removed) {
          await expect(page.getByRole("alert").filter({ hasText: "记录目前仍存在" })).toBeVisible();
          await expect(remove).toBeEnabled();
          expect(deletes).toBe(1);
          await remove.click();
          await page.getByRole("dialog", { name: "删除记录" }).getByRole("button", { name: "删除", exact: true }).click();
        }
        await expect(page).toHaveURL(/\/tools\/jd$/);
        expect(deletes).toBe(removed ? 1 : 2);
        expect((await request.get(endpoint)).status()).toBe(404);
        expect(await (await request.get(otherEndpoint)).json()).toEqual(other);
      } finally {
        provider.closeAllConnections();
        await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
        expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
      }
    });
  }
}
