import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import { gate } from "./synthetic-api";

for (const width of [390, 1280]) {
  for (const loseResponse of [false, true]) {
    test(`解码生成 ${width}px：提交等待保护原文，${loseResponse ? "损坏成功响应后从历史核对存档" : "无效输出后显式重试"}`, async ({ page, request }, testInfo) => {
      test.setTimeout(90_000);
      const baseline = await exportEncryptedBackup(request);
      expect(baseline.response.ok()).toBe(true);
      const release = gate();
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
      let calls = 0;
      let entered = false;
      const provider = createServer(async (incoming, outgoing) => {
        for await (const chunk of incoming) void chunk;
        calls += 1;
        const current = calls;
        entered = true;
        if (current === 1) await release.promise;
        const reply = !loseResponse && current === 1 ? { target_summary: "无效解码不应保存" } : result;
        outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
        outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(reply) } }] })}\n\ndata: [DONE]\n\n`);
      });
      await listenForFetch(provider);
      const address = provider.address();
      if (!address || typeof address === "string") throw new Error("Missing provider address");
      try {
        expect((await request.put("/api/settings", { data: {
          base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-decoder-generation-key",
          api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic",
        } })).ok()).toBe(true);
        const before = await (await request.get("/api/tools/jargon-decodings")).json();
        let writes = 0;
        let savedId = 0;
        await page.route("**/api/tools/jargon-decodings", async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          writes += 1;
          expect(route.request().postDataJSON()).toEqual({ text: jd });
          const response = await route.fetch();
          if (response.status() === 201) {
            savedId = (await response.json()).id;
            if (loseResponse) return route.fulfill({ status: 201, json: { id: "invalid" } });
          }
          return route.fulfill({ response });
        });
        await page.setViewportSize({ width, height: 900 });
        await page.goto("/tools/decoder");
        const input = page.getByRole("textbox", { name: "待解码的 JD 文本或面试原话", exact: true });
        await input.fill(jd);
        await page.getByRole("button", { name: "抗压能力强", exact: true }).click();
        await page.getByRole("button", { name: "启动暗号解码器 →", exact: true }).click();
        await expect.poll(() => entered).toBe(true);
        await expect(input).toBeDisabled();
        await expect(input).toHaveValue(jd);
        for (const name of ["填入经典黑话 JD 示例 ↗", "+ 加到输入框", "清空内容"]) {
          await expect(page.getByRole("button", { name, exact: true })).toBeDisabled();
        }
        const waiting = page.getByRole("status").filter({ hasText: "正在分析文本线索与待核实条件" });
        await expect(waiting).toContainText("不确认公司实际情况");
        await expect(waiting).not.toContainText("必考");
        expect(calls).toBe(1);
        expect(writes).toBe(1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await waiting.scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath(`decoder-generation-${width}.png`) });
        release.release();
        const error = page.getByRole("alert").filter({ hasText: loseResponse ? "生成响应不完整" : "AI 解码结果异常" });
        await expect(error).toBeVisible();
        await expect(input).toHaveValue(jd);
        await expect(input).toBeEnabled();
        if (loseResponse) {
          const history = page.locator(`a[href="/tools/decoder/${savedId}"]`).filter({ hasText: "查看报告" });
          await expect(history).toBeVisible();
          await expect(page.getByText("存在待核实信号 (50分)", { exact: true })).toBeVisible();
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          await history.click();
        } else {
          expect(await (await request.get("/api/tools/jargon-decodings")).json()).toEqual(before);
          await page.getByRole("button", { name: "启动暗号解码器 →", exact: true }).click();
          await expect.poll(() => savedId).toBeGreaterThan(0);
        }
        await expect(page).toHaveURL(new RegExp(`/tools/decoder/${savedId}$`));
        await expect(page.getByRole("heading", { level: 1 })).toContainText(result.target_summary);
        const stored = await request.get(`/api/tools/jargon-decodings/${savedId}`);
        expect(stored.status()).toBe(200);
        const data = await stored.json();
        expect(data.source_text).toBe(jd);
        expect(data.result.items[0].counterQuestions).toEqual([question]);
        expect(data.result.companyProfile.cultureSummary).toBe(result.company_profile.culture_summary);
        await page.getByText("查看原始 JD / 输入文本", { exact: true }).click();
        expect(await page.getByRole("region", { name: "原始输入文本", exact: true }).textContent()).toBe(jd);
        expect(writes).toBe(loseResponse ? 1 : 2);
        expect(calls).toBe(loseResponse ? 1 : 2);
      } finally {
        release.release();
        provider.closeAllConnections();
        await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
        expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
      }
    });
  }
}
