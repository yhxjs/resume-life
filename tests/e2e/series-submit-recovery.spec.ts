import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import { publishResume } from "./resume-version-helpers";
import { gate } from "./synthetic-api";

for (const width of [390, 1280]) {
  for (const scenario of ["finalize", "advance", "detail-advance", "stale-detail", "stale-overview"] as const) {
    const fromDetail = scenario === "detail-advance" || scenario === "stale-detail";
    const stale = scenario.startsWith("stale-");
    const action = scenario === "finalize" ? "finalize" : "advance";
    test(`系列恢复 ${width}px：${scenario} ${stale ? "其他页面已完成二面，旧页仍只进入二面" : "保存后响应丢失、连续读取失败只重读"}`, async ({ page, request }, testInfo) => {
      test.setTimeout(120_000);
      const baseline = await exportEncryptedBackup(request);
      expect(baseline.response.ok()).toBe(true);
      const release = gate();
      const report = { verdict: "跨轮总评恢复：根据已答报告整理，结果尚未验证。", strengths: "分工清楚", weaknesses: "上线结果待核实", suggestions: "核实验证范围" };
      const replies: unknown[] = [];
      const count = action === "finalize" ? 3 : 1;
      for (let round = 1; round <= count; round += 1) {
        replies.push(
          { question: `第${round}轮：请说明你参与校验任务的范围。` },
          { depth: 7, structure: 8, authenticity: 8, completeness: 7, comment: "分工明确", next_question: "", next_kind: "question" },
          { jd_match: 7, strengths: "职责明确", weaknesses: "结果尚未核实", suggestions: "核实验证范围" },
        );
      }
      replies.push(action === "finalize" ? report : { question: "请解释一次接口变更的验收方法。" });
      if (stale) replies.push(
        { depth: 7, structure: 8, authenticity: 8, completeness: 7, comment: "职责明确", next_question: "", next_kind: "question" },
        { jd_match: 7, strengths: "职责明确", weaknesses: "上线待核实", suggestions: "核实验证范围" },
      );
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
          base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-series-recovery-key",
          api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic",
        } })).ok()).toBe(true);
        const resumeResponse = await request.post("/api/resumes", { data: { title: "系列恢复合成简历" } });
        expect(resumeResponse.status()).toBe(201);
        const resume = await resumeResponse.json();
        const version = await publishResume(request, resume.id);
        const created = await request.post("/api/interviews", { data: {
          resume_id: resume.id, resume_version_id: version.id, jd: "接口维护与校验", mode: "series", rounds: 1,
        } });
        expect(created.status()).toBe(200);
        const createdEvents = await created.text();
        const match = createdEvents.match(/event: done\ndata: ([^\n]+)/);
        expect(match, createdEvents).not.toBeNull();
        const interview = JSON.parse(match![1]!);
        const endpoint = `/api/interviews/series/${interview.series_id}`;
        let interviewId = interview.id;
        for (let round = 1; round <= count; round += 1) {
          const initial = await (await request.get(`/api/interviews/${interviewId}`)).json();
          const answer = await request.post(`/api/interviews/${interviewId}/answer`, { data: { turn_id: initial.turns[0].id, answer: "只参与校验，尚未上线。" } });
          expect(await answer.text()).toContain("event: done");
          expect((await request.post(`/api/interviews/${interviewId}/finish`)).status()).toBe(200);
          if (round < count) {
            const next = await request.post(`${endpoint}/advance`, { data: { from_interview_id: interviewId } });
            expect(next.status()).toBe(201);
            interviewId = (await next.json()).id;
          }
        }
        const before = await (await request.get(endpoint)).json();
        let posts = 0;
        let reads = 0;
        let readFailures = 0;
        let saved = false;
        let nextId = 0;
        let finishedAt = "";
        await page.route(`**${endpoint}`, async (route) => {
          if (saved && route.request().method() === "GET") {
            reads += 1;
            if (readFailures > 0) {
              readFailures -= 1;
              await route.fulfill({ status: 503, json: { error: "系列状态临时读取失败" } });
              return;
            }
          }
          await route.continue();
        });
        await page.route(`**${endpoint}/${action}`, async (route) => {
          posts += 1;
          if (action === "advance") expect(route.request().postDataJSON()).toEqual({ from_interview_id: interview.id });
          expect(route.request().method()).toBe("POST");
          const response = await route.fetch();
          expect(response.status()).toBe(action === "finalize" ? 200 : 201);
          const body = await response.json();
          if (stale) {
            expect(body.id).toBe(nextId);
            expect(body.round_no).toBe(2);
            await route.fulfill({ response });
            return;
          }
          nextId = body.id ?? 0;
          finishedAt = body.finished_at ?? "";
          saved = true;
          await release.promise;
          readFailures = 2;
          await route.fulfill({ status: 200, contentType: "application/json", body: "{broken" });
        });
        await page.setViewportSize({ width, height: 900 });
        await page.goto(fromDetail ? `/interviews/${interview.id}` : `/interviews/series/${interview.series_id}`);
        const generate = page.getByRole("button", { name: action === "finalize" ? "一键生成跨轮总评 🏆" : /进入 二面/ });
        if (stale) {
          await expect(generate).toBeVisible();
          const createdNext = await request.post(`${endpoint}/advance`, { data: { from_interview_id: interview.id } });
          expect(createdNext.status()).toBe(201);
          nextId = (await createdNext.json()).id;
          const second = await (await request.get(`/api/interviews/${nextId}`)).json();
          expect(await (await request.post(`/api/interviews/${nextId}/answer`, { data: {
            turn_id: second.turns[0].id, answer: "只参与校验，尚未上线。",
          } })).text()).toContain("event: done");
          expect((await request.post(`/api/interviews/${nextId}/finish`)).status()).toBe(200);
          const savedSecond = await (await request.get(endpoint)).json();
          expect(modelCalls).toBe(6);
          await generate.click();
          await expect(page).toHaveURL(new RegExp(`/interviews/${nextId}$`));
          expect(await (await request.get(endpoint)).json()).toEqual(savedSecond);
          await page.reload();
          await expect(page.getByRole("heading", { name: /模拟面试实战/ })).toBeVisible();
          expect(posts).toBe(1);
          expect(modelCalls).toBe(6);
          expect(replies).toHaveLength(0);
          return;
        }
        await generate.click();
        await expect.poll(() => saved).toBe(true);
        const busy = page.getByRole("button", { name: action === "finalize" ? "正在合成总评中…" : fromDetail ? "考官正在准备第一题…" : "面试官命题中…", exact: true });
        await expect(busy).toBeDisabled();
        if (fromDetail) await expect(page.getByRole("button", { name: "按练习重点生成追练题", exact: true })).toBeDisabled();
        release.release();
        const error = page.getByRole("alert").filter({ hasText: "状态暂无法确认" });
        await expect(error).toContainText(action === "finalize" ? "跨轮总评保存状态暂无法确认" : "下一轮创建状态暂无法确认");
        const retry = page.getByRole("button", { name: "重新读取系列状态", exact: true });
        await expect(retry).toBeEnabled();
        await expect(generate).toHaveCount(0);
        if (fromDetail) await expect(page.getByRole("button", { name: "按练习重点生成追练题", exact: true })).toBeDisabled();
        await retry.click();
        await expect(error).toContainText("系列状态临时读取失败");
        await expect(retry).toBeEnabled();
        expect(reads).toBe(2);
        expect(posts).toBe(1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await error.scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath(`series-read-error-${scenario}-${width}.png`) });
        await retry.click();
        if (action === "finalize") {
          await expect(page.getByText(report.verdict, { exact: true })).toBeVisible();
          await page.reload();
          await expect(page.getByText(report.verdict, { exact: true })).toBeVisible();
        } else {
          await expect(page).toHaveURL(new RegExp(`/interviews/${nextId}$`));
          await expect(page.getByText("请解释一次接口变更的验收方法。", { exact: true })).toBeVisible();
          await page.reload();
          await expect(page.getByText("请解释一次接口变更的验收方法。", { exact: true })).toBeVisible();
        }
        const after = await (await request.get(endpoint)).json();
        if (action === "finalize") {
          expect(after.entries).toEqual(before.entries);
          expect(after.final_report).toEqual({ ...report, overall: 7.4 });
          expect(after.finished_at).toBe(finishedAt);
        } else {
          expect(after.entries.slice(0, 1)).toEqual(before.entries);
          expect(after.entries).toHaveLength(2);
          expect(after.entries[1].interview_id).toBe(nextId);
          expect(after.entries[1].round_no).toBe(2);
        }
        expect(posts).toBe(1);
        expect(modelCalls).toBe(count * 3 + 1);
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
