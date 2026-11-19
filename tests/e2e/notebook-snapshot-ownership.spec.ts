import { listenForFetch } from "../support/http-server";
import { expect, test, type APIResponse } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import { publishResume } from "./resume-version-helpers";

for (const width of [390, 1280]) {
  test(`面试收藏 ${width}px：重答参考独立保存，原题生成才补全原答快照`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000);
    const baseline = await exportEncryptedBackup(request);
    expect(baseline.response.ok()).toBe(true);
    const question = "快照归属验证：你个人负责了哪些接口工作？";
    const original = "原答：只做参数校验 <T> &amp;，尚未上线。";
    const revised = "重答：还负责联调 <T> &amp;，上线结果仍待验证。";
    const retryReference = "本次重答参考 <T> &amp;\n[待补充：真实联调记录]。";
    const originalReference = "原答题目参考 <T> &amp;\n只说明已提供的参数校验分工。";
    const replies: unknown[] = [
      { question },
      { depth: 7, structure: 8, authenticity: 9, completeness: 7, comment: "原答点评：保留未上线边界", next_question: "如何核对验证范围？", next_kind: "question" },
      { jd_match: 7, strengths: "分工清楚", weaknesses: "联调记录待核对", suggestions: "补充真实记录" },
      { depth: 8, structure: 8, authenticity: 9, completeness: 8, comment: "重答点评：新增联调说明", reference: retryReference },
      { reference: originalReference },
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
    try {
      expect((await request.put("/api/settings", { data: {
        base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-snapshot-ownership-key", api_format: "openai_chat",
        model_question: "synthetic", model_evaluate: "synthetic",
      } })).ok()).toBe(true);
      const resumeResponse = await request.post("/api/resumes", { data: { title: "快照归属合成简历" } });
      expect(resumeResponse.status()).toBe(201);
      const resume = await resumeResponse.json();
      const version = await publishResume(request, resume.id);
      const interview = await done(await request.post("/api/interviews", { data: {
        resume_id: resume.id, resume_version_id: version.id, jd: "接口开发与参数校验", rounds: 3,
      } }));
      const endpoint = `/api/interviews/${interview.id}`;
      const createdResponse = await request.get(endpoint);
      expect(createdResponse.ok()).toBe(true);
      const turnId = (await createdResponse.json()).turns[0].id as number;
      await done(await request.post(`${endpoint}/answer`, { data: { turn_id: turnId, answer: original } }));
      expect((await request.post(`${endpoint}/finish`)).status()).toBe(200);
      const collected = await request.post("/api/notebook", { data: { source: "interview", source_id: turnId } });
      expect(collected.status()).toBe(201);
      const notebook = await collected.json();
      const savedResponse = await request.get(`/api/notebook/${notebook.id}`);
      expect(savedResponse.ok()).toBe(true);
      const snapshot = await savedResponse.json();
      expect(snapshot).toMatchObject({ answer: original, reference: "", comment: "原答点评：保留未上线边界" });

      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/interviews/${interview.id}`);
      const card = page.locator(`#turn-${turnId}`);
      await card.getByRole("button", { name: /重答这一题/ }).click();
      await card.getByRole("textbox", { name: /重新作答此题/ }).fill(revised);
      await card.getByRole("button", { name: "提交并重新评分", exact: true }).click();
      await expect(card.getByRole("region", { name: "当前回答参考", exact: true })).toHaveText(retryReference);
      await expect(card.getByText(revised, { exact: true })).toBeVisible();
      const savedInterview = await request.get(endpoint);
      expect(savedInterview.ok()).toBe(true);
      const savedTurn = (await savedInterview.json()).turns[0];
      expect(savedTurn).toMatchObject({ answer: original, reference: "", comment: snapshot.comment });
      expect(savedTurn.retries).toEqual([expect.objectContaining({ answer: revised, reference: retryReference })]);
      const preserved = await request.get(`/api/notebook/${notebook.id}`);
      expect(preserved.ok()).toBe(true);
      expect(await preserved.json()).toEqual(snapshot);
      const review = await request.get(`/api/reviews/${notebook.review.review_card_id}`);
      expect(review.ok()).toBe(true);
      expect(await review.json()).toMatchObject({ answer: original, reference: "", comment: snapshot.comment });
      await page.reload();
      await expect(card.getByRole("region", { name: "当前回答参考", exact: true })).toHaveText(retryReference);
      await card.getByRole("button", { name: "查看题目参考", exact: true }).click();
      await expect(card.getByRole("region", { name: "当前回答参考", exact: true })).toHaveCount(0);
      await expect(card.getByText(original, { exact: true })).toBeVisible();
      expect(inputs).toHaveLength(4);
      await card.getByRole("button", { name: "✨ 生成参考答案", exact: true }).click();
      await expect(card.getByRole("region", { name: "当前回答参考", exact: true })).toHaveText(originalReference);
      await card.getByRole("button", { name: /重答#1/ }).click();
      await expect(card.getByRole("region", { name: "当前回答参考", exact: true })).toHaveText(retryReference);
      expect(await card.getByRole("button", { name: "取消收藏", exact: true })
        .evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(32);
      await page.screenshot({ path: testInfo.outputPath(`interview-snapshot-${width}.png`), fullPage: true });

      const completed = await request.get(`/api/notebook/${notebook.id}`);
      expect(completed.ok()).toBe(true);
      expect(await completed.json()).toEqual({ ...snapshot, reference: originalReference });
      await page.goto("/notebook");
      await page.getByRole("heading", { name: question, exact: true }).getByRole("button", { name: question, exact: true }).click();
      await expect(page.getByText(original, { exact: true })).toBeVisible();
      await expect(page.getByText(originalReference, { exact: true })).toBeVisible();
      await expect(page.getByText(revised, { exact: true })).toHaveCount(0);
      await expect(page.getByText(retryReference, { exact: true })).toHaveCount(0);
      await page.reload();
      await page.getByRole("heading", { name: question, exact: true }).click();
      await expect(page.getByText(originalReference, { exact: true })).toBeVisible();
      if (width === 390) {
        expect(await page.getByRole("heading", { name: question, exact: true })
          .evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(250);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`notebook-snapshot-${width}.png`), fullPage: true });
      await page.goto(`/reviews?card=${notebook.review.review_card_id}`);
      await page.getByLabel("本次回答", { exact: true }).fill("本次独立回忆，不写入收藏原答。");
      await page.getByRole("button", { name: "查看参考并自评" }).click();
      await expect(page.getByText(originalReference, { exact: true })).toBeVisible();
      await expect(page.getByText(retryReference, { exact: true })).toHaveCount(0);
      expect(inputs).toHaveLength(5);
      expect(replies).toHaveLength(0);
      const user = JSON.parse(inputs[4]!).messages.filter((message: { role: string }) => message.role === "user")
        .map((message: { content: string }) => message.content).join("\n");
      expect(user).toContain(original.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
      expect(user).not.toContain("重答：还负责联调");
    } finally {
      provider.closeAllConnections();
      await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
      expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
    }
  });
}
