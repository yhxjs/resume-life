import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import { gate, mockApi } from "./synthetic-api";

const quote = "仅参与接口校验 <T> &amp;\n尚未上线，没有选型权。";
const questions = ["Question_".repeat(9) + "具体分工？", "如何验证结果？ <T> &amp;"];

for (const width of [390, 1280]) {
  for (const { actuallySaved, timeout } of [true, false].flatMap(actuallySaved =>
    [false, true].map(timeout => ({ actuallySaved, timeout })))) {
    test(`演练存档恢复 ${width}px：${actuallySaved ? "实际已保存后" : "未执行评分后"}${timeout ? "408 超时" : "异常响应"}，核对恢复后显式提交`, async ({ page, request }, testInfo) => {
      test.setTimeout(90_000);
      const baseline = await exportEncryptedBackup(request);
      expect(baseline.response.ok()).toBe(true);
      const pending = gate();
      let scanning = true;
      let hold = false;
      let score = 80;
      let modelCalls = 0;
      let modelEntered = false;
      const provider = createServer(async (incoming, outgoing) => {
        let body = ""; for await (const chunk of incoming) body += chunk;
        modelCalls++;
        const reply = scanning ? { risk_level: "medium", overall_roast: "需要核对分工与验证范围", items: [{
          original_text: quote, section_hint: "项目经历", risk_level: "medium", risk_type: "scope_ambiguity",
          interviewer_roast: "请核对个人负责范围", deadly_questions: questions,
          defense_plan: { interviewer_intent: "核对个人分工", standard_defense: "仅说明已确认的事实", taboo_mistakes: ["编造职责和数据"] },
        }] } : { defense_score: score, interviewer_roast: `评估_${score}`, defense_critique: "仍需核实实际结果", improved_answer: "我仅参与接口校验，尚未上线。" };
        if (hold) { modelEntered = true; await pending.promise; }
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
          base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-defense-drill-key",
          api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic",
        } })).ok()).toBe(true);
        const ids: number[] = [];
        for (let index = 0; index < 2; index++) {
          const created = await request.post("/api/tools/resume-defenses", { data: { title: `待核对报告${index}`, resumeContent: quote, targetRole: "接口工程师" } });
          expect(created.status(), await created.text()).toBe(200); ids.push((await created.json()).id);
        }
        scanning = false;
        const otherEndpoint = `/api/tools/resume-defenses/${ids[1]}`;
        const otherDrill = await request.post(`${otherEndpoint}/drill`, { data: { itemId: "item_1", question: questions[0], userAnswer: "另一报告的原答" } });
        expect(otherDrill.status(), await otherDrill.text()).toBe(200);
        const other = await (await request.get(otherEndpoint)).json();
        expect(other.drills).toHaveLength(1); expect(modelCalls).toBe(3);
        const endpoint = `/api/tools/resume-defenses/${ids[0]}`;
        const original = "首次原答 <T> &amp;\n我仅参与接口校验，尚未上线。";
        const draft = "Draft_".repeat(40) + " <T> &amp;\n等待期间补充的新稿，不替换已提交原答。";
        const submitted: Record<string, unknown>[] = [];
        let checks = 0;
        hold = actuallySaved; score = 85;
        await page.route(`**${endpoint}/drill`, async (route) => {
          submitted.push(route.request().postDataJSON());
          if (submitted.length === 1 && !actuallySaved) {
            await pending.promise;
            return route.fulfill({ status: timeout ? 408 : 503, json: { error: "合成评分未执行" } });
          }
          const response = await route.fetch();
          expect(response.status()).toBe(200);
          if (submitted.length === 1) return timeout
            ? route.fulfill({ status: 408, json: { error: "合成评分已保存，响应超时" } })
            : route.fulfill({ json: { ...await response.json(), defenseId: ids[1] } });
          return route.fulfill({ response });
        });
        await page.route(`**${endpoint}`, async (route) => {
          if (submitted.length > 0 && ++checks === 1) return route.fulfill(actuallySaved
            ? { status: 503, json: { error: "合成存档读取失败" } }
            : { status: 200, json: other });
          return route.continue();
        });
        await page.setViewportSize({ width, height: 900 }); await page.goto(`/tools/defense/${ids[0]}`);
        await page.getByRole("button", { name: "即刻防御演练", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "即时防御演练场" });
        const input = dialog.getByRole("textbox", { name: "你的练习回答：", exact: true });
        await input.fill(`  ${original}\n `);
        await dialog.getByRole("button", { name: "提交练习回答", exact: true }).click();
        await expect.poll(() => submitted.length).toBe(1);
        if (actuallySaved) await expect.poll(() => modelEntered).toBe(true);
        await expect(dialog.getByRole("status").filter({ hasText: "正在评估本次回答…" })).toBeVisible();
        await expect(input).toBeEnabled(); await input.fill(draft);
        await dialog.getByRole("button", { name: new RegExp("如何验证结果") }).click();
        // 等待时即使直接再次触发表单提交，也不能绕过同步互斥。
        await input.evaluate((element) => element.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
        expect(submitted).toHaveLength(1);
        pending.release();
        const alert = dialog.getByRole("alert");
        await expect(alert).toContainText("演练保存结果尚未确认");
        const submit = dialog.getByRole("button", { name: "提交练习回答", exact: true });
        await expect(submit).toBeDisabled(); await expect(input).toHaveValue(draft);
        const storedBefore = await (await request.get(endpoint)).json();
        expect(storedBefore.drills).toHaveLength(actuallySaved ? 1 : 0);
        if (actuallySaved) expect(storedBefore.drills[0]).toMatchObject({ question: questions[0], userAnswer: original, defenseScore: 85 });
        expect(await (await request.get(otherEndpoint)).json()).toEqual(other);
        await alert.scrollIntoViewIfNeeded();
        expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`defense-drill-unknown-${width}-${actuallySaved}.png`) });
        await dialog.getByRole("button", { name: "重新读取演练存档", exact: true }).click();
        await expect(alert).toContainText(actuallySaved ? "不能确认本次请求已完成" : "当前存档未找到");
        await expect(submit).toBeEnabled(); await expect(input).toHaveValue(draft);
        await expect(dialog.getByText("评估_85", { exact: true })).toHaveCount(0);
        await expect(page.getByText(/已完成演练:/)).toContainText(actuallySaved ? "1 / 1" : "0 / 1");
        expect(submitted).toHaveLength(1); expect(checks).toBe(2); expect(modelCalls).toBe(actuallySaved ? 4 : 3);
        if (actuallySaved) {
          await input.fill(original); await dialog.getByRole("button", { name: /Question_/ }).click();
          await expect(dialog.getByText("评估_85", { exact: true })).toBeVisible();
          await input.fill(draft); await dialog.getByRole("button", { name: /如何验证结果/ }).click();
        }
        hold = false; score = 92;
        await submit.click();
        await expect(dialog.getByText("回答充分（92分）", { exact: true })).toBeVisible();
        await expect(dialog.getByText("评估_92", { exact: true })).toBeVisible();
        expect(submitted).toEqual([
          { itemId: "item_1", question: questions[0], userAnswer: original, defensePlan: "仅说明已确认的事实" },
          { itemId: "item_1", question: questions[1], userAnswer: draft, defensePlan: "仅说明已确认的事实" },
        ]);
        expect(modelCalls).toBe(actuallySaved ? 5 : 4); expect(checks).toBe(2);
        const stored = await (await request.get(endpoint)).json();
        expect(stored.drills).toHaveLength(1);
        expect(stored.drills[0]).toMatchObject({ question: questions[1], userAnswer: draft, defenseScore: 92 });
        expect(stored.report.sourceContent).toBe(quote); expect(stored.report.items[0].originalText).toBe(quote);
        expect(await (await request.get(otherEndpoint)).json()).toEqual(other);
        expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`defense-drill-recovered-${width}-${actuallySaved}.png`) });
      } finally {
        pending.release(); provider.closeAllConnections();
        await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
        expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
      }
    });
  }

  for (const oldFails of [false, true]) {
    test(`演练关闭隔离 ${width}px：旧请求迟到${oldFails ? "失败" : "成功"}不覆盖重新打开的新原答`, async ({ page }, testInfo) => {
      await mockApi(page);
      const old = gate(); const fresh = gate();
      const item = { id: "item_1", originalText: quote, sectionHint: "项目", riskLevel: "medium", riskType: "scope_ambiguity",
        interviewerRoast: "待核实", deadlyQuestions: questions, defensePlan: { interviewerIntent: "核对分工", standardDefense: "仅说明事实", tabooMistakes: ["编造经历"] } };
      const report = { id: 9010, resumeId: null, title: "合成演练报告", sourceContent: quote, targetRole: "接口工程师", riskLevel: "medium",
        overallRoast: "核对分工", createdAt: "2026-10-29", items: [item] };
      const submitted: Record<string, unknown>[] = [];
      let reads = 0; let delivered = 0; let aborted = false;
      page.on("requestfailed", (request) => { if (new URL(request.url()).pathname.endsWith("/9010/drill")) aborted = true; });
      await page.route("**/api/tools/resume-defenses/9010", (route) => { reads++; return route.fulfill({ json: { report, drills: [] } }); });
      await page.route("**/api/tools/resume-defenses/9010/drill", async (route) => {
        const body = route.request().postDataJSON(); submitted.push(body);
        const index = submitted.length;
        await (index === 1 ? old.promise : fresh.promise);
        if (index === 1 && oldFails) await route.fulfill({ status: 503, json: { error: "旧评分失败" } });
        else await route.fulfill({ json: { id: 9020, defenseId: 9010, itemId: "item_1", question: body.question, userAnswer: body.userAnswer,
          defenseScore: index === 1 ? 85 : 92, interviewerRoast: index === 1 ? "旧原答点评" : "新原答点评", defenseCritique: "仍需核实", improvedAnswer: "仅说明事实",
          createdAt: "2026-10-29", updatedAt: "2026-10-29" } });
        delivered++;
      });
      try {
        await page.setViewportSize({ width, height: 900 }); await page.goto("/tools/defense/9010");
        await page.getByRole("button", { name: "即刻防御演练", exact: true }).click();
        const dialog = page.getByRole("dialog", { name: "即时防御演练场" });
        const input = dialog.getByRole("textbox", { name: "你的练习回答：", exact: true });
        await input.fill("旧原答 <T> &amp;"); await dialog.getByRole("button", { name: "提交练习回答", exact: true }).click();
        await expect.poll(() => submitted.length).toBe(1);
        await expect(dialog.getByText(/关闭只停止本地等待/)).toBeVisible();
        await dialog.getByRole("button", { name: "关闭", exact: true }).click();
        await expect(dialog).toHaveCount(0); await expect.poll(() => aborted).toBe(true);
        await page.getByRole("button", { name: "即刻防御演练", exact: true }).click();
        await input.fill("新抽屉原答 <T> &amp;"); await dialog.getByRole("button", { name: "提交练习回答", exact: true }).click();
        await expect.poll(() => submitted.length).toBe(2); old.release();
        await expect.poll(() => delivered).toBe(1);
        await expect(input).toHaveValue("新抽屉原答 <T> &amp;");
        await expect(dialog.getByRole("status").filter({ hasText: "正在评估本次回答…" })).toBeVisible();
        await expect(dialog.getByRole("alert")).toHaveCount(0); await expect(dialog.getByText("旧原答点评", { exact: true })).toHaveCount(0);
        expect(reads).toBe(1); fresh.release();
        await expect(dialog.getByText("新原答点评", { exact: true })).toBeVisible();
        await expect(input).toHaveValue("新抽屉原答 <T> &amp;"); expect(reads).toBe(1); expect(submitted).toHaveLength(2);
        expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`defense-drill-reopened-${width}-${oldFails}.png`) });
      } finally { old.release(); fresh.release(); }
    });
  }
}
