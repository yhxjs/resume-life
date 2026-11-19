import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";

const turn = {
  hr_response: "模拟 HR：薪数仍待确认", hr_tactics: "核实条件",
  hr_mindset: { looseness: 20, current_attitude: "模拟态度", estimated_package: "模拟方案，未确认", tactics_label: "澄清", internal_pressure: "预算待审批" },
  mentor_analysis: { user_argument_score: 7, strengths: ["诉求明确"], vulnerabilities: ["保证收入待核实"], tactical_tips: "先核对薪数",
    suggested_replies: [{ title: "澄清", content: "请确认保证薪数", rationale: "区分保证与浮动收入" }] },
};
const opening = { ...turn, initial_offer: "模拟开价，奖金待审批",
  mentor_analysis: { ...turn.mentor_analysis, user_argument_score: 5, strengths: ["尚未展示谈判表现"], tactical_tips: "中性起点，尚未评价谈判表现；先核对薪数" } };
const report = { final_package_summary: "尚未达成，奖金待审批", score: 75, leverage_efficiency: "保证现金增益未知",
  turn_critiques: [{ turn_no: 2, gain_or_loss: "neutral", summary: "提出澄清", key_point: "薪数仍待确认" }],
  real_world_tips: ["核对书面方案"], mentor_summary: "模拟练习，条件尚未确认" };

for (const width of [390, 1280]) {
  test(`谈薪操作超时 ${width}px：408 后旧存档不解锁，迟到回合和复盘只读恢复`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000);
    const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
    let stage: "opening" | "turn" | "finalize" = "opening";
    let reached = Promise.withResolvers<void>(); let release = Promise.withResolvers<void>();
    let completed = Promise.withResolvers<void>(); let modelCalls = 0;
    const provider = createServer(async (incoming, outgoing) => {
      let body = ""; for await (const chunk of incoming) body += chunk;
      modelCalls++; const current = stage;
      if (current !== "opening") { reached.resolve(); await release.promise; }
      const content = JSON.stringify(current === "finalize" ? report : current === "opening" ? opening : turn);
      if (JSON.parse(body).stream) {
        outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
        outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
        return;
      }
      outgoing.writeHead(200, { "Content-Type": "application/json" });
      outgoing.end(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }));
    });
    await listenForFetch(provider);
    const address = provider.address(); if (!address || typeof address === "string") throw new Error("Missing provider address");
    try {
      expect((await request.put("/api/settings", { data: { base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-timeout-key", api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic" } })).ok()).toBe(true);
      const ids: number[] = [];
      for (let index = 0; index < 2; index++) {
        const created = await request.post("/api/tools/salary-negotiations", { data: { target_role: `超时恢复_${index}`, expected_salary: "税前30k，薪数待确认" } });
        expect(created.status(), await created.text()).toBe(201); ids.push((await created.json()).id);
      }
      const endpoint = `/api/tools/salary-negotiations/${ids[0]}`;
      const otherEndpoint = `/api/tools/salary-negotiations/${ids[1]}`;
      const original = await (await request.get(endpoint)).json();
      const other = await (await request.get(otherEndpoint)).json();
      const posts = { turn: [] as unknown[], finalize: [] as unknown[] }; let deletes = 0; let reads = 0;
      for (const kind of ["turn", "finalize"] as const) {
        await page.route(`**${endpoint}/${kind}`, async route => {
          posts[kind].push(route.request().postDataJSON());
          const response = route.fetch();
          await reached.promise;
          await route.fulfill({ status: 408, json: { error: "合成等待超时，服务端仍处理中" } });
          const saved = await response;
          expect(saved.status()).toBe(kind === "turn" ? 201 : 200); completed.resolve();
        });
      }
      await page.route(`**${endpoint}`, async route => {
        if (route.request().method() === "DELETE") {
          deletes++; const response = await route.fetch(); expect(response.status()).toBe(200);
          return route.fulfill({ status: 408, json: { error: "删除已完成但等待超时" } });
        }
        reads++; return route.continue();
      });
      await page.setViewportSize({ width, height: 900 }); await page.goto(`/tools/salary/${ids[0]}`);
      const input = page.getByRole("textbox", { name: "你的练习回复", exact: true });
      const message = "  本次原话 Array<T> &amp;\n奖金待审批，尚未达成  ";
      await input.fill(message); stage = "turn";
      await page.getByRole("button", { name: "发送话术 · 推进博弈", exact: true }).click();
      const alert = page.getByRole("alert", { name: "谈薪操作状态", exact: true });
      const retry = page.getByRole("button", { name: "重新读取操作状态", exact: true });
      await expect(alert).toContainText("操作结果尚未确认");
      await expect(input).toBeDisabled(); await expect(input).toHaveValue(message);
      expect(reads).toBe(2); expect(modelCalls).toBe(3);
      expect((await (await request.get(endpoint)).json()).turns).toHaveLength(1);
      await retry.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
      await expect(retry).toBeEnabled(); expect(reads).toBe(3);
      await expect(input).toBeDisabled();
      await expect(page.getByRole("button", { name: "结束模拟 / 生成复盘", exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: "删除", exact: true })).toBeDisabled();
      await input.evaluate(element => element.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
      expect(posts.turn).toEqual([{ user_message: message.trim(), expected_revision: original.revision }]);
      await alert.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`salary-turn-timeout-${width}.png`), animations: "disabled" });
      release.resolve(); await completed.promise;
      await retry.click(); await expect(input).toBeEnabled(); await expect(input).toHaveValue(message);
      await expect(page.getByRole("status").filter({ hasText: "无法确认是否来自本次请求" })).toBeVisible();
      const afterTurn = await (await request.get(endpoint)).json();
      expect(afterTurn.turns).toHaveLength(2); expect(afterTurn.turns[1].user_message).toBe(message.trim());
      expect(modelCalls).toBe(3); expect(posts.turn).toHaveLength(1);

      stage = "finalize"; reached = Promise.withResolvers<void>(); release = Promise.withResolvers<void>(); completed = Promise.withResolvers<void>();
      const supplement = "  结束补充 Array<T> &amp;\n只认可月薪，奖金待审批  ";
      await page.getByRole("button", { name: "结束模拟 / 生成复盘", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "结束模拟并生成复盘报告", exact: true });
      await dialog.getByRole("textbox", { name: "结束补充（可选）", exact: true }).fill(supplement);
      await dialog.getByRole("button", { name: "结束模拟并生成报告", exact: true }).click();
      await expect(dialog).toBeHidden(); await expect(alert).toContainText("操作结果尚未确认");
      await expect(input).toBeDisabled(); await expect(input).toHaveValue(message);
      expect((await (await request.get(endpoint)).json()).status).toBe("ongoing");
      await retry.click(); await expect(retry).toBeEnabled();
      await expect(page.getByRole("button", { name: "结束模拟 / 生成复盘", exact: true })).toBeDisabled();
      expect(posts.finalize).toEqual([{ final_words: supplement.trim(), expected_revision: afterTurn.revision }]); expect(modelCalls).toBe(4);
      await alert.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`salary-finalize-timeout-${width}.png`), animations: "disabled" });
      release.resolve(); await completed.promise; await retry.click();
      await expect(page.getByRole("heading", { name: `本次模拟结果：${report.final_package_summary}`, exact: true })).toBeVisible();
      await expect(page.getByRole("status").filter({ hasText: "本次补充是否被采用无法按请求确认" })).toBeVisible();
      const saved = await (await request.get(endpoint)).json();
      expect(saved.status).toBe("finished"); expect(saved.turns).toEqual(afterTurn.turns);
      expect(posts.turn).toHaveLength(1); expect(posts.finalize).toHaveLength(1); expect(modelCalls).toBe(4);

      await page.getByRole("button", { name: "删除", exact: true }).click();
      await page.getByRole("dialog", { name: "删除博弈记录", exact: true }).getByRole("button", { name: "删除", exact: true }).click();
      await expect(page).toHaveURL(/\/tools\/salary$/);
      expect(deletes).toBe(1); expect((await request.get(endpoint)).status()).toBe(404);
      expect(await (await request.get(otherEndpoint)).json()).toEqual(other); expect(modelCalls).toBe(4);
    } finally {
      release.resolve(); provider.closeAllConnections();
      await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
      expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
    }
  });
}
