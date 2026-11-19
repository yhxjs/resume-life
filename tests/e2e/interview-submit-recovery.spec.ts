import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import { publishResume } from "./resume-version-helpers";

for (const width of [390, 1280]) {
  for (const responseMode of ["done", "missing-done", "invalid-json"] as const) {
    const lost = responseMode !== "done";
    const label = responseMode === "invalid-json" ? "HTTP 200 HTML" : lost ? "完成响应丢失" : "完成后读取失败";
    test(`面试提交恢复 ${width}px：${label}，作答与报告只读取不重复生成`, async ({ page, request }, testInfo) => {
      test.setTimeout(90_000);
      const baseline = await exportEncryptedBackup(request);
      expect(baseline.response.ok()).toBe(true);
      const answer = "本人只负责接口联调 <T> &amp;。\n未上线，效果尚未验证。";
      const comment = "已说明本人联调动作和验证边界。";
      const strengths = "本轮报告：职责边界明确";
      const replies: unknown[] = [
        { question: "你个人负责哪些接口工作？" },
        { depth: 7, structure: 8, authenticity: 8, completeness: 7, comment, next_question: "", next_kind: "question" },
        { jd_match: 7, strengths, weaknesses: "上线效果待核实", suggestions: "补充真实验证记录" },
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
          base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-submit-recovery-key",
          api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic",
        } })).ok()).toBe(true);
        const resumeResponse = await request.post("/api/resumes", { data: { title: "面试提交恢复合成简历" } });
        expect(resumeResponse.status()).toBe(201);
        const resume = await resumeResponse.json();
        const version = await publishResume(request, resume.id);
        const created = await request.post("/api/interviews", { data: {
          resume_id: resume.id, resume_version_id: version.id, jd: "接口开发与联调", rounds: 1,
        } });
        const match = (await created.text()).match(/event: done\ndata: ([^\n]+)/);
        expect(match).not.toBeNull();
        const interview = JSON.parse(match![1]!);
        const endpoint = `/api/interviews/${interview.id}`;
        let readFailures = 0;
        let answerPosts = 0;
        let reportPosts = 0;
        await page.route(`**${endpoint}`, async (route) => {
          if (route.request().method() === "GET" && readFailures > 0) {
            readFailures -= 1;
            await route.fulfill({ status: 503, json: { error: "合成读取暂时失败" } });
          } else await route.continue();
        });
        await page.route(`**${endpoint}/answer`, async (route) => {
          answerPosts += 1;
          const response = await route.fetch();
          expect(response.status()).toBe(200);
          expect(await response.text()).toContain("event: done");
          readFailures = 2;
          // 保存真实 SQLite 后，才截断给浏览器的完成事件。
          if (responseMode === "invalid-json") await route.fulfill({ status: 200, contentType: "text/html", body: "<html>应用正在重启</html>" });
          else if (lost) await route.fulfill({ status: 200, contentType: "text/event-stream", body: 'event: delta\ndata: {"text":"反馈到达但完成事件丢失"}\n\n' });
          else await route.fulfill({ response });
        });
        await page.route(`**${endpoint}/finish`, async (route) => {
          reportPosts += 1;
          const response = await route.fetch();
          expect(response.status()).toBe(200);
          readFailures = 2;
          if (lost) await route.fulfill({ status: 200, contentType: "application/json", body: "{broken" });
          else await route.fulfill({ response });
        });
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/interviews/${interview.id}`);
        const input = page.getByRole("textbox", { name: "以候选人身份组织作答：", exact: true });
        await input.fill(answer);
        await input.press("Control+Enter");
        const error = page.getByRole("alert").filter({ hasText: "请重新读取面试状态" });
        await expect(error).toContainText(lost ? "保存状态暂无法确认" : "作答已保存，读取结果失败");
        const draft = page.getByRole("textbox", { name: "保留的回答草稿", exact: true });
        await expect(draft).toHaveValue(answer);
        await expect(draft).toHaveAttribute("readonly", "");
        await expect(page.getByRole("button", { name: "提交回答", exact: true })).toHaveCount(0);
        const stored = await request.get(endpoint);
        const storedTurn = (await stored.json()).turns[0];
        expect(storedTurn).toMatchObject({ answer, comment });
        expect(storedTurn.answered_at).toBeTruthy();
        const retryAnswer = page.getByRole("button", { name: lost ? "重新读取面试状态" : "重新读取已保存作答", exact: true });
        await retryAnswer.click();
        await expect(error).toContainText("合成读取暂时失败");
        await expect(retryAnswer).toBeEnabled();
        await expect(draft).toHaveValue(answer);
        expect(answerPosts).toBe(1);
        expect(modelCalls).toBe(2);
        await retryAnswer.click();
        await expect(page.getByRole("dialog", { name: "主提问环节已全部完成！", exact: true })).toBeVisible();
        await expect(page.getByText(answer, { exact: true })).toBeVisible();
        await expect(page.getByText(`面试官点评：${comment}`, { exact: true })).toBeVisible();
        await page.getByRole("button", { name: "跳过，直接生成报告", exact: true }).click();
        await expect(error).toContainText(lost ? "保存状态暂无法确认" : "报告已保存，读取结果失败");
        const retryReport = page.getByRole("button", { name: lost ? "重新读取面试状态" : "重新读取已保存报告", exact: true });
        await retryReport.click();
        await expect(error).toContainText("合成读取暂时失败");
        await expect(retryReport).toBeEnabled();
        expect(reportPosts).toBe(1);
        expect(modelCalls).toBe(3);
        await retryReport.click();
        await expect(page.getByText(strengths, { exact: true })).toBeVisible();
        expect(answerPosts).toBe(1);
        expect(reportPosts).toBe(1);
        expect(modelCalls).toBe(3);
        expect(replies).toHaveLength(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`submit-recovered-${width}-${lost}.png`), fullPage: true });
      } finally {
        provider.closeAllConnections();
        await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
        expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
      }
    });
  }
}
