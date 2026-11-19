import { expect, test } from "@playwright/test";

for (const width of [390, 1280]) test(`逐题复盘响应 ${width}px：坏首读可重试，旧保存回包不覆盖本地编辑`, async ({ page, request }, testInfo) => {
  const created = await request.post("/api/applications", { data: { company: "复盘响应测试", role: "接口开发" } });
  expect(created.status()).toBe(201);
  const applicationId = (await created.json()).id as number;
  try {
    const round = await request.post(`/api/applications/${applicationId}/interviews`, { data: { round_name: "技术一面", status: "completed" } });
    expect(round.status()).toBe(201);
    const roundId = (await round.json()).id as number;
    const endpoint = `/api/applications/${applicationId}/interviews/${roundId}/review`;
    const initial = await (await request.get(endpoint)).json();
    const question = { question: "介绍你的验证范围", answer: "仅做了接口联调", stuck: "没有记录验收范围", feedback: "" };
    const saved = await request.put(endpoint, { data: { expected_hash: initial.input_hash, questions: [question] } });
    expect(saved.status()).toBe(200);
    const stored = await saved.json();
    let reads = 0;
    const writes: unknown[] = [];
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.route(`**${endpoint}`, async route => {
      const message = route.request();
      if (message.method() === "GET" && ++reads === 1) {
        await route.fulfill({ json: { ...stored, questions: {} } });
        return;
      }
      if (message.method() === "PUT") {
        writes.push(message.postDataJSON());
        if (writes.length === 1) {
          await route.fulfill({ json: stored });
          return;
        }
      }
      await route.continue();
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/applications/${applicationId}/prepare`);
    await page.getByRole("region", { name: "真实面试记录" }).getByRole("button", { name: "逐题复盘", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "逐题复盘 · 技术一面", exact: true });
    await expect(dialog.getByRole("alert")).toContainText("响应不完整");
    await dialog.getByRole("button", { name: "重试加载", exact: true }).click();
    const answer = dialog.getByRole("textbox", { name: "怎么回答", exact: true });
    await expect(answer).toHaveValue(question.answer);
    const localAnswer = "  本地补充 <T> &amp;\n仅负责联调，尚未上线  ";
    await answer.fill(localAnswer);
    await dialog.getByRole("button", { name: "保存逐题记录", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("保存结果");
    await expect(answer).toHaveValue(localAnswer);
    await expect(dialog.getByText("逐题记录已保存", { exact: true })).toHaveCount(0);
    expect((await (await request.get(endpoint)).json()).questions).toEqual([question]);
    await dialog.getByRole("button", { name: "保存逐题记录", exact: true }).click();
    await expect(dialog.getByText("逐题记录已保存", { exact: true })).toBeVisible();
    await expect(answer).toHaveValue(localAnswer.trim());
    await expect(dialog.getByRole("alert")).toHaveCount(0);
    expect(writes).toHaveLength(2);
    expect(writes[0]).toEqual(writes[1]);
    const reloaded = await (await request.get(endpoint)).json();
    expect(reloaded.questions).toEqual([{ ...question, answer: localAnswer.trim() }]);
    expect(reloaded.history).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await dialog.screenshot({ path: testInfo.outputPath(`review-response-${width}.png`) });
  } finally {
    expect((await request.delete(`/api/applications/${applicationId}`)).ok()).toBe(true);
  }
});
