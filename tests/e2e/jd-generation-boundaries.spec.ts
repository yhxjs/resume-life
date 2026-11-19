import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import { gate } from "./synthetic-api";

for (const width of [390, 1280]) {
  for (const loseResponse of [false, true]) {
    test(`JD 生成 ${width}px：提交等待保护原文，${loseResponse ? "损坏成功响应后从历史核对存档" : "无效输出后显式重试"}`, async ({ page, request }, testInfo) => {
      test.setTimeout(90_000);
      const baseline = await exportEncryptedBackup(request);
      expect(baseline.response.ok()).toBe(true);
      const release = gate();
      const jd = "React 或 Vue 任选其一，不要求 Java。\n未来可能研究 API_" + "X".repeat(200) + " <T> &amp;";
      const skill = "React_or_Vue_".repeat(6);
      const result = {
        role: "岗位方向_".repeat(6),
        must_skills: [{ name: skill, weight: 8, why: "JD 明确任选其一，不要求同时掌握；Java 不列为本岗要求。" }],
        followups: [{ topic: "框架选择练习", questions: ["假设维护现有页面，你会如何比较两种框架的适用条件？"] }],
        company_style: { style: "协作方式未明确，无法判断实际团队文化。", signals: [] },
      };
      let calls = 0;
      let entered = false;
      const provider = createServer(async (incoming, outgoing) => {
        for await (const chunk of incoming) void chunk;
        calls += 1;
        const current = calls;
        entered = true;
        if (current === 1) await release.promise;
        const reply = !loseResponse && current === 1 ? { role: "无效画像不应保存" } : result;
        outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
        outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(reply) } }] })}\n\ndata: [DONE]\n\n`);
      });
      await listenForFetch(provider);
      const address = provider.address();
      if (!address || typeof address === "string") throw new Error("Missing provider address");
      try {
        expect((await request.put("/api/settings", { data: {
          base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-jd-generation-key",
          api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic",
        } })).ok()).toBe(true);
        const before = await (await request.get("/api/tools/jd-portraits")).json();
        let writes = 0;
        let savedId = 0;
        await page.route("**/api/tools/jd-portraits", async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          writes += 1;
          expect(route.request().postDataJSON()).toEqual({ jd });
          const response = await route.fetch();
          if (response.status() === 201) {
            savedId = (await response.json()).id;
            if (loseResponse) return route.fulfill({ status: 201, json: { id: "invalid" } });
          }
          return route.fulfill({ response });
        });
        await page.setViewportSize({ width, height: 900 });
        await page.goto("/tools/jd");
        const input = page.getByRole("textbox", { name: "岗位要求（JD）", exact: true });
        await input.fill(jd);
        await page.getByRole("button", { name: "生成准备画像 →", exact: true }).click();
        await expect.poll(() => entered).toBe(true);
        await expect(input).toBeDisabled();
        await expect(input).toHaveValue(jd);
        for (const name of ["大厂资深前端/架构", "高并发分布式后端", "AI+全栈应用开发"]) {
          await expect(page.getByRole("button", { name, exact: true })).toBeDisabled();
        }
        const waiting = page.getByRole("status").filter({ hasText: "AI 正在整理 JD 准备建议" });
        await expect(waiting).toContainText("公司风格属于待核实推测");
        await expect(waiting).not.toContainText("必考");
        expect(calls).toBe(1);
        expect(writes).toBe(1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await waiting.scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath(`jd-generation-${width}.png`) });
        release.release();
        const error = page.getByRole("alert").filter({ hasText: loseResponse ? "生成响应不完整" : "AI 生成结果异常" });
        await expect(error).toBeVisible();
        await expect(input).toHaveValue(jd);
        await expect(input).toBeEnabled();
        if (loseResponse) {
          const history = page.locator(`a[href="/tools/jd/${savedId}"]`).filter({ hasText: "查看画像" });
          await expect(history).toBeVisible();
          await expect(page.getByText(`${skill} · 准备优先级 8/10`, { exact: true })).toBeVisible();
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          await history.click();
        } else {
          expect(await (await request.get("/api/tools/jd-portraits")).json()).toEqual(before);
          await page.getByRole("button", { name: "生成准备画像 →", exact: true }).click();
          await expect.poll(() => savedId).toBeGreaterThan(0);
        }
        await expect(page).toHaveURL(new RegExp(`/tools/jd/${savedId}$`));
        await expect(page.getByText("依据 JD 安排准备顺序，分数不代表实际面试的必考概率。", { exact: true })).toBeVisible();
        const stored = await request.get(`/api/tools/jd-portraits/${savedId}`);
        expect(stored.status()).toBe(200);
        const data = await stored.json();
        expect(data.jd).toBe(jd);
        expect(data.result.mustSkills[0]).toMatchObject({ name: skill, weight: 8 });
        expect(data.result.companyStyle.style).toBe(result.company_style.style);
        await page.getByText("查看完整原始 JD 文本要求", { exact: true }).click();
        expect(await page.getByRole("region", { name: "原始 JD", exact: true }).textContent()).toBe(jd);
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
