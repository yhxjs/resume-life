import { expect, test } from "@playwright/test";
import { gate } from "./synthetic-api";

for (const width of [390, 1280]) {
  test(`投递统计 ${width}px：等待和失败不显示假零，只读重试恢复真实零`, async ({ page }, testInfo) => {
    const held = gate(); let reads = 0;
    const writes: string[] = [];
    page.on("request", req => { if (new URL(req.url()).pathname.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(req.method())) writes.push(req.method()); });
    await page.route("**/api/applications/stats", async route => {
      reads++;
      if (reads === 1) { await held.promise; await route.fulfill({ status: 503, json: { error: "合成统计不可用" } }); }
      else await route.fulfill({ response: await route.fetch() });
    });
    try {
      await page.setViewportSize({ width, height: 900 }); await page.goto("/applications?view=funnel");
      await expect.poll(() => reads).toBe(1);
      const kanban = page.getByRole("tab", { name: /看板模式/ });
      await page.screenshot({ path: testInfo.outputPath(`stats-pending-${width}.png`) });
      await expect(kanban).not.toContainText("0");
      await expect(page.getByRole("status", { name: "正在加载投递统计…", exact: true })).toBeVisible();
      held.release();
      await expect(page.getByRole("alert").filter({ hasText: "合成统计不可用" })).toBeVisible();
      await expect(kanban).not.toContainText("0");
      await page.screenshot({ path: testInfo.outputPath(`stats-error-${width}.png`) });
      await page.getByRole("button", { name: "重试统计", exact: true }).click();
      await expect(page.getByRole("region", { name: "投递统计概览" })).toBeVisible();
      await expect(kanban).toContainText("0");
      await expect(page.getByRole("tabpanel").getByRole("alert")).toHaveCount(0);
      expect(reads).toBe(2); expect(writes).toEqual([]);
    } finally { held.release(); await page.unrouteAll({ behavior: "wait" }); }
  });

  test(`投递统计 ${width}px：列表失败不阻挡独立的漏斗，返回看板可重读列表`, async ({ page }) => {
    let lists = 0, stats = 0;
    page.on("request", req => { if (new URL(req.url()).pathname === "/api/applications/stats") stats++; });
    await page.route(/\/api\/applications(?:\?.*)?$/, async route => {
      lists++;
      if (lists === 1) await route.fulfill({ status: 503, json: { error: "合成列表不可用" } });
      else await route.fulfill({ response: await route.fetch() });
    });
    await page.setViewportSize({ width, height: 900 }); await page.goto("/applications?view=funnel");
    await expect.poll(() => lists).toBe(1);
    await expect(page.getByRole("region", { name: "投递统计概览" })).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: "合成列表不可用" })).toHaveCount(0);
    await page.getByRole("tab", { name: /看板模式/ }).click();
    await expect(page.getByRole("alert").filter({ hasText: "合成列表不可用" })).toBeVisible();
    await page.getByRole("button", { name: "重试加载", exact: true }).click();
    await expect(page.getByRole("tabpanel").getByRole("alert")).toHaveCount(0);
    await expect.poll(() => lists).toBe(2);
    await expect(page.getByRole("status", { name: "正在加载求职数据...", exact: true })).toHaveCount(0);
    expect(stats).toBe(1);
  });

  test(`投递统计 ${width}px：真实创建后统计失败标记旧值，重读不重复创建`, async ({ page, request }, testInfo) => {
    let createdId = 0, reads = 0, posts = 0;
    const before = await (await request.get("/api/applications/stats")).json();
    await page.route("**/api/applications/stats", async route => {
      reads++;
      if (reads === 2) await route.fulfill({ status: 503, json: { error: "合成更新不可用" } });
      else await route.fulfill({ response: await route.fetch() });
    });
    page.on("request", req => { if (req.method() === "POST" && new URL(req.url()).pathname === "/api/applications") posts++; });
    try {
      await page.setViewportSize({ width, height: 900 }); await page.goto("/applications?view=funnel");
      const summary = page.getByRole("region", { name: "投递统计概览" });
      await expect(summary).toBeVisible();
      await page.getByRole("button", { name: /登记新投递/ }).click();
      const dialog = page.getByRole("dialog", { name: "新建求职投递", exact: true });
      await dialog.getByLabel("公司名称 *", { exact: true }).fill("统计恢复测试公司");
      await dialog.getByLabel("目标岗位 *", { exact: true }).fill("接口开发");
      const saved = page.waitForResponse(res => res.request().method() === "POST" && new URL(res.url()).pathname === "/api/applications");
      await dialog.getByRole("button", { name: "立即创建", exact: true }).click();
      createdId = (await (await saved).json()).id;
      await expect(dialog).toHaveCount(0);
      const alert = page.getByRole("alert").filter({ hasText: "合成更新不可用" });
      await expect(alert).toContainText("上次读取的统计");
      await expect(summary.getByText("总跟进意向/投递", { exact: true }).locator("..")).toContainText(String(before.funnel.totalApplications));
      await page.screenshot({ path: testInfo.outputPath(`stats-stale-${width}.png`) });
      await page.getByRole("button", { name: "重试统计", exact: true }).click();
      await expect(alert).toHaveCount(0);
      await expect(summary.getByText("总跟进意向/投递", { exact: true }).locator("..")).toContainText(String(before.funnel.totalApplications + 1));
      expect(reads).toBe(3); expect(posts).toBe(1);
    } finally { if (createdId) await request.delete(`/api/applications/${createdId}`); }
  });
}
