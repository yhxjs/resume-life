import { expect, test } from "@playwright/test";
import { emptySummary } from "../../src/lib/summary";
import { compareProjectSummaries } from "../../src/lib/project-summary-diff";
import { gate } from "./synthetic-api";

for (const width of [390, 1280]) {
  test(`总结确认后晚到的材料续页不回退档案，放弃新草稿仍可继续保存 ${width}px`, async ({ page, request }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width, height: 900 });
    const created = await request.post("/api/projects", { data: { name: `总结乱序 ${width}` } });
    expect(created.status()).toBe(201);
    const id = (await created.json()).id as number;
    const root = `/api/projects/${id}`;
    const readStarted = gate();
    const release = gate();
    const saved = { ...emptySummary(), overview: "已确认保存的定位 <T> &amp;", brief: "已核实的项目介绍" };
    let writes = 0;
    let confirmedRevision = 0;
    const submittedVersions: number[] = [];
    try {
      for (let index = 1; index <= 51; index++) {
        expect((await request.post(`${root}/materials`, { data: { title: `乱序材料${index}`, content: `用于测试的原文${index}` } })).status()).toBe(201);
      }
      await page.route(`**${root}?cursor=*`, async route => {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        expect((await response.json()).summary_revision_id).toBe(0);
        readStarted.release();
        await release.promise;
        await route.fulfill({ response });
      });
      await page.route(`**${root}`, async route => {
        if (route.request().method() !== "PATCH") return route.continue();
        writes++;
        submittedVersions.push(route.request().postDataJSON().expectedRevisionId);
        const response = await route.fetch();
        expect(response.status(), await response.text()).toBe(200);
        if (writes > 1) return route.fulfill({ response });
        confirmedRevision = (await response.json()).revisionId;
        return route.fulfill({ json: {} });
      });
      await page.goto(`/knowledge/${id}`);
      const overview = page.locator("#project-summary-overview");
      const brief = page.locator("#resume-brief");
      await expect(overview).toHaveValue("");
      await page.getByRole("button", { name: "加载更多材料", exact: true }).click();
      await readStarted.promise;
      await overview.fill(saved.overview);
      await brief.fill(saved.brief);
      await page.getByRole("button", { name: "保存总结修改", exact: true }).click();
      await expect(page.getByText("已核对项目档案包含本次提交的总结内容", { exact: true })).toBeVisible();
      expect(writes).toBe(1);
      release.release();
      await expect(page.getByText("乱序材料1", { exact: true })).toBeAttached();
      // 新草稿只为验证“放弃”取回哪个已保存基底，未执行模型调用。
      const generated = { ...saved, overview: "尚未采用的新草稿" };
      await page.route(`**${root}/summarize`, route => route.fulfill({ contentType: "text/event-stream", body: `event: done\ndata: ${JSON.stringify({
        summary: generated, comparison: compareProjectSummaries(saved, generated, {}), materialChanges: [], materialFingerprint: "a".repeat(64), revisionId: confirmedRevision,
      })}\n\n` }));
      await page.getByRole("button", { name: /(?:重新生成 STAR|生成 AI STAR) 总结/ }).click();
      await expect(page.getByRole("region", { name: "本次总结差异" })).toBeVisible();
      await page.getByRole("button", { name: "放弃本次草稿", exact: true }).click();
      await expect(overview).toHaveValue(saved.overview);
      await expect(brief).toHaveValue(saved.brief);
      expect((await (await request.get(root)).json()).summary).toEqual(saved);
      const next = { ...saved, brief: "在确认档案上继续编辑" };
      await brief.fill(next.brief);
      await page.getByRole("button", { name: "保存总结修改", exact: true }).click();
      await expect(page.getByText("总结已保存", { exact: true })).toBeVisible();
      expect(submittedVersions).toEqual([0, confirmedRevision]);
      expect((await (await request.get(root)).json()).summary).toEqual(next);
      expect((await (await request.get(`${root}/summary-history`)).json()).items).toHaveLength(2);
      await page.reload();
      await expect(overview).toHaveValue(saved.overview);
      await expect(brief).toHaveValue(next.brief);
    } finally {
      release.release();
      await page.goto("/knowledge");
      expect((await request.delete(root)).status()).toBe(200);
    }
  });
}
