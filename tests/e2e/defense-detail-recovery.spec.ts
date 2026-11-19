import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import { gate, mockApi } from "./synthetic-api";

for (const width of [390, 1280]) {
  for (const removed of [true, false]) {
    test(`排雷详情恢复 ${width}px：${removed ? "实际已删后损坏响应" : "串报告核对失败后显式再次删除"}`, async ({ page, request }, testInfo) => {
      test.setTimeout(90_000);
      const baseline = await exportEncryptedBackup(request);
      expect(baseline.response.ok()).toBe(true);
      const quote = "仅参与 API_" + "X".repeat(240) + " <T> &amp;\n未上线。";
      const title = "Report_".repeat(30);
      const question = "Question_".repeat(10) + "如何验证？";
      let drilling = false;
      let modelCalls = 0;
      const provider = createServer(async (incoming, outgoing) => {
        let body = "";
        for await (const chunk of incoming) body += chunk;
        modelCalls++;
        const reply = drilling ? {
          defense_score: 80, interviewer_roast: "说明了分工", defense_critique: "结果待验证", improved_answer: "我仅参与接口校验，尚未上线。",
        } : { risk_level: "medium", overall_roast: "需要核对分工与验证范围", items: [{
          original_text: quote, section_hint: "项目经历", risk_level: "medium", risk_type: "scope_ambiguity",
          interviewer_roast: "请核对个人负责范围", deadly_questions: [question, "你负责哪些部分？"],
          defense_plan: { interviewer_intent: "核对个人分工", standard_defense: "仅说明已确认的事实", taboo_mistakes: ["编造职责和数据"] },
        }] };
        if (JSON.parse(body).stream) {
          outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
          outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(reply) } }] })}\n\ndata: [DONE]\n\n`);
        } else {
          outgoing.writeHead(200, { "Content-Type": "application/json" });
          outgoing.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(reply) } }] }));
        }
      });
      await listenForFetch(provider);
      const address = provider.address();
      if (!address || typeof address === "string") throw new Error("Missing provider address");
      try {
        expect((await request.put("/api/settings", { data: {
          base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-defense-detail-key",
          api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic",
        } })).ok()).toBe(true);
        const ids: number[] = [];
        for (let index = 0; index < 2; index++) {
          drilling = false;
          const created = await request.post("/api/tools/resume-defenses", { data: {
            title: title + index, resumeContent: quote, targetRole: "Role_".repeat(25),
          } });
          expect(created.status(), await created.text()).toBe(200);
          const report = await created.json(); ids.push(report.id);
          drilling = true;
          const drill = await request.post(`/api/tools/resume-defenses/${report.id}/drill`, { data: {
            itemId: report.items[0].id, question, userAnswer: "我只参与接口校验。",
          } });
          expect(drill.status(), await drill.text()).toBe(200);
        }
        const endpoint = `/api/tools/resume-defenses/${ids[0]}`;
        const otherEndpoint = `/api/tools/resume-defenses/${ids[1]}`;
        const other = await (await request.get(otherEndpoint)).json();
        expect(other.drills).toHaveLength(1);
        let deletes = 0;
        let checks = 0;
        await page.route(`**${endpoint}`, async (route) => {
          if (route.request().method() === "DELETE") {
            deletes++;
            if (!removed && deletes === 1) return route.fulfill({ status: 503, json: { error: "合成删除未执行" } });
            const response = await route.fetch();
            expect(response.status()).toBe(200);
            return removed ? route.fulfill({ status: 200, body: "{broken" }) : route.fulfill({ response });
          }
          if (deletes > 0 && ++checks === 1) return route.fulfill(removed
            ? { status: 503, json: { error: "合成状态读取失败" } }
            : { status: 200, json: other });
          return route.continue();
        });
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/tools/defense/${ids[0]}`);
        await expect(page.getByRole("heading", { level: 1 })).toHaveText(title + "0");
        await page.getByText("核对原始引用", { exact: true }).click();
        expect(await page.getByLabel("原始引用", { exact: true }).textContent()).toBe(quote);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const headingBox = await page.getByRole("heading", { level: 1 }).boundingBox();
        const backBox = await page.getByRole("link", { name: "返回排雷工具", exact: true }).boundingBox();
        expect(headingBox).not.toBeNull(); expect(backBox).not.toBeNull();
        expect(Math.abs(backBox!.y - headingBox!.y)).toBeLessThan(8);
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: testInfo.outputPath(`defense-detail-${width}.png`), fullPage: true });
        const remove = page.getByRole("button", { name: "删除报告", exact: true });
        await remove.click();
        const dialog = page.getByRole("dialog", { name: "删除历史记录" });
        await expect(dialog).toContainText(`#${ids[0]}「${title}0」`);
        await expect(dialog).toContainText("相关防御演练记录将一并清除");
        await dialog.getByRole("button", { name: "取消", exact: true }).click();
        expect(deletes).toBe(0);
        await remove.click(); await dialog.getByRole("button", { name: "删除", exact: true }).click();
        await expect(page.getByRole("alert").filter({ hasText: "删除结果尚未确认" })).toBeVisible();
        await expect(remove).toBeDisabled();
        await expect(page.getByRole("button", { name: "查看/重做对练", exact: true })).toBeDisabled();
        expect(deletes).toBe(1); expect(modelCalls).toBe(4);
        expect((await request.get(endpoint)).status()).toBe(removed ? 404 : 200);
        expect(await (await request.get(otherEndpoint)).json()).toEqual(other);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`defense-detail-delete-unknown-${width}.png`) });
        await page.getByRole("button", { name: "重新读取删除状态", exact: true }).click();
        if (!removed) {
          await expect(page.getByRole("alert").filter({ hasText: "目前仍存在" })).toBeVisible();
          await expect(remove).toBeEnabled(); expect(deletes).toBe(1);
          expect((await request.get(endpoint)).status()).toBe(200);
          await remove.click(); await dialog.getByRole("button", { name: "删除", exact: true }).click();
        }
        await expect(page).toHaveURL(/\/tools\/defense$/);
        expect(deletes).toBe(removed ? 1 : 2); expect(checks).toBe(2); expect(modelCalls).toBe(4);
        expect((await request.get(endpoint)).status()).toBe(404);
        expect(await (await request.get(otherEndpoint)).json()).toEqual(other);
      } finally {
        provider.closeAllConnections();
        await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
        expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
      }
    });
  }

  test(`排雷详情读取 ${width}px：串记录不开放操作，只读重试与离页迟到结果隔离`, async ({ page }, testInfo) => {
    await mockApi(page);
    const report = (id: number) => ({ id, resumeId: null, title: `合成报告${id}`, sourceContent: "原稿 <T> &amp;\n尚未上线",
      targetRole: "接口工程师", riskLevel: "low", overallRoast: "本次未发现明确问题，仍需核实", createdAt: "2026-10-29", items: [] });
    const waiting = gate();
    let reads = 0;
    let writes = 0;
    await page.route("**/api/tools/resume-defenses/9010", async (route) => {
      if (route.request().method() !== "GET") writes++;
      reads++;
      if (reads === 1) return route.fulfill({ json: { report: report(9020), drills: [] } });
      await waiting.promise;
      return route.fulfill({ json: { report: report(9010), drills: [] } });
    });
    try {
      await page.setViewportSize({ width, height: 900 }); await page.goto("/tools/defense/9010");
      await expect(page.getByRole("alert").filter({ hasText: "排雷报告响应不完整或记录不符" })).toBeVisible();
      await expect(page.getByRole("button", { name: "删除报告", exact: true })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "合成报告9020" })).toHaveCount(0);
      await page.screenshot({ path: testInfo.outputPath(`defense-detail-read-error-${width}.png`) });
      await page.getByRole("button", { name: "重试加载", exact: true }).click();
      await expect.poll(() => reads).toBe(2);
      await expect(page.getByRole("status", { name: "正在读取简历排雷报告…" })).toBeVisible();
      if (width === 390) await page.getByRole("button", { name: "打开导航菜单", exact: true }).click();
      await page.getByRole("link", { name: "工具箱", exact: true }).click();
      await expect(page).toHaveURL(/\/tools$/); waiting.release();
      await expect(page.getByRole("heading", { name: "合成报告9010" })).toHaveCount(0);
      expect(writes).toBe(0); expect(reads).toBe(2);
      await page.goto("/tools/defense/9010");
      await expect(page.getByRole("heading", { name: "合成报告9010" })).toBeVisible();
      expect(writes).toBe(0); expect(reads).toBe(3);
    } finally { waiting.release(); }
  });
}
