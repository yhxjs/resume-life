import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import { gate } from "./synthetic-api";

const quote = "仅参与接口校验 <T> &amp;\n尚未上线，没有选型权。";
const question = "你具体负责哪些部分？";

for (const width of [390, 1280]) {
  test(`同条目跨页评分互斥 ${width}px：重复提交不调用模型，保留原答并允许完成后显式重评`, async ({ page, context, request }, testInfo) => {
    test.setTimeout(90_000);
    const baseline = await exportEncryptedBackup(request);
    expect(baseline.response.ok()).toBe(true);
    const pending = gate();
    let scanning = true;
    let modelCalls = 0;
    const provider = createServer(async (incoming, outgoing) => {
      let body = ""; for await (const chunk of incoming) body += chunk;
      modelCalls++;
      const call = modelCalls;
      const reply = scanning ? {
        risk_level: "medium", overall_roast: "需要核对分工", items: [{
          original_text: quote, section_hint: "项目经历", risk_level: "medium", risk_type: "scope_ambiguity",
          interviewer_roast: "请核对个人负责范围", deadly_questions: [question, "如何验证结果？"],
          defense_plan: { interviewer_intent: "核对分工", standard_defense: "仅说明已确认事实", taboo_mistakes: ["编造经历"] },
        }],
      } : { defense_score: call === 2 ? 85 : 92, interviewer_roast: `评分调用_${call}`, defense_critique: "仍需核实实际结果", improved_answer: "我仅参与接口校验，尚未上线。" };
      if (call === 2) await pending.promise;
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
    const otherPage = await context.newPage();
    try {
      expect((await request.put("/api/settings", { data: {
        base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-defense-lock-key",
        api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic",
      } })).ok()).toBe(true);
      const created = await request.post("/api/tools/resume-defenses", { data: { title: "并发评分核对", resumeContent: quote, targetRole: "接口工程师" } });
      expect(created.status(), await created.text()).toBe(200);
      const id = (await created.json()).id;
      const endpoint = `/api/tools/resume-defenses/${id}`;
      scanning = false;
      for (const current of [page, otherPage]) {
        await current.setViewportSize({ width, height: 900 });
        await current.goto(`/tools/defense/${id}`);
        await current.getByRole("button", { name: "即刻防御演练", exact: true }).click();
      }
      const firstDialog = page.getByRole("dialog", { name: "即时防御演练场" });
      const secondDialog = otherPage.getByRole("dialog", { name: "即时防御演练场" });
      const firstInput = firstDialog.getByRole("textbox", { name: "你的练习回答：", exact: true });
      const secondInput = secondDialog.getByRole("textbox", { name: "你的练习回答：", exact: true });
      const firstAnswer = "第一页提交的原答 <T> &amp;\n仅参与接口校验。";
      const secondAnswer = "第二页保留的新原答 <T> &amp;\n尚未上线，验证结果待确认。";
      const firstDraft = "第一页等待期间的新稿，不改写已提交原答。";
      await firstInput.fill(firstAnswer);
      await firstDialog.getByRole("button", { name: "提交练习回答", exact: true }).click();
      await expect.poll(() => modelCalls).toBe(2);
      await firstInput.fill(firstDraft);
      await secondInput.fill(secondAnswer);
      let secondReads = 0;
      let secondWrites = 0;
      otherPage.on("request", (incoming) => {
        const path = new URL(incoming.url()).pathname;
        if (path === endpoint && incoming.method() === "GET") secondReads++;
        if (path === `${endpoint}/drill` && incoming.method() === "POST") secondWrites++;
      });
      const secondSubmit = secondDialog.getByRole("button", { name: "提交练习回答", exact: true });
      for (let duplicate = 0; duplicate < 2; duplicate++) {
        const rejected = otherPage.waitForResponse((response) => new URL(response.url()).pathname === `${endpoint}/drill` && response.request().method() === "POST");
        await secondSubmit.click();
        expect((await rejected).status()).toBe(409);
        await expect(secondDialog.getByRole("alert")).toContainText("该条演练正在评分，请稍后重试");
        await expect(secondInput).toHaveValue(secondAnswer);
        await expect(secondSubmit).toBeEnabled();
        expect(modelCalls).toBe(2);
        expect((await (await request.get(endpoint)).json()).drills).toEqual([]);
      }
      expect(secondReads).toBe(0); expect(secondWrites).toBe(2);
      await expect(firstDialog.getByRole("status").filter({ hasText: "正在评估本次回答…" })).toBeVisible();
      expect(await secondDialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await otherPage.screenshot({ path: testInfo.outputPath(`defense-drill-conflict-${width}.png`) });
      pending.release();
      await expect(firstDialog.getByRole("status").filter({ hasText: "正在评估本次回答…" })).toHaveCount(0);
      await expect(firstInput).toHaveValue(firstDraft);
      const firstSaved = await (await request.get(endpoint)).json();
      expect(firstSaved.drills).toHaveLength(1);
      expect(firstSaved.drills[0]).toMatchObject({ question, userAnswer: firstAnswer, defenseScore: 85 });
      await expect(secondInput).toHaveValue(secondAnswer);
      await secondSubmit.click();
      await expect(secondDialog.getByText("评分调用_3", { exact: true })).toBeVisible();
      await expect(secondDialog.getByText("回答充分（92分）", { exact: true })).toBeVisible();
      expect(modelCalls).toBe(3); expect(secondWrites).toBe(3); expect(secondReads).toBe(0);
      const stored = await (await request.get(endpoint)).json();
      expect(stored.drills).toHaveLength(1);
      expect(stored.drills[0]).toMatchObject({ id: firstSaved.drills[0].id, question, userAnswer: secondAnswer, defenseScore: 92 });
      expect(stored.report.sourceContent).toBe(quote);
      expect(stored.report.items[0].originalText).toBe(quote);
      await expect(otherPage.getByText(/已完成演练:/)).toContainText("1 / 1");
    } finally {
      pending.release(); await otherPage.close(); provider.closeAllConnections();
      await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
      expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
    }
  });
}
