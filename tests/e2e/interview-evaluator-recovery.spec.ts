import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import { publishResume } from "./resume-version-helpers";
import { gate } from "./synthetic-api";

for (const width of [390, 1280]) {
  for (const failReads of [false, true]) {
    test(`补生成评估 ${width}px：丢失成功响应${failReads ? "且连续读取失败" : "后读取恢复"}，切换报告不重复生成`, async ({ page, request }, testInfo) => {
      test.setTimeout(90_000);
      const baseline = await exportEncryptedBackup(request);
      expect(baseline.response.ok()).toBe(true);
      const release = gate();
      const evaluator = { recommendation: "Lean No", level: "暂无法判断", level_justification: "本场只有一题，证据不足。",
        summary_for_hr: "独立补生成：个人分工明确，后续效果尚未验证。", hire_reasons: [], concerns_and_risks: [],
        placement_suggestion: "补充验证方法考察", evidence_quotes: [] };
      const replies: unknown[] = [
        { question: "你个人负责哪些工作？" },
        { depth: 7, structure: 8, authenticity: 8, completeness: 7, comment: "职责明确", next_question: "", next_kind: "question" },
        { jd_match: 7, strengths: "只描述实际分工", weaknesses: "效果待验证", suggestions: "核实验证结果" },
        evaluator,
      ];
      let modelCalls = 0;
      const provider = createServer(async (incoming, outgoing) => {
        for await (const chunk of incoming) void chunk;
        modelCalls += 1;
        const reply = replies.shift();
        outgoing.writeHead(reply ? 200 : 500, { "Content-Type": "text/event-stream" });
        outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(reply) } }] })}\n\ndata: [DONE]\n\n`);
      });
      await listenForFetch(provider);
      const address = provider.address();
      if (!address || typeof address === "string") throw new Error("Missing synthetic provider address");
      try {
        expect((await request.put("/api/settings", { data: {
          base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-evaluator-recovery-key",
          api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic",
        } })).ok()).toBe(true);
        const resumeResponse = await request.post("/api/resumes", { data: { title: "评估恢复合成简历" } });
        expect(resumeResponse.status()).toBe(201);
        const resume = await resumeResponse.json();
        const version = await publishResume(request, resume.id);
        const created = await request.post("/api/interviews", { data: {
          resume_id: resume.id, resume_version_id: version.id, jd: "接口维护", rounds: 1,
        } });
        expect(created.status()).toBe(200);
        const match = (await created.text()).match(/event: done\ndata: ([^\n]+)/);
        expect(match).not.toBeNull();
        const interview = JSON.parse(match![1]!);
        const endpoint = `/api/interviews/${interview.id}`;
        const initial = await (await request.get(endpoint)).json();
        const answered = await request.post(`${endpoint}/answer`, { data: { turn_id: initial.turns[0].id, answer: "只参与参数校验，尚未上线。" } });
        expect(await answered.text()).toContain("event: done");
        const finish = await request.post(`${endpoint}/finish`);
        expect(finish.status()).toBe(200);
        const before = await (await request.get(endpoint)).json();
        expect(before.evaluator_report).toBeNull();
        let saved = false;
        let posts = 0;
        let reads = 0;
        let readFailures = 0;
        await page.route(`**${endpoint}`, async (route) => {
          if (saved && route.request().method() === "GET") {
            reads += 1;
            if (readFailures > 0) {
              readFailures -= 1;
              await route.fulfill({ status: 503, json: { error: "评估结果读取暂时失败" } });
              return;
            }
          }
          await route.continue();
        });
        await page.route(`**${endpoint}/evaluator-report`, async (route) => {
          posts += 1;
          expect(route.request().method()).toBe("POST");
          const response = await route.fetch();
          expect(response.status()).toBe(200);
          saved = true;
          await release.promise;
          readFailures = failReads ? 2 : 0;
          await route.fulfill({ status: 200, contentType: "application/json", body: "{broken" });
        });
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/interviews/${interview.id}`);
        const candidateTab = page.getByRole("button", { name: /候选人全景复盘报告/ });
        const evaluatorTab = page.getByRole("button", { name: /面试官模拟评估/ });
        await evaluatorTab.click();
        await page.getByRole("button", { name: "重试生成面试官评估", exact: true }).click();
        await expect.poll(() => saved).toBe(true);
        await candidateTab.click();
        await expect(page.getByText("只描述实际分工", { exact: true })).toBeVisible();
        await evaluatorTab.click();
        await expect(page.getByRole("button", { name: "面试官评估生成中…", exact: true })).toBeDisabled();
        expect(posts).toBe(1);
        release.release();
        if (failReads) {
          const error = page.getByRole("alert").filter({ hasText: "面试官评估保存状态暂无法确认" });
          await expect(error).toContainText("面试官评估保存状态暂无法确认");
          const retry = page.getByRole("button", { name: "重新读取面试官评估", exact: true });
          await expect(retry).toBeEnabled();
          await expect(page.getByRole("button", { name: "重试生成面试官评估", exact: true })).toHaveCount(0);
          await candidateTab.click();
          await evaluatorTab.click();
          await expect(error).toContainText("保存状态暂无法确认");
          await retry.click();
          await expect(error).toContainText("评估结果读取暂时失败");
          await expect(retry).toBeEnabled();
          expect(posts).toBe(1);
          expect(reads).toBe(2);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
          await error.scrollIntoViewIfNeeded();
          await page.screenshot({ path: testInfo.outputPath(`evaluator-read-error-${width}.png`) });
          await retry.click();
        }
        await expect(page.getByText(evaluator.summary_for_hr, { exact: true })).toBeVisible();
        expect(reads).toBe(failReads ? 3 : 1);
        await candidateTab.click();
        await evaluatorTab.click();
        await expect(page.getByText(evaluator.summary_for_hr, { exact: true })).toBeVisible();
        await page.reload();
        await evaluatorTab.click();
        await expect(page.getByText(evaluator.summary_for_hr, { exact: true })).toBeVisible();
        const after = await (await request.get(endpoint)).json();
        expect(after.report).toEqual(before.report);
        expect(after.finished_at).toBe(before.finished_at);
        expect(after.evaluator_report).toEqual(evaluator);
        expect(posts).toBe(1);
        expect(modelCalls).toBe(4);
        expect(replies).toHaveLength(0);
      } finally {
        release.release();
        provider.closeAllConnections();
        await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
        expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
      }
    });
  }
}
