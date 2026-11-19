import { expect, test } from "@playwright/test";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import type { Application } from "../../src/lib/applications-types";

for (const width of [390, 1280]) {
  test(`面试轮次 ${width}px：保存与删除互斥，失败保留草稿，重开读取真实记录`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 900 });
    const baseline = await exportEncryptedBackup(request);
    expect(baseline.response.ok()).toBe(true);
    const releaseCreate = Promise.withResolvers<void>();
    const releaseDelete = Promise.withResolvers<void>();
    try {
      const created = await request.post("/api/applications", { data: { company: `轮次保护${width}`, role: "接口开发", stage: "applied" } });
      expect(created.status()).toBe(201);
      const applicationId = (await created.json()).id as number;
      const readApplication = async () => {
        const response = await request.get(`/api/applications/${applicationId}`);
        expect(response.ok()).toBe(true);
        return await response.json() as Application;
      };
      const path = `**/api/applications/${applicationId}/interviews`;
      const createStarted = Promise.withResolvers<void>();
      let creates = 0;
      await page.route(path, async (route) => {
        if (route.request().method() !== "POST") return route.continue();
        creates++;
        const response = await route.fetch();
        createStarted.resolve();
        await releaseCreate.promise;
        await route.fulfill({ response });
      });
      await page.goto(`/applications/${applicationId}/prepare`);
      await page.getByRole("button", { name: "记面试", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: /登记新面试轮次/ });
      await dialog.getByLabel("轮次名称", { exact: false }).fill("技术一面");
      await dialog.getByLabel("面试地点 / 平台", { exact: true }).fill("线上会议");
      await dialog.getByLabel("面试官", { exact: true }).fill("已确认的面试官");
      const notes = "仅确认接口维护范围 Array<T>、<template>、&amp;，未确认上线结果。";
      await dialog.getByLabel("轮次备忘 / 面试要点手记", { exact: true }).fill(notes);
      await dialog.getByRole("button", { name: "确认添加", exact: true }).click();
      await createStarted.promise;
      await expect(dialog.getByLabel("轮次名称", { exact: false })).toBeDisabled();
      await expect(dialog.getByRole("button", { name: "关闭弹窗" })).toBeDisabled();
      await page.keyboard.press("Escape");
      await page.mouse.click(2, 2);
      await expect(dialog).toBeVisible();
      expect(creates).toBe(1);
      releaseCreate.resolve();
      await expect(dialog).toHaveCount(0);
      const region = page.getByRole("region", { name: "真实面试记录", exact: true });
      await expect(region.getByRole("heading", { name: "技术一面", exact: true })).toBeVisible();
      const application = await readApplication();
      expect(application.stage).toBe("interview");
      expect(application.interviews).toHaveLength(1);
      expect(application.interviews![0]!.notes).toBe(notes);
      const roundId = application.interviews![0]!.id;
      const roundPath = `**/api/applications/${applicationId}/interviews/${roundId}`;
      let patchAttempts = 0;
      await page.route(roundPath, async (route) => {
        if (route.request().method() !== "PATCH") return route.continue();
        patchAttempts++;
        if (patchAttempts === 1) return route.fulfill({ status: 503, json: { error: "本次轮次保存失败，请保留草稿后重试" } });
        return route.continue();
      });
      await region.getByRole("button", { name: "编辑记录", exact: true }).click();
      const edit = page.getByRole("dialog", { name: /编辑面试轮次/ });
      const changed = `${notes}\n本地新增：尚未确认对方反馈。`;
      await edit.getByLabel("轮次备忘 / 面试要点手记", { exact: true }).fill(changed);
      await edit.getByRole("button", { name: "更新轮次", exact: true }).click();
      await expect(edit.getByRole("alert")).toContainText("本次轮次保存失败");
      await expect(edit.getByRole("alert")).toBeInViewport();
      await expect(edit.getByLabel("轮次备忘 / 面试要点手记", { exact: true })).toHaveValue(changed);
      expect((await readApplication()).interviews![0]!.notes).toBe(notes);
      await page.screenshot({ path: testInfo.outputPath(`round-save-failure-${width}.png`) });
      await edit.getByRole("button", { name: "更新轮次", exact: true }).click();
      await expect(edit).toHaveCount(0);
      expect(patchAttempts).toBe(2);
      expect((await readApplication()).interviews![0]!.notes).toBe(changed);
      await region.getByRole("button", { name: "编辑记录", exact: true }).click();
      await expect(edit.getByLabel("轮次备忘 / 面试要点手记", { exact: true })).toHaveValue(changed);
      await edit.getByRole("button", { name: "删除本轮面试", exact: true }).click();
      const confirmation = page.getByRole("dialog", { name: "确认删除该轮面试？", exact: true });
      await expect(confirmation).toContainText("技术一面");
      await confirmation.getByRole("button", { name: "取消", exact: true }).click();
      await expect(edit.getByRole("button", { name: "更新轮次", exact: true })).toBeEnabled();
      expect((await readApplication()).interviews).toHaveLength(1);
      const deleteStarted = Promise.withResolvers<void>();
      let deletes = 0;
      await page.unroute(roundPath);
      await page.route(roundPath, async (route) => {
        if (route.request().method() !== "DELETE") return route.continue();
        deletes++;
        const response = await route.fetch();
        deleteStarted.resolve();
        await releaseDelete.promise;
        await route.fulfill({ response });
      });
      await edit.getByRole("button", { name: "删除本轮面试", exact: true }).click();
      await confirmation.getByRole("button", { name: "确认删除", exact: true }).click();
      await deleteStarted.promise;
      await expect(edit.getByText("正在删除面试轮次…", { exact: true })).toBeVisible();
      await expect(edit.getByLabel("轮次名称", { exact: false })).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(edit).toBeVisible();
      expect(deletes).toBe(1);
      releaseDelete.resolve();
      await expect(edit).toHaveCount(0);
      await expect(region).toContainText("暂无记录");
      expect((await readApplication()).interviews).toHaveLength(0);
    } finally {
      releaseCreate.resolve();
      releaseDelete.resolve();
      await page.unrouteAll({ behavior: "wait" });
      expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
    }
  });
}
