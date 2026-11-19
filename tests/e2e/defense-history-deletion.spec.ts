import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";

const endpoint = "/api/tools/resume-defenses";
const quote = "参与接口校验 <T> &amp;\n尚未上线，不是独立负责。";

for (const width of [390, 1280]) {
  for (const alreadyDeleted of [true, false]) {
    test(`排雷历史删除 ${width}px：${alreadyDeleted ? "已删响应损坏，旧列表不复活" : "核对串记录，明确存在后显式再确认"}`, async ({ page, request }, testInfo) => {
      test.setTimeout(90_000);
      const baseline = await exportEncryptedBackup(request);
      expect(baseline.response.ok()).toBe(true);
      let mode: "scan" | "drill" = "scan";
      let modelCalls = 0;
      const provider = createServer(async (incoming, outgoing) => {
        let body = "";
        for await (const chunk of incoming) body += chunk;
        modelCalls++;
        const reply = mode === "scan" ? {
          risk_level: "medium", overall_roast: "需要核对分工与验证范围", items: [{
            original_text: quote, section_hint: "项目经历", risk_level: "medium", risk_type: "scope_ambiguity",
            interviewer_roast: "请核对个人负责范围", deadly_questions: ["你负责哪些部分？", "如何验证结果？"],
            defense_plan: { interviewer_intent: "核对个人分工", standard_defense: "仅说明已确认的事实", taboo_mistakes: ["编造职责和数据"] },
          }],
        } : {
          defense_score: 80, interviewer_roast: "说明了分工", defense_critique: "结果待验证",
          improved_answer: "我仅参与接口校验，尚未上线。",
        };
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
          base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-defense-history-key",
          api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic",
        } })).ok()).toBe(true);
        const ids: number[] = [];
        const titles: string[] = [];
        for (let index = 0; index < 2; index++) {
          mode = "scan";
          const title = "History_".repeat(30) + index;
          const response = await request.post(endpoint, { data: { title, resumeContent: quote, targetRole: "接口工程师" } });
          expect(response.status(), await response.text()).toBe(200);
          const report = await response.json();
          ids.push(report.id); titles.push(title);
          mode = "drill";
          const drill = await request.post(`${endpoint}/${report.id}/drill`, { data: {
            itemId: report.items[0].id, question: report.items[0].deadlyQuestions[0], userAnswer: "我只参与接口校验。",
          } });
          expect(drill.status(), await drill.text()).toBe(200);
        }
        expect(modelCalls).toBe(4);
        const firstEndpoint = `${endpoint}/${ids[0]}`;
        const secondEndpoint = `${endpoint}/${ids[1]}`;
        const second = await (await request.get(secondEndpoint)).json();
        expect(second.drills).toHaveLength(1);
        const oldList = await (await request.get(endpoint)).json();
        let deletes = 0;
        let checks = 0;
        let failList = false;
        let staleList = false;
        await page.route(`**${endpoint}**`, async (route) => {
          const url = new URL(route.request().url());
          const method = route.request().method();
          if (url.pathname === firstEndpoint && method === "DELETE") {
            deletes++;
            if (!alreadyDeleted && deletes === 1) return route.fulfill({ status: 503, json: { error: "合成删除失败" } });
            const response = await route.fetch();
            expect(response.status()).toBe(200);
            return alreadyDeleted ? route.fulfill({ status: 200, json: { ok: false } }) : route.fulfill({ response });
          }
          if (url.pathname === firstEndpoint && method === "GET" && deletes > 0) {
            checks++;
            if (checks === 1) return route.fulfill(alreadyDeleted
              ? { status: 503, json: { error: "合成状态读取失败" } }
              : { status: 200, json: second });
          }
          if (url.pathname === endpoint && method === "GET") {
            if (failList) return route.fulfill({ status: 503, json: { error: "合成历史刷新失败" } });
            if (staleList) return route.fulfill({ json: oldList });
          }
          return route.continue();
        });
        await page.setViewportSize({ width, height: 900 });
        await page.goto("/tools/defense");
        await page.getByRole("button", { name: "自由粘贴文本", exact: true }).click();
        const input = page.getByRole("textbox", { name: "粘贴简历内容或项目片段：", exact: true });
        const roleInput = page.getByRole("textbox", { name: "目标应聘岗位 / 级别定位（选填）：", exact: true });
        const draft = "未提交原稿 <T> &amp;\n仅核对条件。";
        await input.fill(draft); await roleInput.fill("未提交的目标岗位");
        const firstLink = page.locator(`a[href="/tools/defense/${ids[0]}"]`);
        const secondLink = page.locator(`a[href="/tools/defense/${ids[1]}"]`);
        const firstDelete = firstLink.locator("..").getByRole("button", { name: "删除", exact: true });
        const secondDelete = secondLink.locator("..").getByRole("button", { name: "删除", exact: true });
        await firstDelete.click();
        const dialog = page.getByRole("dialog", { name: "删除历史记录" });
        await expect(dialog).toContainText(`#${ids[0]}「${titles[0]}」`);
        await expect(dialog).toContainText("相关防御演练记录将一并清除");
        expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        await dialog.getByRole("button", { name: "取消", exact: true }).click();
        expect(deletes).toBe(0);
        await firstDelete.click();
        await dialog.getByRole("button", { name: "删除", exact: true }).click();
        await expect(page.getByRole("alert").filter({ hasText: "删除结果尚未确认" })).toBeVisible();
        await expect(firstDelete).toBeDisabled(); await expect(secondDelete).toBeDisabled();
        await expect(input).toHaveValue(draft); await expect(roleInput).toHaveValue("未提交的目标岗位");
        expect((await request.get(firstEndpoint)).status()).toBe(alreadyDeleted ? 404 : 200);
        expect(await (await request.get(secondEndpoint)).json()).toEqual(second);
        const retry = page.getByRole("button", { name: "重新读取删除状态", exact: true });
        await retry.scrollIntoViewIfNeeded();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`defense-delete-unknown-${width}-${alreadyDeleted}.png`) });
        failList = alreadyDeleted;
        await retry.click();
        if (alreadyDeleted) {
          await expect(page.getByRole("alert").filter({ hasText: "合成历史刷新失败" })).toBeVisible();
          await expect(page.getByRole("status").filter({ hasText: `已确认记录 #${ids[0]} 不存在` })).toBeVisible();
          await expect(firstLink).toHaveCount(0);
          failList = false; staleList = true;
          await page.getByRole("button", { name: "点击重试", exact: true }).click();
          await expect(page.getByRole("alert").filter({ hasText: "合成历史刷新失败" })).toHaveCount(0);
        } else {
          await expect(page.getByRole("alert").filter({ hasText: "目前仍存在" })).toBeVisible();
          await expect(firstDelete).toBeEnabled(); await expect(secondDelete).toBeEnabled();
          expect(deletes).toBe(1);
          expect((await request.get(firstEndpoint)).status()).toBe(200);
          await firstDelete.click();
          await expect(dialog).toContainText(`#${ids[0]}「${titles[0]}」`);
          await dialog.getByRole("button", { name: "删除", exact: true }).click();
        }
        await expect(firstLink).toHaveCount(0); await expect(secondLink).toBeVisible();
        await expect(secondDelete).toBeEnabled();
        await expect(input).toHaveValue(draft); await expect(roleInput).toHaveValue("未提交的目标岗位");
        expect(deletes).toBe(alreadyDeleted ? 1 : 2); expect(checks).toBe(2); expect(modelCalls).toBe(4);
        expect((await request.get(firstEndpoint)).status()).toBe(404);
        expect(await (await request.get(secondEndpoint)).json()).toEqual(second);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      } finally {
        provider.closeAllConnections();
        await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
        expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
      }
    });
  }
}
