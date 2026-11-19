import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import { gate } from "./synthetic-api";

const turnOutput = {
  hr_response: "模拟 HR 回应：保证薪数和奖金均需确认", hr_tactics: "核实条件",
  hr_mindset: { looseness: 20, current_attitude: "模拟态度", estimated_package: "模拟方案，未确认", tactics_label: "澄清", internal_pressure: "预算待审批" },
  mentor_analysis: { user_argument_score: 7, strengths: ["诉求清楚"], vulnerabilities: ["保证收入未确认"], tactical_tips: "先核对薪数和奖金",
    suggested_replies: [{ title: "澄清", content: "请确认保证薪数", rationale: "区分保证现金与浮动部分" }] },
};
const openingOutput = { ...turnOutput, initial_offer: "模拟开价，奖金待审批",
  mentor_analysis: { ...turnOutput.mentor_analysis, user_argument_score: 5, strengths: ["尚未展示谈判表现"], tactical_tips: "中性起点，尚未评价谈判表现；先核对薪数和奖金" } };
const reportOutput = { final_package_summary: "尚未达成；奖金待审批，保证薪数未确认", score: 75, leverage_efficiency: "无法确认保证现金增益",
  turn_critiques: [{ turn_no: 2, gain_or_loss: "neutral", summary: "提出澄清请求", key_point: "HR 尚未确认" }],
  real_world_tips: ["先核对书面方案"], mentor_summary: "这是模拟练习，需继续核实条件" };

for (const width of [390, 1280]) {
  test(`谈薪操作恢复 ${width}px：真实保存后串响应，只读恢复回合、复盘与删除`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000);
    const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
    const pending = gate();
    let stage: "opening" | "turn" | "finalize" = "opening";
    let modelCalls = 0;
    const provider = createServer(async (incoming, outgoing) => {
      let body = ""; for await (const chunk of incoming) body += chunk;
      modelCalls++;
      const reply = stage === "finalize" ? reportOutput : stage === "opening" ? openingOutput : turnOutput;
      if (stage === "turn") await pending.promise;
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
      expect((await request.put("/api/settings", { data: { base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-salary-recovery-key",
        api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic" } })).ok()).toBe(true);
      const ids: number[] = [];
      for (let index = 0; index < 2; index++) {
        const response = await request.post("/api/tools/salary-negotiations", { data: { target_role: `谈薪存档核对_${index}`, expected_salary: "税前30k，薪数待确认" } });
        expect(response.status(), await response.text()).toBe(201); ids.push((await response.json()).id);
      }
      const endpoint = `/api/tools/salary-negotiations/${ids[0]}`;
      const otherEndpoint = `/api/tools/salary-negotiations/${ids[1]}`;
      const original = await (await request.get(endpoint)).json();
      const other = await (await request.get(otherEndpoint)).json();
      let operation: "turn" | "finalize" | "delete" | null = null;
      const checks = { turn: 0, finalize: 0, delete: 0 };
      const posts = { turn: [] as unknown[], finalize: [] as unknown[] };
      let deletes = 0;
      await page.route(`**${endpoint}/turn`, async (route) => {
        posts.turn.push(route.request().postDataJSON());
        const response = await route.fetch(); expect(response.status()).toBe(201);
        await route.fulfill({ status: 201, json: { ...await response.json(), negotiation_id: ids[1] } });
      });
      await page.route(`**${endpoint}/finalize`, async (route) => {
        posts.finalize.push(route.request().postDataJSON());
        const response = await route.fetch(); expect(response.status()).toBe(200);
        const result = await response.json(); expect(result.id).toBe(ids[0]); expect(result.finished_at).not.toBe("");
        await route.fulfill({ json: { ...result, id: ids[1] } });
      });
      await page.route(`**${endpoint}`, async (route) => {
        if (route.request().method() === "DELETE") {
          deletes++; const response = await route.fetch(); expect(response.status()).toBe(200);
          return route.fulfill({ json: { ok: false } });
        }
        if (operation) {
          const check = ++checks[operation];
          if (check === 1) return route.fulfill({ status: 503, json: { error: "合成存档读取失败" } });
          if (check === 2) return route.fulfill({ json: other });
        }
        return route.continue();
      });
      await page.setViewportSize({ width, height: 900 }); await page.goto(`/tools/salary/${ids[0]}`);
      const input = page.getByRole("textbox", { name: "你的练习回复", exact: true });
      const message = "本次原话 <T> &amp;\n奖金待确认，不能认定双方达成一致";
      await input.fill(`  ${message}\n `);
      stage = "turn"; operation = "turn";
      await page.getByRole("button", { name: "发送话术 · 推进博弈", exact: true }).click();
      await expect.poll(() => modelCalls).toBe(3);
      await expect(input).toBeDisabled();
      await expect(page.getByRole("button", { name: "删除", exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: "结束模拟 / 生成复盘", exact: true })).toBeDisabled();
      await input.evaluate((element) => element.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
      expect(posts.turn).toHaveLength(1); pending.release();
      const alert = page.getByRole("alert", { name: "谈薪操作状态", exact: true }); const retry = page.getByRole("button", { name: "重新读取操作状态", exact: true });
      await expect(alert).toContainText("操作结果尚未确认");
      await expect(input).toHaveValue(`  ${message}\n `);
      await retry.click(); await expect(alert).toContainText("历史记录结构异常");
      await expect(page.getByRole("heading", { name: "谈薪存档核对_1", exact: true })).toHaveCount(0);
      await expect(input).toBeDisabled();
      await retry.click(); await expect(page.getByRole("status").filter({ hasText: "无法确认是否来自本次请求" })).toBeVisible();
      await expect(input).toBeEnabled(); await expect(input).toHaveValue(`  ${message}\n `);
      const savedTurn = await (await request.get(endpoint)).json();
      expect(savedTurn.turns).toHaveLength(2); expect(savedTurn.turns[1]).toMatchObject({ turn_no: 2, user_message: message });
      expect(posts.turn).toEqual([{ user_message: message, expected_revision: original.revision }]); expect(checks.turn).toBe(3); expect(modelCalls).toBe(3);
      await page.screenshot({ path: testInfo.outputPath(`salary-turn-recovered-${width}.png`), fullPage: true });

      stage = "finalize"; operation = "finalize";
      await page.getByRole("button", { name: "结束模拟 / 生成复盘", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "结束模拟并生成复盘报告", exact: true });
      const supplement = "结束补充 <T> &amp;\n我只认可月薪，奖金待审批";
      await dialog.getByRole("textbox", { name: "结束补充（可选）", exact: true }).fill(`  ${supplement}\n `);
      await dialog.getByRole("button", { name: "结束模拟并生成报告", exact: true }).click();
      await expect(dialog).toBeHidden(); await expect(alert).toContainText("操作结果尚未确认");
      await expect(page.getByRole("button", { name: "结束模拟 / 生成复盘", exact: true })).toBeDisabled();
      await retry.click(); await expect(alert).toContainText("历史记录结构异常");
      await retry.click();
      await expect(page.getByRole("heading", { name: `本次模拟结果：${reportOutput.final_package_summary}`, exact: true })).toBeVisible();
      await expect(page.getByRole("status").filter({ hasText: "本次补充是否被采用无法按请求确认" })).toBeVisible();
      const saved = await (await request.get(endpoint)).json();
      expect(saved.status).toBe("finished"); expect(saved.finished_at).not.toBe(""); expect(saved.turns).toEqual(savedTurn.turns);
      expect(posts.finalize).toEqual([{ final_words: supplement, expected_revision: savedTurn.revision }]); expect(checks.finalize).toBe(3); expect(modelCalls).toBe(4);
      // 再次结束只回读同一份存档，不调用模型或采用新的补充。
      const cached = await request.post(`${endpoint}/finalize`, { data: { final_words: "不得覆盖原报告", expected_revision: saved.revision } });
      expect(cached.status()).toBe(200); expect(await cached.json()).toMatchObject({ id: ids[0], finished_at: saved.finished_at, report: saved.report }); expect(modelCalls).toBe(4);

      operation = null;
      await page.getByRole("button", { name: "删除", exact: true }).click();
      const confirmation = page.getByRole("dialog", { name: "删除博弈记录", exact: true });
      await confirmation.getByRole("button", { name: "取消", exact: true }).click(); expect(deletes).toBe(0);
      await page.getByRole("button", { name: "删除", exact: true }).click(); operation = "delete";
      await confirmation.getByRole("button", { name: "删除", exact: true }).click();
      await expect(alert).toContainText("操作结果尚未确认");
      await expect(page.getByRole("button", { name: "删除", exact: true })).toBeDisabled();
      await retry.click(); await expect(alert).toContainText("历史记录结构异常");
      await retry.click(); await expect(page).toHaveURL(/\/tools\/salary$/);
      expect((await request.get(endpoint)).status()).toBe(404); expect(deletes).toBe(1); expect(checks.delete).toBe(3);
      expect(await (await request.get(otherEndpoint)).json()).toEqual(other); expect(modelCalls).toBe(4);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`salary-delete-recovered-${width}.png`), fullPage: true });
    } finally {
      pending.release(); provider.closeAllConnections();
      await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
      expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
    }
  });
}
