import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import { gate } from "./synthetic-api";

for (const width of [390, 1280]) {
  test(`专项练习 ${width}px：切题与等待不丢草稿，读取失败只重读，已评分原答真实保存回读`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000);
    const baseline = await exportEncryptedBackup(request);
    expect(baseline.response.ok()).toBe(true);
    const first = gate();
    const second = gate();
    const original = "只参与参数校验 <T> &amp;\n尚未上线，收益未统计。";
    const revised = `${original}\n个人负责联调，结果待验证。`;
    const latest = `${revised}；补充：不负责架构选型。`;
    const reference = "假设采用缓存 <T> &amp;\n[待补充：真实方案]，不能视为已验证成果。";
    const unbrokenQuestion = "A".repeat(800);
    const grade = (comment: string) => ({ depth: 7, structure: 8, authenticity: 9, completeness: 7, comment, reference });
    const replies: { data: unknown; wait?: Promise<void> }[] = [
      { data: { questions: [{ question: unbrokenQuestion, kind: "tech" }, { question: "尚未上线时如何说明验证范围？", kind: "behavior" }] } },
      { data: grade("第一次原答对应点评"), wait: first.promise },
      { data: grade("第二次原答对应点评"), wait: second.promise },
      { data: grade("最终原答对应点评") },
    ];
    const inputs: string[] = [];
    const unexpected: string[] = [];
    const provider = createServer(async (incoming, outgoing) => {
      let raw = "";
      for await (const chunk of incoming) raw += chunk;
      const reply = replies.shift();
      if (!reply) {
        unexpected.push(raw);
        outgoing.writeHead(500, { "Content-Type": "application/json" });
        outgoing.end(JSON.stringify({ error: "Unexpected synthetic provider request" }));
        return;
      }
      inputs.push(raw);
      if (reply.wait) await reply.wait;
      outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
      outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(reply.data) } }] })}\n\ndata: [DONE]\n\n`);
    });
    await listenForFetch(provider);
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("Missing synthetic provider address");
    try {
      expect((await request.put("/api/settings", { data: {
        base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-drill-boundaries-key",
        api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic",
      } })).ok()).toBe(true);
      const created = await request.post("/api/drills", { data: { source: "bank", direction: "接口工程师", count: 2 } });
      expect(created.status()).toBe(201);
      const id = (await created.json()).id as number;
      const endpoint = `/api/drills/${id}`;
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/drills/${id}`);
      const questionHeading = page.getByRole("heading", { level: 2 });
      await expect(questionHeading).toHaveText(unbrokenQuestion);
      expect(await questionHeading.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const input = page.getByRole("textbox");
      await expect(input).toHaveAccessibleName("我的现场回答：");
      await input.fill(original);
      await page.getByRole("button", { name: "提交作答并获取批阅", exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: "第 1 题正在评分" })).toBeVisible();
      await input.fill(revised);
      await page.getByRole("button", { name: "第 2 题", exact: true }).click();
      await expect(input).toHaveValue("");
      await input.fill("第二题独立草稿，未提交评分。");
      await expect(page.getByRole("button", { name: "请等待当前评分完成" })).toBeDisabled();
      await page.getByRole("button", { name: "第 1 题", exact: true }).click();
      await expect(input).toHaveValue(revised);
      await page.getByRole("button", { name: "第 2 题", exact: true }).click();
      first.release();
      await expect(page.getByRole("button", { name: "第 1 题（已答）", exact: true })).toBeVisible();
      await expect(input).toHaveValue("第二题独立草稿，未提交评分。");
      await expect(page.getByText("第一次原答对应点评", { exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "第 1 题（已答）", exact: true }).click();
      await expect(input).toHaveValue(revised);
      await expect(input).toHaveAccessibleName("重新回忆并作答：");
      await expect(page.getByRole("region", { name: "本题回答参考", exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "保存并重新打分", exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: "第 1 题正在评分" })).toBeVisible();
      await input.focus();
      await input.press("Control+End");
      await input.pressSequentially("；补充：不负责架构选型。");
      await expect(input).toHaveValue(latest);
      second.release();
      await expect(page.getByRole("button", { name: "保存并重新打分", exact: true })).toBeEnabled();
      await expect(input).toHaveValue(latest);
      await expect(page.getByText("第二次原答对应点评", { exact: true })).toHaveCount(0);

      let failNextRead = true;
      await page.route(`**${endpoint}`, async (route) => {
        if (failNextRead && route.request().method() === "GET") {
          failNextRead = false;
          await route.fulfill({ status: 503, json: { error: "本次读取暂时失败" } });
        } else await route.continue();
      });
      await page.getByRole("button", { name: "保存并重新打分", exact: true }).click();
      const readError = page.getByRole("alert").filter({ hasText: "评分已保存，读取结果失败" });
      await expect(readError).toContainText("本次读取暂时失败");
      await expect(input).toHaveValue(latest);
      const callsBeforeRetry = inputs.length;
      expect(callsBeforeRetry).toBe(4);
      await page.getByRole("button", { name: "重新读取已保存评分", exact: true }).click();
      await expect(page.getByText("最终原答对应点评", { exact: true })).toBeVisible();
      await expect(readError).toHaveCount(0);
      await expect(page.getByText(latest, { exact: true })).toBeVisible();
      await expect(page.getByRole("region", { name: "本题回答参考", exact: true }).getByText(reference, { exact: true })).toBeVisible();
      expect(inputs).toHaveLength(callsBeforeRetry);
      const savedResponse = await request.get(endpoint);
      expect(savedResponse.ok()).toBe(true);
      const saved = await savedResponse.json();
      expect(saved.questions[0].answer).toBe(latest);
      expect(saved.questions[0].comment).toBe("最终原答对应点评");
      expect(saved.questions[0].reference).toBe(reference);
      expect(saved.questions[1].answer).toBe("");
      expect(saved.questions[1].answered_at).toBe("");
      await page.getByRole("button", { name: "第 2 题", exact: true }).click();
      await expect(input).toHaveValue("第二题独立草稿，未提交评分。");
      await page.reload();
      await page.getByRole("button", { name: "第 1 题（已答）", exact: true }).click();
      await expect(page.getByText(latest, { exact: true })).toBeVisible();
      await expect(page.getByText("最终原答对应点评", { exact: true })).toBeVisible();
      await expect(page.getByRole("region", { name: "本题回答参考", exact: true }).getByText(reference, { exact: true })).toBeVisible();

      // 收藏和复习关联来自真实事务，不依赖刷新页面或重新调用模型。
      const collected = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/notebook" && response.request().method() === "POST");
      await page.getByRole("button", { name: "收藏到错题本", exact: true }).click();
      await page.getByRole("dialog", { name: "收藏到错题本", exact: true }).getByRole("button", { name: "收藏", exact: true }).click();
      const collectedResponse = await collected;
      expect(collectedResponse.status()).toBe(201);
      const notebook = await collectedResponse.json();
      const reviewLink = page.getByRole("link", { name: "开始间隔复习", exact: true });
      await expect(reviewLink).toHaveAttribute("href", `/reviews?card=${notebook.review.review_card_id}`);
      const reviewedSnapshot = await request.get(`/api/reviews/${notebook.review.review_card_id}`);
      expect(reviewedSnapshot.ok()).toBe(true);
      expect(await reviewedSnapshot.json()).toMatchObject({ answer: latest, reference, comment: "最终原答对应点评", review_count: 0 });
      const removing = gate();
      let deletes = 0;
      await page.route(`**/api/notebook/${notebook.id}`, async (route) => {
        if (route.request().method() !== "DELETE") { await route.continue(); return; }
        deletes++;
        if (deletes === 1) await route.fulfill({ status: 503, json: { error: "取消收藏暂时失败，原题与复习仍保留" } });
        else { await removing.promise; await route.continue(); }
      });
      try {
        const star = page.getByRole("button", { name: "取消收藏", exact: true });
        await star.click();
        await page.getByRole("dialog", { name: "移出错题本", exact: true }).getByRole("button", { name: "移出", exact: true }).click();
        const removeError = page.getByRole("alert").filter({ hasText: "取消收藏暂时失败" });
        await expect(removeError).toBeVisible();
        await expect(reviewLink).toBeVisible();
        const questionNumber = page.getByText("QUESTION 01 / 02", { exact: true });
        expect(await questionNumber.evaluate((element) => element.getBoundingClientRect().height <= Number.parseFloat(getComputedStyle(element).lineHeight) + 1)).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`notebook-remove-error-${width}.png`), fullPage: true });
        await star.click();
        await page.getByRole("dialog", { name: "移出错题本", exact: true }).getByRole("button", { name: "移出", exact: true }).click();
        await expect(star).toBeDisabled();
        await expect(removeError).toHaveCount(0);
        removing.release();
        await expect(page.getByRole("button", { name: "收藏到错题本", exact: true })).toBeEnabled();
        await expect(reviewLink).toHaveCount(0);
      } finally { removing.release(); }
      expect(deletes).toBe(2);
      expect((await request.get(`/api/reviews/${notebook.review.review_card_id}`)).status()).toBe(404);
      const afterRemove = await (await request.get(endpoint)).json();
      expect(afterRemove.questions[0]).toMatchObject({ answer: latest, reference, comment: "最终原答对应点评", notebook_id: null, review_card_id: null });
      expect(inputs).toHaveLength(callsBeforeRetry);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`drill-saved-answer-${width}.png`), fullPage: true });
      for (const [index, answer] of [original, revised, latest].entries()) {
        const messages = JSON.parse(inputs[index + 1]!).messages as { role: string; content: string }[];
        const user = messages.filter((message) => message.role === "user").map((message) => message.content).join("\n");
        expect(user).toContain(answer.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
        expect(user).not.toContain("第二题独立草稿");
        expect(user).not.toContain("第一次原答对应点评");
        expect(user).not.toContain("第二次原答对应点评");
        expect(user).not.toContain(reference);
      }
      expect(replies).toHaveLength(0);
      expect(unexpected).toEqual([]);
    } finally {
      first.release();
      second.release();
      provider.closeAllConnections();
      await new Promise<void>((resolve, reject) => provider.close((err) => err ? reject(err) : resolve()));
      const restored = await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes);
      expect(restored.ok()).toBe(true);
    }
  });
}
