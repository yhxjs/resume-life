import { expect, test, type APIResponse } from "@playwright/test";
import { createServer } from "node:http";
import { listenForFetch } from "../support/http-server";
import { exportEncryptedBackup, postEncryptedBackup, rewriteEncryptedBackup } from "./backup-helpers";
import { publishResume } from "./resume-version-helpers";

for (const width of [390, 1280]) {
  for (const status of ["ongoing", "finished"]) {
    test(`原答评分 ${width}px ${status}：缺分阻止报告，恢复小数后按原分生成`, async ({ page, request }, testInfo) => {
      test.setTimeout(90_000);
      const baseline = await exportEncryptedBackup(request);
      expect(baseline.response.ok()).toBe(true);
      const original = "原答 <T> &amp;：仅负责校验，尚未上线。";
      const draft = "当前未提交草稿\n保留  内部空格 <T> &amp;";
      const fractional = { depth: 7.4, structure: 8.2, authenticity: 6.6, completeness: 9.1 };
      const replies: unknown[] = [
        { question: "你个人负责哪些工作？" },
        { depth: 7, structure: 8, authenticity: 7, completeness: 9, comment: "职责明确", next_question: "如何核实结果？", next_kind: "question" },
        { jd_match: 7, strengths: "分工明确", weaknesses: "结果未验证", suggestions: "补充原始记录" },
      ];
      let modelCalls = 0;
      const provider = createServer(async (incoming, outgoing) => {
        for await (const chunk of incoming) void chunk;
        modelCalls++;
        const reply = replies.shift();
        outgoing.writeHead(reply ? 200 : 500, { "Content-Type": "text/event-stream" });
        outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(reply) } }] })}\n\ndata: [DONE]\n\n`);
      });
      await listenForFetch(provider);
      const address = provider.address();
      if (!address || typeof address === "string") throw new Error("Missing provider");
      const done = async (response: APIResponse) => {
        expect(response.status()).toBe(200);
        const events = await response.text();
        const match = events.match(/event: done\ndata: ([^\n]+)/);
        expect(match, events).not.toBeNull();
        return JSON.parse(match![1]!);
      };
      try {
        expect((await request.put("/api/settings", { data: {
          base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-original-scores-key",
          api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic",
        } })).ok()).toBe(true);
        const resume = await (await request.post("/api/resumes", { data: { title: "原始评分校验合成简历" } })).json();
        const version = await publishResume(request, resume.id);
        const created = await done(await request.post("/api/interviews", { data: { resume_id: resume.id, resume_version_id: version.id, jd: "接口验证", rounds: 3 } }));
        const endpoint = `/api/interviews/${created.id}`;
        const initial = await (await request.get(endpoint)).json();
        const turnId = initial.turns[0].id;
        await done(await request.post(`${endpoint}/answer`, { data: { turn_id: turnId, answer: original } }));
        const originalBackup = await exportEncryptedBackup(request);
        expect(originalBackup.response.ok()).toBe(true);
        const installScores = async (scores: string) => {
          const bytes = await rewriteEncryptedBackup(originalBackup.bytes, records => {
            const turn = records.find(record => record.kind === "row" && record.table === "interview_turns" && record.data.id === turnId);
            const interview = records.find(record => record.kind === "row" && record.table === "interviews" && record.data.id === created.id);
            if (!turn || turn.kind !== "row" || !interview || interview.kind !== "row") throw new Error("Missing seeded rows");
            turn.data.scores = scores;
            interview.data.status = status;
          });
          expect((await postEncryptedBackup(request, "/api/backup/restore", bytes, { preserveAiConfig: true })).ok()).toBe(true);
        };
        await installScores("");
        const missing = await (await request.get(endpoint)).json();
        let posts = 0;
        await page.route(`**${endpoint}/finish`, async route => { posts++; await route.continue(); });
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/interviews/${created.id}`);
        const warning = page.getByRole("alert").filter({ hasText: /^原答评分缺失或损坏/ });
        await expect(warning).toBeVisible();
        await expect(page.getByText(original, { exact: true })).toBeVisible();
        if (status === "ongoing") await page.getByRole("textbox", { name: "以候选人身份组织作答：" }).fill(draft);
        const generate = async () => {
          if (status === "ongoing") {
            await page.getByRole("button", { name: "提前结束并生成总结", exact: true }).click();
            await page.getByRole("button", { name: "结束并生成报告", exact: true }).click();
          } else await page.getByRole("button", { name: "立即生成全景报告", exact: true }).click();
        };
        const refused = page.waitForResponse(response => response.url().endsWith(`${endpoint}/finish`) && response.request().method() === "POST");
        await generate();
        expect((await refused).status()).toBe(422);
        await expect(page.getByRole("alert").filter({ hasText: "第 1 题" })).toBeVisible();
        expect(await (await request.get(endpoint)).json()).toEqual(missing);
        expect(modelCalls).toBe(2);
        expect(posts).toBe(1);
        if (status === "ongoing") await expect(page.getByRole("textbox", { name: "以候选人身份组织作答：" })).toHaveValue(draft);
        await warning.scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath(`original-score-warning-${status}-${width}.png`) });
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

        await installScores(JSON.stringify(fractional));
        await page.reload();
        await expect(warning).toHaveCount(0);
        const repaired = await (await request.get(endpoint)).json();
        expect(repaired.turns[0].scores).toEqual(fractional);
        const saved = page.waitForResponse(response => response.url().endsWith(`${endpoint}/finish`) && response.request().method() === "POST");
        await generate();
        expect((await saved).status()).toBe(200);
        await expect(page.getByRole("button", { name: /候选人全景复盘/ })).toBeVisible();
        const final = await (await request.get(endpoint)).json();
        expect(final.report).toMatchObject({ ...fractional, overall: 7.7 });
        expect(final.turns).toEqual(repaired.turns);
        expect(final.resume_version_id).toBe(version.id);
        expect(posts).toBe(2);
        expect(modelCalls).toBe(3);
        await page.reload();
        await expect(page.getByRole("button", { name: /候选人全景复盘/ })).toBeVisible();
        expect((await (await request.get(endpoint)).json()).report).toEqual(final.report);
      } finally {
        provider.closeAllConnections();
        await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
        expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
      }
    });
  }
}
