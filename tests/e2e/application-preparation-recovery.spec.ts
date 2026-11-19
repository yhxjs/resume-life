import { expect, test } from "@playwright/test";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import type { ApplicationPreparation } from "../../src/lib/application-preparation-types";

for (const width of [390, 1280]) {
  test(`准备待办 ${width}px：真实写入成功后刷新失败，保留确认结果且只读重试`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 900 });
    const baseline = await exportEncryptedBackup(request);
    expect(baseline.response.ok()).toBe(true);
    try {
      const created = await request.post("/api/applications", { data: { company: `待办恢复${width}`, role: "接口开发" } });
      expect(created.status()).toBe(201);
      const applicationId = (await created.json()).id as number;
      const base = `/api/applications/${applicationId}/preparation`;
      const read = async () => {
        const response = await request.get(base);
        expect(response.ok()).toBe(true);
        return await response.json() as ApplicationPreparation;
      };
      let failReads = false;
      let failWrites = false;
      const methods: string[] = [];
      await page.route(`**${base}`, (route) => failReads
        ? route.fulfill({ status: 503, json: { error: "本次资料读取失败" } }) : route.continue());
      await page.route(`**${base}/tasks`, async (route) => {
        methods.push(route.request().method());
        return failWrites ? route.fulfill({ status: 400, json: { error: "本次待办写入失败" } }) : route.continue();
      });
      await page.goto(`/applications/${applicationId}/prepare`);
      const tasks = page.getByRole("region", { name: "准备待办", exact: true });
      const title = "核对维护范围 Array<T>、<template>、&amp;，未确认上线结果";
      await page.getByLabel("新待办", { exact: true }).fill(title);
      failReads = true;
      await tasks.getByRole("button", { name: "添加", exact: true }).click();
      await expect(page.getByRole("status")).toHaveText("添加待办成功");
      await expect(tasks.getByRole("checkbox", { name: title, exact: true })).toBeVisible();
      await expect(page.getByLabel("新待办", { exact: true })).toHaveValue("");
      const alert = page.getByRole("alert").filter({ has: page.getByRole("button", { name: "刷新资料", exact: true }) });
      await expect(alert).toContainText("资料刷新失败");
      await expect(alert).toBeInViewport();
      const saved = (await read()).tasks;
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({ title, done: false });
      expect(methods).toEqual(["POST"]);
      await page.screenshot({ path: testInfo.outputPath(`preparation-task-refresh-failure-${width}.png`) });
      failReads = false;
      await alert.getByRole("button", { name: "刷新资料", exact: true }).click();
      await expect(alert).toHaveCount(0);
      expect(methods).toEqual(["POST"]);
      await expect(tasks.getByRole("checkbox", { name: title, exact: true })).toHaveCount(1);
      failReads = true;
      await tasks.getByRole("checkbox", { name: title, exact: true }).check();
      await expect(page.getByRole("status")).toHaveText("更新待办成功");
      await expect(tasks.getByRole("checkbox", { name: title, exact: true })).toBeChecked();
      expect((await read()).tasks[0]!.done).toBe(true);
      await tasks.getByRole("button", { name: `删除待办：${title}`, exact: true }).click();
      await expect(page.getByRole("status")).toHaveText("删除待办成功");
      await expect(tasks.getByRole("checkbox", { name: title, exact: true })).toHaveCount(0);
      expect((await read()).tasks).toHaveLength(0);
      expect(methods).toEqual(["POST", "PATCH", "DELETE"]);
      failReads = false;
      await alert.getByRole("button", { name: "刷新资料", exact: true }).click();
      await expect(alert).toHaveCount(0);
      expect(methods).toEqual(["POST", "PATCH", "DELETE"]);
      failWrites = true;
      await page.getByLabel("新待办", { exact: true }).fill("失败后保留的编辑草稿");
      await tasks.getByRole("button", { name: "添加", exact: true }).click();
      await expect(alert).toContainText("本次待办写入失败");
      await expect(page.getByLabel("新待办", { exact: true })).toHaveValue("失败后保留的编辑草稿");
      expect((await read()).tasks).toHaveLength(0);
      failWrites = false;
      await tasks.getByRole("button", { name: "添加", exact: true }).click();
      await expect(tasks.getByRole("checkbox", { name: "失败后保留的编辑草稿", exact: true })).toBeVisible();
      await expect(page.getByLabel("新待办", { exact: true })).toHaveValue("");
      expect((await read()).tasks).toHaveLength(1);
    } finally {
      await page.unrouteAll({ behavior: "wait" });
      expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
    }
  });

  test(`准备分页 ${width}px：合成旧下一页晚到时不混入刷新后的资料`, async ({ page, request }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 900 });
    const baseline = await exportEncryptedBackup(request);
    expect(baseline.response.ok()).toBe(true);
    const releasePage = Promise.withResolvers<void>();
    try {
      const created = await request.post("/api/applications", { data: { company: `分页保护${width}`, role: "接口开发" } });
      expect(created.status()).toBe(201);
      const applicationId = (await created.json()).id as number;
      const round = await request.post(`/api/applications/${applicationId}/interviews`, { data: { round_name: "技术一面" } });
      expect(round.status()).toBe(201);
      const base = `/api/applications/${applicationId}/preparation`;
      const entries = [8, 7, 6, 5, 4].map((id) => ({ id, title: `合成首页错题${id}`, summary: "原答与参考分开保存", resume_id: null, href: null, created_at: "", linked: true }));
      let reads = 0;
      await page.route(`**${base}`, async (route) => {
        const response = await route.fetch();
        const actual = await response.json() as ApplicationPreparation;
        actual.resources.notebook = { items: entries, total: reads++ === 0 ? 6 : 5, nextCursor: reads === 1 ? "4" : null };
        await route.fulfill({ json: actual });
      });
      const pageStarted = Promise.withResolvers<void>();
      const pageFinished = Promise.withResolvers<void>();
      await page.route(`**${base}/resources?kind=notebook&limit=5&cursor=4`, async (route) => {
        pageStarted.resolve();
        await releasePage.promise;
        try { await route.fulfill({ json: { items: [{ ...entries[0]!, id: 1, title: "已取消关联的旧下一页" }], nextCursor: null, total: 6 } }); }
        finally { pageFinished.resolve(); }
      });
      await page.goto(`/applications/${applicationId}/prepare`);
      const resources = page.getByRole("region", { name: "错题", exact: true });
      await resources.getByRole("button", { name: "更多错题", exact: true }).click();
      await pageStarted.promise;
      await page.getByRole("region", { name: "真实面试记录", exact: true }).getByRole("button", { name: "逐题复盘", exact: true }).click();
      const review = page.getByRole("dialog", { name: "逐题复盘 · 技术一面", exact: true });
      await expect(review.getByText("还没有逐题记录", { exact: true })).toBeVisible();
      await review.getByRole("button", { name: "关闭", exact: true }).click();
      await expect(review).toHaveCount(0);
      await expect(resources.getByRole("button", { name: "更多错题", exact: true })).toHaveCount(0);
      releasePage.resolve();
      await pageFinished.promise;
      await expect(resources.locator("li")).toHaveCount(5);
      await expect(resources.getByText("已取消关联的旧下一页", { exact: true })).toHaveCount(0);
      await page.getByLabel("新待办", { exact: true }).fill("旧分页取消后可以正常保存");
      await page.getByRole("region", { name: "准备待办", exact: true }).getByRole("button", { name: "添加", exact: true }).click();
      await expect(page.getByRole("checkbox", { name: "旧分页取消后可以正常保存", exact: true })).toBeVisible();
      await expect(resources.locator("li")).toHaveCount(5);
      await expect(page.getByRole("status")).toHaveText("添加待办成功");
    } finally {
      releasePage.resolve();
      await page.unrouteAll({ behavior: "wait" });
      expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
    }
  });
}
