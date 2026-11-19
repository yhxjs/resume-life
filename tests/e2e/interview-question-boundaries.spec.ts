import { listenForFetch } from "../support/http-server";
import { expect, test, type APIResponse } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import { publishResume } from "./resume-version-helpers";

for (const width of [390, 1280]) {
  test(`模拟面试 ${width}px：首题、续题与复盘完整显示边界题干`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000);
    const baseline = await exportEncryptedBackup(request);
    expect(baseline.response.ok()).toBe(true);
    const question = "A".repeat(800);
    const nextQuestion = "B".repeat(800);
    const comment = "说明了实际联调范围。";
    const replies: unknown[] = [
      { question },
      { depth: 7, structure: 8, authenticity: 8, completeness: 7, comment, next_question: nextQuestion, next_kind: "question" },
      { jd_match: 7, strengths: "分工明确", weaknesses: "验证结果待核实", suggestions: "补充真实验证记录" },
    ];
    const provider = createServer(async (incoming, outgoing) => {
      for await (const chunk of incoming) void chunk;
      const reply = replies.shift();
      outgoing.writeHead(reply ? 200 : 500, { "Content-Type": "text/event-stream" });
      outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(reply) } }] })}\n\ndata: [DONE]\n\n`);
    });
    await listenForFetch(provider);
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("Missing synthetic provider address");
    const done = async (response: APIResponse, text: string) => {
      expect(response.status()).toBe(200);
      const events = await response.text();
      expect(events).toContain(`event: delta\ndata: ${JSON.stringify({ text })}\n`);
      const match = events.match(/event: done\ndata: ([^\n]+)/);
      expect(match, events).not.toBeNull();
      return JSON.parse(match![1]!);
    };
    try {
      expect((await request.put("/api/settings", { data: {
        base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-question-boundaries-key",
        api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic",
      } })).ok()).toBe(true);
      const resumeResponse = await request.post("/api/resumes", { data: { title: "题干边界合成简历" } });
      expect(resumeResponse.status()).toBe(201);
      const resume = await resumeResponse.json();
      const version = await publishResume(request, resume.id);
      const interview = await done(await request.post("/api/interviews", { data: {
        resume_id: resume.id, resume_version_id: version.id, jd: "接口开发与联调", rounds: 2,
      } }), question);
      const endpoint = `/api/interviews/${interview.id}`;
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/interviews/${interview.id}`);
      const first = page.getByText(question, { exact: true });
      await expect(first).toBeVisible();
      expect(await first.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const initial = await request.get(endpoint);
      const turnId = (await initial.json()).turns[0].id;
      await done(await request.post(`${endpoint}/answer`, { data: { turn_id: turnId, answer: "本人只负责参数校验与联调。" } }), comment);
      await page.reload();
      const next = page.getByText(nextQuestion, { exact: true });
      await expect(next).toBeVisible();
      expect(await next.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect((await request.post(`${endpoint}/finish`)).status()).toBe(200);
      await page.reload();
      const review = page.getByRole("heading", { level: 3, name: question, exact: true });
      await expect(review).toBeVisible();
      expect(await review.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await review.screenshot({ path: testInfo.outputPath(`interview-question-${width}.png`) });
      expect(replies).toHaveLength(0);
    } finally {
      provider.closeAllConnections();
      await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
      expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
    }
  });
}
