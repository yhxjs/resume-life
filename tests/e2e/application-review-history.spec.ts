import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";

for (const width of [390, 1280]) {
  test(`真实面试复盘 ${width}px：回看和导出保留原保存基线，其他页面的新记录不会被覆盖`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000);
    const baseline = await exportEncryptedBackup(request);
    expect(baseline.response.ok()).toBe(true);
    const replies = [1, 2].map((id) => ({
      mistakes: [{ question_index: 1, gap: `版本${id}：已记录的兼容性验证仍待说明`, improved_answer: "仅根据能确认的实际分工说明验证范围，缺失记录待核实。" }],
      drills: [{ question_index: 1, question: "假设需要移除旧字段，你会如何核对调用方兼容性？" }],
      resume_suggestions: [],
    }));
    let calls = 0;
    const provider = createServer(async (incoming, outgoing) => {
      for await (const chunk of incoming) void chunk;
      calls += 1;
      const reply = replies.shift();
      if (!reply) {
        outgoing.writeHead(500);
        outgoing.end("Unexpected synthetic review request");
        return;
      }
      outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
      outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(reply) } }] })}\n\ndata: [DONE]\n\n`);
    });
    await listenForFetch(provider);
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("Missing synthetic provider address");
    try {
      expect((await request.put("/api/settings", { data: {
        base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-application-review-history", api_format: "openai_chat",
        model_question: "synthetic", model_evaluate: "synthetic",
      } })).ok()).toBe(true);
      const created = await request.post("/api/applications", { data: { company: "合成复盘公司", role: "接口开发", jd: "接口兼容性维护" } });
      expect(created.status()).toBe(201);
      const applicationId = (await created.json()).id as number;
      const roundResponse = await request.post(`/api/applications/${applicationId}/interviews`, { data: { round_name: "技术一面", status: "completed" } });
      expect(roundResponse.status()).toBe(201);
      const roundId = (await roundResponse.json()).id as number;
      const endpoint = `/api/applications/${applicationId}/interviews/${roundId}/review`;
      const question = { question: "介绍你的接口兼容性维护范围", answer: "我参与参数校验，尚未上线。", stuck: "对调用方验证范围记不清", feedback: "未记录对方反馈" };
      const initial = await (await request.get(endpoint)).json();
      const firstDraft = await request.put(endpoint, { data: { expected_hash: initial.input_hash, questions: [question] } });
      expect(firstDraft.status()).toBe(200);
      const first = await request.post(endpoint, { data: { expected_hash: (await firstDraft.json()).input_hash } });
      expect(first.status()).toBe(200);
      const firstRecap = (await first.json()).latest;
      const secondDraft = await request.put(endpoint, { data: { expected_hash: firstRecap.input_hash, questions: [{ ...question, answer: "我还参与了联调，没有选型权。" }] } });
      expect(secondDraft.status()).toBe(200);
      const currentHash = (await secondDraft.json()).input_hash as string;
      expect((await request.post(endpoint, { data: { expected_hash: currentHash } })).status()).toBe(200);

      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/applications/${applicationId}/prepare`);
      await page.getByRole("region", { name: "真实面试记录" }).getByRole("button", { name: "逐题复盘" }).click();
      const dialog = page.getByRole("dialog", { name: "逐题复盘 · 技术一面" });
      await expect(dialog.getByText("版本2：已记录的兼容性验证仍待说明", { exact: true })).toBeVisible();
      const localDraft = "本地未保存的补充 <T> &amp;，没有确认上线结果。";
      await dialog.getByRole("textbox", { name: "怎么回答" }).fill(localDraft);

      const externalAnswer = "另一页面已经保存的记录：仅负责联调，验收由负责人确认。";
      const external = await request.put(endpoint, { data: { expected_hash: currentHash, questions: [{ ...question, answer: externalAnswer }] } });
      expect(external.status()).toBe(200);
      const externalHash = (await external.json()).input_hash;
      expect(externalHash).not.toBe(currentHash);
      await dialog.getByRole("combobox", { name: "复盘版本" }).selectOption(String(firstRecap.id));
      await expect(dialog.getByText("版本1：已记录的兼容性验证仍待说明", { exact: true })).toBeVisible();
      await expect(dialog.getByRole("textbox", { name: "怎么回答" })).toHaveValue(localDraft);
      await dialog.getByRole("button", { name: "加入错题本", exact: true }).click();
      await page.getByRole("dialog", { name: "加入错题本？", exact: true }).getByRole("button", { name: "确认加入", exact: true }).click();
      await expect(dialog.getByRole("button", { name: "已加入错题本", exact: true })).toBeVisible();
      await expect(dialog.getByRole("combobox", { name: "复盘版本" })).toHaveValue(String(firstRecap.id));

      const submitted = page.waitForRequest((message) => message.url().endsWith(endpoint) && message.method() === "PUT");
      await dialog.getByRole("button", { name: "保存逐题记录", exact: true }).click();
      expect((await submitted).postDataJSON()).toMatchObject({ expected_hash: currentHash, questions: [{ ...question, answer: localDraft }] });
      await expect(dialog.getByRole("alert")).toContainText("资料已变化");
      await expect(dialog.getByRole("alert")).toBeInViewport();
      await expect(dialog.getByRole("textbox", { name: "怎么回答" })).toHaveValue(localDraft);
      const stored = await (await request.get(`${endpoint}?recap_id=${firstRecap.id}`)).json();
      expect(stored.questions).toEqual([{ ...question, answer: externalAnswer }]);
      expect(stored.input_hash).toBe(externalHash);
      expect(stored.history).toHaveLength(2);
      expect(stored.selected.questions).toEqual([question]);
      expect(stored.selected.exports.mistakes).toBe(true);
      for (const alias of [`${firstRecap.id}e0`, `0x${firstRecap.id.toString(16)}`, `+${firstRecap.id}`, `0${firstRecap.id}`, ` ${firstRecap.id}`]) {
        const response = await request.get(`${endpoint}?recap_id=${encodeURIComponent(alias)}`);
        expect(response.status(), alias).toBe(400);
        expect(await response.json()).toEqual({ error: "无效的复盘记录 ID" });
      }
      expect(await (await request.get(`${endpoint}?recap_id=${firstRecap.id}`)).json()).toEqual(stored);
      expect(calls).toBe(2);
      expect(replies).toHaveLength(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await dialog.screenshot({ path: testInfo.outputPath(`real-review-history-${width}.png`) });
      await dialog.getByRole("button", { name: "关闭", exact: true }).click();
      await page.getByRole("dialog", { name: "放弃未保存的逐题记录？", exact: true }).getByRole("button", { name: "放弃编辑", exact: true }).click();
      await page.getByRole("region", { name: "真实面试记录" }).getByRole("button", { name: "逐题复盘" }).click();
      await expect(dialog.getByRole("textbox", { name: "怎么回答" })).toHaveValue(externalAnswer);
    } finally {
      provider.closeAllConnections();
      await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
      expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
    }
  });
}
