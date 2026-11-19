import { expect, test } from "@playwright/test";

for (const width of [390, 1280]) {
  for (const failure of ["missing", "inconsistent"] as const) {
    test(`投递统计校验 ${width}px ${failure}：坏成功回包可重读恢复，零业务写入`, async ({ page }, testInfo) => {
      let reads = 0;
      const errors: string[] = [], writes: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("request", req => { if (new URL(req.url()).pathname.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(req.method())) writes.push(req.method()); });
      await page.route("**/api/applications/stats", async route => {
        reads++;
        const response = await route.fetch();
        const data = await response.json();
        if (reads === 1) {
          if (failure === "missing") delete data.funnel.hiringSteps;
          else data.totalActive += 99;
        } else if (reads === 2) {
          data.funnel.winRate = 101;
        }
        await route.fulfill({ response, json: data });
      });
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/applications?view=funnel");
      const alert = page.getByRole("tabpanel").getByRole("alert");
      await expect(alert).toContainText("投递统计不完整或不一致");
      await expect(page.getByRole("region", { name: "投递统计概览" })).toHaveCount(0);
      await expect(page.getByRole("tab", { name: /看板模式/ })).not.toContainText("0");
      await page.screenshot({ path: testInfo.outputPath(`invalid-${failure}-${width}.png`) });
      await page.getByRole("button", { name: "重试统计", exact: true }).click();
      await expect.poll(() => reads).toBe(2);
      await expect(alert).toContainText("投递统计不完整或不一致");
      await page.getByRole("button", { name: "重试统计", exact: true }).click();
      await expect(page.getByRole("region", { name: "投递统计概览" })).toBeVisible();
      await expect(alert).toHaveCount(0);
      await expect(page.getByRole("tab", { name: /看板模式/ })).toContainText("0");
      await page.screenshot({ path: testInfo.outputPath(`recovered-${failure}-${width}.png`) });
      expect(reads).toBe(3); expect(writes).toEqual([]); expect(errors).toEqual([]);
    });
  }
}
