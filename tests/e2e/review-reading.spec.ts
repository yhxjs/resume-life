import { expect, test } from "@playwright/test";
import { emptyReviewDashboardFixture, reviewDashboardFixture } from "../support/review-dashboard";

for (const width of [390, 1280]) {
  test(`复盘读取 ${width}px：坏成功回包页内恢复，不伪造零分或空记录`, async ({ page }, testInfo) => {
    const data = reviewDashboardFixture();
    data.sessions[0]!.label += "完整原题字段".repeat(40);
    let reads = 0;
    const writes: string[] = [], errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
      if (new URL(request.url()).pathname.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(request.method())) writes.push(request.method());
    });
    await page.route("**/api/review", async route => {
      reads++;
      const body = reads === 1 ? { ...data, overallScore: null }
        : reads === 2 ? { ...data, totals: { drills: 0, interviews: 0, scoredAnswers: 0 } }
          : reads === 3 ? { ...data, sessions: [{ ...data.sessions[0], avg: { depth: 7.4 } }, data.sessions[1]] }
            : reads === 5 ? emptyReviewDashboardFixture() : data;
      await route.fulfill({ json: body });
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/review");
    const alert = page.getByRole("alert").filter({ hasText: "复盘数据不完整或不一致" });
    for (let attempt = 1; attempt <= 3; attempt++) {
      await expect(alert).toBeVisible();
      await expect(page.getByText("本次统计综合均分", { exact: true })).toHaveCount(0);
      await expect(page.getByText(/还没有已评分的作答记录/)).toHaveCount(0);
      await expect(page.getByRole("status", { name: "加载中…", exact: true })).toHaveCount(0);
      expect(reads).toBe(attempt);
      if (attempt === 1) await page.screenshot({ path: testInfo.outputPath(`review-reading-error-${width}.png`) });
      await page.getByRole("button", { name: "重试加载", exact: true }).click();
      await expect.poll(() => reads).toBe(attempt + 1);
    }
    await expect(page.getByText("本次统计综合均分", { exact: true }).locator("..")).toContainText("6.4");
    await expect(alert).toHaveCount(0);
    await page.getByText("查看本页场次明细", { exact: true }).click();
    const details = page.getByRole("list", { name: "本页场次明细", exact: true });
    await expect(details.getByRole("listitem")).toHaveCount(2);
    await expect(details).toContainText(data.sessions[0]!.label);
    await expect(details).toContainText("旧时间字面量");
    await details.getByRole("listitem").first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`review-reading-recovered-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.reload();
    await expect(page.getByText(/还没有已评分的作答记录/)).toBeVisible();
    await expect(page.getByText("本次统计综合均分", { exact: true })).toHaveCount(0);
    await expect(alert).toHaveCount(0);
    expect(reads).toBe(5);
    expect(writes).toEqual([]);
    expect(errors).toEqual([]);
  });
}
