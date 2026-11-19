import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import { publishResume } from "./resume-version-helpers";
import { gate } from "./synthetic-api";

for (const width of [390, 1280]) {
  for (const lost of [false, true]) {
    test(`反问恢复 ${width}px：${lost ? "成功响应丢失" : "保存后读取失败"}，草稿保留且只重读`, async ({ page, request }, testInfo) => {
      test.setTimeout(90_000);
      const baseline = await exportEncryptedBackup(request);
      expect(baseline.response.ok()).toBe(true);
      const release = gate();
      const question = "岗位中的接口联调 <T> &amp;\n通常如何核实验收范围？";
      const responseText = "模拟回应 <T> &amp;：真实团队的验收安排尚未提供，请向招聘方核实。";
      const replies: unknown[] = [
        { question: "你个人负责哪些接口工作？" },
        { depth: 7, structure: 8, authenticity: 8, completeness: 7, comment: "职责边界明确", next_question: "", next_kind: "question" },
        { answer: responseText, evaluation: { score: 8, insight: "关注验收依据", feedback: "提问范围具体", suggestions: "向招聘方核实流程" } },
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
          base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-reverse-recovery-key",
          api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic",
        } })).ok()).toBe(true);
        const resumeResponse = await request.post("/api/resumes", { data: { title: "反问恢复合成简历" } });
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
        const initial = await request.get(endpoint);
        const turnId = (await initial.json()).turns[0].id;
        const answered = await request.post(`${endpoint}/answer`, { data: { turn_id: turnId, answer: "本人只负责接口校验，未上线。" } });
        expect(await answered.text()).toContain("event: done");
        let readFailures = 0;
        let posts = 0;
        let saved = false;
        await page.route(`**${endpoint}`, async (route) => {
          if (route.request().method() === "GET" && readFailures > 0) {
            readFailures -= 1;
            await route.fulfill({ status: 503, json: { error: "反问结果读取暂时失败" } });
          } else await route.continue();
        });
        await page.route(`**${endpoint}/reverse`, async (route) => {
          posts += 1;
          expect(route.request().postDataJSON()).toEqual({ question });
          const response = await route.fetch();
          expect(response.status()).toBe(200);
          saved = true;
          await release.promise;
          readFailures = 2;
          if (lost) await route.fulfill({ status: 200, contentType: "application/json", body: "{broken" });
          else await route.fulfill({ response });
        });
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/interviews/${interview.id}`);
        await page.getByRole("button", { name: /进入反问环节/ }).click();
        const dialog = page.getByRole("dialog", { name: "向面试官提问", exact: true });
        const input = dialog.getByRole("textbox", { name: "我的反问问题", exact: true });
        await input.fill(question);
        await dialog.getByRole("button", { name: "向面试官提问", exact: true }).click();
        await expect.poll(() => saved).toBe(true);
        await expect(input).toHaveValue(question);
        await expect(input).toBeDisabled();
        await expect(dialog.getByRole("button", { name: /^💡/ }).first()).toBeDisabled();
        await expect(dialog.getByRole("button", { name: "放弃反问，直接生成报告", exact: true })).toBeDisabled();
        release.release();
        const error = dialog.getByRole("alert");
        await expect(error).toContainText(lost ? "反问保存状态暂无法确认" : "反问已保存，读取结果失败");
        await expect(input).toHaveValue(question);
        const retry = dialog.getByRole("button", { name: lost ? "重新读取反问状态" : "重新读取已保存反问", exact: true });
        await expect(retry).toBeEnabled();
        await expect(dialog.getByRole("button", { name: "关闭反问弹窗", exact: true })).toBeDisabled();
        await page.keyboard.press("Escape");
        await expect(dialog).toBeVisible();
        expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        const dialogBox = await dialog.boundingBox();
        const retryBox = await retry.boundingBox();
        expect(dialogBox).not.toBeNull();
        expect(retryBox).not.toBeNull();
        expect(retryBox!.x).toBeGreaterThanOrEqual(dialogBox!.x);
        expect(retryBox!.x + retryBox!.width).toBeLessThanOrEqual(dialogBox!.x + dialogBox!.width);
        await dialog.screenshot({ path: testInfo.outputPath(`reverse-read-error-${width}-${lost}.png`) });
        await retry.click();
        await expect(error).toContainText("反问结果读取暂时失败");
        await expect(retry).toBeEnabled();
        await expect(input).toHaveValue(question);
        const stored = await request.get(endpoint);
        expect((await stored.json()).reverse_interview).toMatchObject({ question, answer: responseText });
        expect(posts).toBe(1);
        expect(modelCalls).toBe(3);
        await retry.click();
        await expect(dialog).toHaveCount(0);
        await expect(page.getByText(question, { exact: true })).toBeVisible();
        await expect(page.getByText(responseText, { exact: true })).toBeVisible();
        await expect(page.getByText("以下为 AI 根据已提供背景生成的模拟回应；真实公司的安排与承诺仍需向招聘方核实。", { exact: true })).toBeVisible();
        await page.reload();
        await expect(page.getByText(question, { exact: true })).toBeVisible();
        await expect(page.getByText(responseText, { exact: true })).toBeVisible();
        expect(posts).toBe(1);
        expect(modelCalls).toBe(3);
        expect(replies).toHaveLength(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      } finally {
        release.release();
        provider.closeAllConnections();
        await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
        expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
      }
    });
  }
}
