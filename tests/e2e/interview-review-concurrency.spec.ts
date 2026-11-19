import { listenForFetch } from "../support/http-server";
import { expect, test, type APIResponse } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import { publishResume } from "./resume-version-helpers";
import { gate } from "./synthetic-api";

for (const width of [390, 1280]) {
  for (const order of ["参考先返回", "重答先返回"]) {
    test(`复盘并发 ${width}px ${order}：切换实况保留草稿与等待，旧响应不覆盖新参考`, async ({ page, request }, testInfo) => {
      test.setTimeout(90_000);
      const baseline = await exportEncryptedBackup(request);
      expect(baseline.response.ok()).toBe(true);
      const original = "原答：只负责参数校验 <T> &amp;，未上线。";
      const answer = "本次重答：还负责联调 <T> &amp;\n没有选型权，结果待核实。";
      const oldReference = "原先的题目参考：只说明已提供的分工。";
      const reference = "最新题目参考 <T> &amp;\n依据原答保留未上线边界。";
      const retryReference = "本次重答参考 <T> &amp;\n[待补充：真实联调记录]。";
      const replies: unknown[] = [
        { question: "并发验证：你个人负责哪些接口工作？" },
        { depth: 7, structure: 8, authenticity: 9, completeness: 7, comment: "原答点评", next_question: "如何核对验证范围？", next_kind: "question" },
        { jd_match: 7, strengths: "分工清楚", weaknesses: "验证记录待核实", suggestions: "补充真实记录" },
        { reference: oldReference },
        { depth: 8, structure: 8, authenticity: 9, completeness: 8, comment: "本次重答点评", reference: retryReference },
        { reference },
      ];
      const inputs: string[] = [];
      const provider = createServer(async (incoming, outgoing) => {
        let raw = "";
        for await (const chunk of incoming) raw += chunk;
        inputs.push(raw);
        const reply = replies.shift();
        if (!reply) {
          outgoing.writeHead(500);
          outgoing.end("Unexpected synthetic provider request");
          return;
        }
        outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
        outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(reply) } }] })}\n\ndata: [DONE]\n\n`);
      });
      await listenForFetch(provider);
      const address = provider.address();
      if (!address || typeof address === "string") throw new Error("Missing synthetic provider address");
      const done = async (response: APIResponse) => {
        expect(response.status()).toBe(200);
        const events = await response.text();
        const match = events.match(/event: done\ndata: ([^\n]+)/);
        expect(match, events).not.toBeNull();
        return JSON.parse(match![1]!);
      };
      const retrySaved = gate();
      const referenceSaved = gate();
      const retryResponse = gate();
      const referenceResponse = gate();
      try {
        expect((await request.put("/api/settings", { data: {
          base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-review-concurrency-key", api_format: "openai_chat",
          model_question: "synthetic", model_evaluate: "synthetic",
        } })).ok()).toBe(true);
        const resumeResponse = await request.post("/api/resumes", { data: { title: "复盘并发合成简历" } });
        expect(resumeResponse.status()).toBe(201);
        const resume = await resumeResponse.json();
        const version = await publishResume(request, resume.id);
        const interview = await done(await request.post("/api/interviews", { data: {
          resume_id: resume.id, resume_version_id: version.id, jd: "接口开发与参数校验", rounds: 3,
        } }));
        const endpoint = `/api/interviews/${interview.id}`;
        const initial = await request.get(endpoint);
        expect(initial.ok()).toBe(true);
        const turnId = (await initial.json()).turns[0].id as number;
        await done(await request.post(`${endpoint}/answer`, { data: { turn_id: turnId, answer: original } }));
        expect((await request.post(`${endpoint}/finish`)).status()).toBe(200);
        expect((await request.post(`${endpoint}/turns/${turnId}/reference`)).status()).toBe(200);
        // 仅延迟真实 HTTP 响应；生成、事务提交和回读仍经过生产路由与隔离 SQLite。
        await page.route(`**${endpoint}/turns/${turnId}/retry`, async (route) => {
          expect(route.request().postDataJSON()).toEqual({ answer });
          const response = await route.fetch();
          expect(response.status()).toBe(200);
          expect((await response.json()).reference).toBe(oldReference);
          retrySaved.release();
          await retryResponse.promise;
          await route.fulfill({ response });
        });
        await page.route(`**${endpoint}/turns/${turnId}/reference`, async (route) => {
          const response = await route.fetch();
          expect(response.status()).toBe(200);
          expect(await response.json()).toEqual({ reference });
          referenceSaved.release();
          await referenceResponse.promise;
          await route.fulfill({ response });
        });
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/interviews/${interview.id}`);
        const card = page.locator(`#turn-${turnId}`);
        const input = card.getByRole("textbox", { name: /重新作答此题/ });
        const displayedReference = card.getByRole("region", { name: "当前回答参考", exact: true });
        const showChat = () => page.getByRole("button", { name: /现场问答实况流/ }).click();
        const showReview = () => page.getByRole("button", { name: /复盘重放/ }).click();
        await card.getByRole("button", { name: /重答这一题/ }).click();
        await input.fill(answer);
        await showChat();
        await expect(card).toBeHidden();
        await showReview();
        await expect(input).toHaveValue(answer);
        expect(inputs).toHaveLength(4);
        await card.getByRole("button", { name: "提交并重新评分", exact: true }).click();
        await retrySaved.promise;
        await card.getByRole("button", { name: "重新生成", exact: true }).click();
        await referenceSaved.promise;
        const committed = await request.get(endpoint);
        expect(committed.ok()).toBe(true);
        const committedTurn = (await committed.json()).turns[0];
        expect(committedTurn).toMatchObject({ answer: original, reference });
        expect(committedTurn.retries).toEqual([expect.objectContaining({ answer, reference: retryReference })]);
        await showChat();
        await expect(card).toBeHidden();
        await showReview();
        await expect(input).toHaveValue(answer);
        await expect(input).toBeDisabled();
        await expect(card.getByRole("button", { name: "面试官正在评分中…", exact: true })).toBeDisabled();
        await expect(card.getByRole("button", { name: "生成中…", exact: true })).toBeDisabled();
        expect(inputs).toHaveLength(6);
        if (order === "参考先返回") {
          referenceResponse.release();
          await expect(displayedReference).toHaveText(reference);
          await expect(input).toBeDisabled();
          retryResponse.release();
        } else {
          retryResponse.release();
          await expect(displayedReference).toHaveText(retryReference);
          referenceResponse.release();
        }
        await expect(input).toHaveCount(0);
        await expect(displayedReference).toHaveText(retryReference);
        await card.getByRole("button", { name: "查看题目参考", exact: true }).click();
        await expect(displayedReference).toHaveText(reference);
        await showChat();
        await showReview();
        await expect(displayedReference).toHaveText(reference);
        await expect(card.getByText(original, { exact: true })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await card.screenshot({ path: testInfo.outputPath(`review-concurrency-${width}-${order}.png`) });
        await page.reload();
        await expect(displayedReference).toHaveText(retryReference);
        await card.getByRole("button", { name: "查看题目参考", exact: true }).click();
        await expect(displayedReference).toHaveText(reference);
        expect(inputs).toHaveLength(6);
        expect(replies).toHaveLength(0);
      } finally {
        retryResponse.release();
        referenceResponse.release();
        provider.closeAllConnections();
        await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
        expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
      }
    });
  }
}
