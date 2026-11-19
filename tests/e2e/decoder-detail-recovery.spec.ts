import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";

for (const width of [390, 1280]) {
  for (const { removed, timeout } of [true, false].flatMap(removed => [false, true].map(timeout => ({ removed, timeout })))) {
    test(`解码报告删除恢复 ${width}px：${removed ? "实际删除" : "未执行删除"}，${timeout ? "408 超时" : "异常响应"}后核对`, async ({ page, request }, testInfo) => {
      test.setTimeout(90_000);
      const baseline = await exportEncryptedBackup(request);
      expect(baseline.response.ok()).toBe(true);
      const jd = "弹性工作制，具体协作条件未说明。API_" + "X".repeat(240) + " <T> &amp;";
      const question = "API_".repeat(30) + " <T> &amp;\n具体条件尚未确认？";
      const result = {
        target_summary: "Summary_".repeat(3), punchline: "仅凭岗位文本不能确认实际工作安排。", overall_risk_score: 50,
        risk_ratings: { overtime: 4, stability: 4, resources: 4, management: 4 },
        items: [{ keyword: "弹性工作制", surface_meaning: "时间安排可能灵活。", hidden_meaning: "需要核实核心协作时段与值班安排。",
          risk_level: "medium", risk_category: "Category_".repeat(4), warning: "若要求持续响应，休息可能受影响。",
          interview_rule: "如实表达时间边界。", counter_questions: [question] }],
        company_profile: { team_style: "信息不足", risk_flags: ["Flag_".repeat(6)], culture_summary: "实际工时、支持条件与补偿均需核实。" },
        golden_questions: ["最近一次值班如何安排？", "如何确定核心协作时段？"],
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
          base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-decoder-detail-key",
          api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic",
        } })).ok()).toBe(true);
        const ids: number[] = [];
        for (let i = 0; i < 2; i++) {
          const response = await request.post("/api/tools/jargon-decodings", { data: { text: `${jd}\n记录${i}` } });
          expect(response.status(), await response.text()).toBe(201);
          ids.push((await response.json()).id);
        }
        const endpoint = `/api/tools/jargon-decodings/${ids[0]}`;
        const otherEndpoint = `/api/tools/jargon-decodings/${ids[1]}`;
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
        await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/tools/decoder/${ids[0]}`);
        await expect(page.getByRole("heading", { level: 1 })).toContainText(result.target_summary);
        await page.getByText("查看原始 JD / 输入文本", { exact: true }).click();
        expect(await page.getByRole("region", { name: "原始输入文本", exact: true }).textContent()).toBe(`${jd}\n记录0`);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`decoder-detail-${width}.png`), fullPage: true });
        await page.getByRole("button", { name: "复制", exact: true }).click();
        await expect.poll(() => page.evaluate(async () => (await navigator.clipboard.readText()).replace(/\r\n/g, "\n"))).toBe(question);
        const remove = page.getByRole("button", { name: "删除报告", exact: true });
        await remove.click();
        await page.getByRole("dialog", { name: "删除记录" }).getByRole("button", { name: "取消", exact: true }).click();
        expect(deletes).toBe(0);
        await remove.click();
        await page.getByRole("dialog", { name: "删除记录" }).getByRole("button", { name: "删除", exact: true }).click();
        await expect(page.getByRole("alert").filter({ hasText: "删除结果尚未确认" })).toBeVisible();
        await expect(remove).toBeDisabled();
        await expect(page.getByRole("button", { name: "删除本份报告", exact: true })).toBeDisabled();
        expect(deletes).toBe(1);
        expect((await request.get(endpoint)).status()).toBe(removed ? 404 : 200);
        await page.screenshot({ path: testInfo.outputPath(`decoder-delete-unknown-${width}.png`) });
        await page.getByRole("button", { name: "重新读取删除状态", exact: true }).click();
        if (!removed) {
          await expect(page.getByRole("alert").filter({ hasText: "记录目前仍存在" })).toBeVisible();
          await expect(remove).toBeEnabled();
          expect(deletes).toBe(1);
          await remove.click();
          await page.getByRole("dialog", { name: "删除记录" }).getByRole("button", { name: "删除", exact: true }).click();
        }
        await expect(page).toHaveURL(/\/tools\/decoder$/);
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
