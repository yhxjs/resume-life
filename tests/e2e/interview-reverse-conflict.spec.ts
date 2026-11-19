import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { listenForFetch } from "../support/http-server";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import { publishResume } from "./resume-version-helpers";

for (const width of [390, 1280]) {
  for (const kind of ["question", "report"] as const) {
    test(`反问冲突 ${width}px：另一处先保存${kind === "question" ? "不同问题" : "报告"}，保留草稿并只读核对`, async ({ page, request }, testInfo) => {
      test.setTimeout(90_000);
      const baseline = await exportEncryptedBackup(request);
      expect(baseline.response.ok()).toBe(true);
      const draft = "  我的反问 <T> &amp;\n如何核实尚未上线的验收边界？  ";
      const otherQuestion = "另一处提问：入职前三个月的目标如何确认？";
      const replies: unknown[] = [
        { question: "你个人负责哪些接口工作？" },
        { depth: 7, structure: 8, authenticity: 8, completeness: 7, comment: "职责明确", next_question: "", next_kind: "question" },
        kind === "question"
          ? { answer: "另一份模拟回应：实际目标仍需向招聘方核实。", evaluation: { score: 8, insight: "关注目标", feedback: "具体", suggestions: "核实安排" } }
          : { jd_match: 7, strengths: "另一处已生成的报告", weaknesses: "上线结果待核实", suggestions: "补充依据" },
      ];
      if (kind === "question") replies.push({ jd_match: 7, strengths: "核对冲突后主动生成的报告", weaknesses: "待核实", suggestions: "补充依据" });
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
      if (!address || typeof address === "string") throw new Error("Missing provider address");
      try {
        expect((await request.put("/api/settings", { data: {
          base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-reverse-conflict-key",
          api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic",
        } })).ok()).toBe(true);
        const resumeResponse = await request.post("/api/resumes", { data: { title: "反问冲突合成简历" } });
        expect(resumeResponse.status()).toBe(201);
        const resume = await resumeResponse.json();
        const version = await publishResume(request, resume.id);
        const created = await request.post("/api/interviews", { data: { resume_id: resume.id, resume_version_id: version.id, jd: "接口开发", rounds: 1 } });
        const match = (await created.text()).match(/event: done\ndata: ([^\n]+)/);
        expect(match).not.toBeNull();
        const interview = JSON.parse(match![1]!);
        const endpoint = `/api/interviews/${interview.id}`;
        const initial = await (await request.get(endpoint)).json();
        const answered = await request.post(`${endpoint}/answer`, { data: { turn_id: initial.turns[0].id, answer: "只负责接口校验，尚未上线。" } });
        expect(await answered.text()).toContain("event: done");
        let browserPosts = 0;
        let reportPosts = 0;
        let browserReads = 0;
        let readFailure = false;
        let saved: Record<string, unknown> | undefined;
        const pageErrors: string[] = [];
        page.on("pageerror", error => pageErrors.push(error.message));
        await page.route(`**${endpoint}`, async route => {
          browserReads++;
          if (readFailure) {
            readFailure = false;
            await route.fulfill({ status: 503, json: { error: "冲突结果暂时无法读取" } });
          } else await route.continue();
        });
        await page.route(`**${endpoint}/reverse`, async route => {
          browserPosts++;
          expect(route.request().postDataJSON()).toEqual({ question: draft.trim() });
          // 用真实 API 模拟另一处操作先提交，当前提交由真实路由拒绝。
          const competing = await request.post(`${endpoint}/${kind === "question" ? "reverse" : "finish"}`, { data: kind === "question" ? { question: otherQuestion } : {} });
          expect(competing.status()).toBe(200);
          saved = await (await request.get(endpoint)).json();
          const rejected = await route.fetch();
          expect(rejected.status()).toBe(400);
          readFailure = true;
          await route.fulfill({ response: rejected });
        });
        await page.route(`**${endpoint}/finish`, async route => { reportPosts++; await route.continue(); });
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/interviews/${interview.id}`);
        await page.getByRole("button", { name: /进入反问环节/ }).click();
        const dialog = page.getByRole("dialog", { name: "向面试官提问", exact: true });
        const input = dialog.getByRole("textbox", { name: "我的反问问题", exact: true });
        await input.fill(draft);
        await dialog.getByRole("button", { name: "向面试官提问", exact: true }).click();
        await expect(dialog.getByRole("alert")).toContainText("反问保存状态暂无法确认");
        await expect(input).toHaveValue(draft);
        await dialog.getByRole("button", { name: "重新读取反问状态", exact: true }).click();
        await expect(dialog.getByRole("alert")).toContainText(kind === "question" ? "不同的反问问题" : "未读取到本次反问");
        await expect(input).toHaveValue(draft);
        await expect(input).toHaveAttribute("readonly", "");
        await expect(input).toBeEnabled();
        await expect(dialog.getByRole("button", { name: "向面试官提问", exact: true })).toHaveCount(0);
        await expect(dialog.getByRole("button", { name: "放弃反问，直接生成报告", exact: true })).toHaveCount(0);
        await input.focus();
        await expect(input).toBeFocused();
        await input.press("ControlOrMeta+A");
        expect(await input.evaluate((element: HTMLTextAreaElement) => element.value.substring(element.selectionStart, element.selectionEnd))).toBe(draft);
        const viewSaved = dialog.getByRole("button", { name: "查看已保存结果", exact: true });
        await expect(viewSaved).toBeEnabled();
        expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
        await dialog.screenshot({ path: testInfo.outputPath(`reverse-conflict-${kind}-${width}.png`) });
        expect(browserPosts).toBe(1);
        expect(reportPosts).toBe(0);
        expect(browserReads).toBe(3);
        expect(modelCalls).toBe(3);
        expect(await (await request.get(endpoint)).json()).toEqual(saved);
        await viewSaved.click();
        await expect(dialog).toHaveCount(0);
        await expect(page.getByText(kind === "question" ? otherQuestion : "另一处已生成的报告", { exact: true })).toBeVisible();
        if (kind === "question") {
          await page.getByRole("button", { name: "立即生成全景报告", exact: true }).click();
          await expect(page.getByText("核对冲突后主动生成的报告", { exact: true })).toBeVisible();
          const afterReport = await (await request.get(endpoint)).json();
          expect(afterReport.turns).toEqual(saved?.turns);
          expect(afterReport.reverse_interview).toEqual(saved?.reverse_interview);
          saved = afterReport;
        }
        await page.reload();
        // 已有报告时，反问同时出现在报告摘要和问答回放；这里核对摘要中的原文。
        await expect(page.getByText(kind === "question" ? otherQuestion : "另一处已生成的报告", { exact: true }).first()).toBeVisible();
        expect(await (await request.get(endpoint)).json()).toEqual(saved);
        expect(browserPosts).toBe(1);
        expect(modelCalls).toBe(kind === "question" ? 4 : 3);
        expect(reportPosts).toBe(kind === "question" ? 1 : 0);
        expect(replies).toHaveLength(0);
        expect(pageErrors).toEqual([]);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      } finally {
        provider.closeAllConnections();
        await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
        expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
      }
    });
  }
}
