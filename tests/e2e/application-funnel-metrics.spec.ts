import { expect, test } from "@playwright/test";

for (const width of [390, 1280]) {
  test(`投递指标 ${width}px：同公司多记录、Offer 分母和批次切换`, async ({ page, request }, testInfo) => {
    const ids: number[] = [], writes: string[] = [], errors: string[] = [];
    const batch = `指标口径 ${width}`, activeBatch = `未结束指标 ${width}`;
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", req => {
      if (new URL(req.url()).pathname.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(req.method())) writes.push(req.method());
    });
    try {
      for (const [index, stage] of ["interested", "offer", "rejected", "applied"].entries()) {
        const response = await request.post("/api/applications", { data: {
          company: "同一指标测试公司", role: `岗位 ${index + 1}`, stage,
          batch_name: index === 3 ? activeBatch : batch,
          ...(stage === "rejected" ? { terminal_stage: "resume_screening", terminal_reason: "岗位关闭" } : {}),
        } });
        expect(response.status()).toBe(201);
        ids.push((await response.json()).id);
      }
      const stats = await (await request.get("/api/applications/stats")).json();
      expect(stats.batchStats.find((item: { batchName: string }) => item.batchName === batch)).toMatchObject({
        totalApplications: 3, totalOffers: 1, totalCompleted: 2, winRate: 50, overallYieldRate: 33,
      });
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/applications?view=funnel");
      const summary = page.getByRole("region", { name: "投递统计概览", exact: true });
      const card = (label: string) => summary.getByText(label, { exact: true }).locator("..");
      const ended = card("已结束记录 Offer 占比"), all = card("全部记录 Offer 占比");
      await page.getByLabel("投递批次", { exact: true }).selectOption(JSON.stringify(batch));
      await expect(card("总跟进意向/投递")).toContainText("3");
      await expect(card("总跟进意向/投递")).toContainText("条记录");
      await expect(ended).toContainText("50%");
      await expect(ended).toContainText("1 / 2");
      await expect(all).toContainText("33%");
      await expect(all).toContainText("1 / 3");
      await expect(all).toContainText("含意向");
      await summary.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`funnel-metrics-${width}.png`) });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.getByLabel("投递批次", { exact: true }).selectOption(JSON.stringify(activeBatch));
      await expect(card("总跟进意向/投递")).toContainText("1");
      await expect(ended).toContainText("—");
      await expect(ended).not.toContainText("0%");
      await expect(all).toContainText("0%");
      await expect(all).toContainText("0 / 1");
      await page.getByLabel("投递批次", { exact: true }).selectOption("all");
      await expect(card("总跟进意向/投递")).toContainText(String(stats.funnel.totalApplications));
      await expect(all).toContainText(`${stats.funnel.totalOffers} / ${stats.funnel.totalApplications}`);
      await page.goto("/applications");
      await expect(page.getByText(/进行中投递/)).toContainText(`${stats.totalActive} 条记录`);
      expect(writes).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await Promise.allSettled(ids.map(id => request.delete(`/api/applications/${id}`)));
    }
  });
}
