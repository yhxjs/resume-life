import { expect, test } from "@playwright/test";
import { emptySummary } from "../../src/lib/summary";
import { compareProjectSummaries } from "../../src/lib/project-summary-diff";

for (const width of [390, 1280]) {
  test(`材料续页读到更正版本后旧编辑保存被拒绝，刷新可基于新档案继续 (${width}px)`, async ({ page, request }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width, height: 900 });
    const created = await request.post("/api/projects", { data: { name: `编辑版本项目 ${width}` } });
    expect(created.status()).toBe(201);
    const id = (await created.json()).id;
    const root = `/api/projects/${id}`;
    try {
      const original = { ...emptySummary(), responsibilities: "参与联调，尚未上线" };
      const revised = { ...original, responsibilities: "更正：仅做参数校验，联调由同事完成" };
      const first = await request.patch(root, { data: { summary: original, expectedRevisionId: 0 } });
      expect(first.status()).toBe(200);
      const originalRevision = (await first.json()).revisionId;
      for (let index = 1; index <= 51; index++) {
        expect((await request.post(`${root}/materials`, { data: { title: `版本材料${index}`, content: `测试原文${index}` } })).status()).toBe(201);
      }
      await page.goto(`/knowledge/${id}`);
      await expect(page.getByRole("textbox", { name: "主要职责", exact: true })).toHaveValue(original.responsibilities);
      await page.getByRole("textbox", { name: "项目简要概述（针对简历的一两句精炼介绍）", exact: true }).fill("本地尚未保存的介绍");
      const correction = await request.patch(root, { data: { summary: revised, expectedRevisionId: originalRevision } });
      expect(correction.status()).toBe(200);
      const revisedRevision = (await correction.json()).revisionId;
      await page.getByRole("button", { name: "加载更多材料", exact: true }).click();
      await expect(page.getByText("版本材料1", { exact: true })).toBeAttached();
      await expect(page.getByRole("textbox", { name: "主要职责", exact: true })).toHaveValue(original.responsibilities);
      const response = page.waitForResponse(result => result.url().endsWith(root) && result.request().method() === "PATCH");
      await page.getByRole("button", { name: "保存总结修改", exact: true }).click();
      const saved = await response;
      const body = await (await request.get(root)).json();
      expect({ status: saved.status(), summary: body.summary, history: (await (await request.get(`${root}/summary-history`)).json()).items.length })
        .toEqual({ status: 409, summary: revised, history: 2 });
      expect(saved.request().postDataJSON().expectedRevisionId).toBe(originalRevision);
      await expect(page.getByText("保存失败：项目总结已更新，请刷新后重新核对草稿", { exact: true })).toBeVisible();
      await expect(page.getByRole("textbox", { name: "项目简要概述（针对简历的一两句精炼介绍）", exact: true })).toHaveValue("本地尚未保存的介绍");
      // 新生成提案的版本也不能取代当前编辑正文的旧基准。
      const generated = { ...revised, brief: "新版本生成的介绍" };
      await page.route(`**${root}/summarize`, route => route.fulfill({
        headers: { "Content-Type": "text/event-stream" }, body: `event: done\ndata: ${JSON.stringify({
          summary: generated, comparison: compareProjectSummaries(revised, generated, {}), materialChanges: [],
          materialFingerprint: "a".repeat(64), revisionId: revisedRevision,
        })}\n\n`,
      }));
      let unexpectedWrites = 0;
      page.on("request", next => { if (next.url().endsWith(root) && next.method() === "PATCH") unexpectedWrites++; });
      await page.getByRole("button", { name: /重新生成 STAR 总结/ }).click();
      await page.getByRole("group", { name: "项目简要概述", exact: true }).getByRole("button", { name: "采纳本段", exact: true }).click();
      await page.getByRole("button", { name: "确认采用入库", exact: true }).click();
      await expect(page.getByText("保存失败：AI 草稿与本地编辑的档案版本不一致，请刷新页面核对后重新生成", { exact: true })).toBeVisible();
      expect(unexpectedWrites).toBe(0);
      expect((await (await request.get(root)).json()).summary).toEqual(revised);
      await page.reload();
      await expect(page.getByRole("textbox", { name: "主要职责", exact: true })).toHaveValue(revised.responsibilities);
      await page.getByRole("textbox", { name: "项目简要概述（针对简历的一两句精炼介绍）", exact: true }).fill("基于新档案重新编辑");
      const retry = page.waitForResponse(result => result.url().endsWith(root) && result.request().method() === "PATCH");
      await page.getByRole("button", { name: "保存总结修改", exact: true }).click();
      const retried = await retry;
      expect(retried.status()).toBe(200);
      expect(retried.request().postDataJSON().expectedRevisionId).toBe(revisedRevision);
      await expect(page.getByText("总结已保存", { exact: true })).toBeVisible();
      expect((await (await request.get(root)).json()).summary).toEqual({ ...revised, brief: "基于新档案重新编辑" });
    } finally {
      await page.goto("/knowledge");
      expect((await request.delete(root)).status()).toBe(200);
    }
  });
}
