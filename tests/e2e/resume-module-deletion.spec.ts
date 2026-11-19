import { expect, test } from "@playwright/test";
import { gate } from "./synthetic-api";

test.use({ actionTimeout: 10_000 });

for (const width of [390, 1280]) {
  test(`模块删除 ${width}px：确认离页不写入，重开取消零写入，连续点击只确认并删除一次`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 });
    const created = await request.post("/api/resumes", { data: { title: `模块确认 ${width}` } }); expect(created.status()).toBe(201);
    const id = (await created.json()).id; const endpoint = `/api/resumes/${id}`; let deletes = 0;
    const before = await (await request.get(endpoint)).json();
    await page.route(`**${endpoint}`, async route => {
      if (route.request().method() === "PATCH" && route.request().postDataJSON().removeModule) deletes++;
      return route.continue();
    });
    try {
      await page.goto(`/resumes/${id}`); const tab = page.getByRole("tab", { name: "自我评价", exact: true }); await tab.click();
      await page.locator('a[href="/"]').first().click(); await expect(page).toHaveURL(/\/$/);
      await page.goBack(); await tab.click();
      const remove = page.getByRole("button", { name: "删除模块「自我评价」", exact: true }); await remove.click();
      const dialog = page.getByRole("dialog", { name: "删除模块", exact: true }); await expect(dialog).toContainText("自我评价");
      await page.goForward(); await expect(page).toHaveURL(/\/$/);
      await expect(dialog).toHaveCount(0); expect(deletes).toBe(0);
      expect(await (await request.get(endpoint)).json()).toEqual(before);
      await page.goBack(); await tab.click(); await remove.click();
      await dialog.getByRole("button", { name: "取消", exact: true }).click(); await expect(dialog).toHaveCount(0);
      expect(deletes).toBe(0); expect(await (await request.get(endpoint)).json()).toEqual(before);
      await remove.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
      await dialog.getByRole("button", { name: "删除", exact: true }).click();
      await expect(tab).toHaveCount(0); await expect(dialog).toHaveCount(0); expect(deletes).toBe(1);
      const after = await (await request.get(endpoint)).json();
      expect(after.modules).toEqual(before.modules.filter((module: { key: string }) => module.key !== "summary"));
      await page.reload(); await expect(page.getByRole("tab", { name: "基本信息", exact: true })).toBeVisible(); await expect(tab).toHaveCount(0);
    } finally {
      await page.goto("/resumes"); expect((await request.delete(endpoint)).status()).toBe(200);
    }
  });

  test(`模块删除 ${width}px：真实写入回复等待时保留新选择及新编辑，共享队列继续保存`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 });
    const created = await request.post("/api/resumes", { data: { title: `模块等待 ${width}` } }); expect(created.status()).toBe(201);
    const id = (await created.json()).id; const endpoint = `/api/resumes/${id}`; const written = gate(); const responseGate = gate(); let deletes = 0;
    await page.route(`**${endpoint}`, async route => {
      if (route.request().method() !== "PATCH" || !route.request().postDataJSON().removeModule) return route.continue();
      deletes++; const response = await route.fetch(); expect(response.status()).toBe(200);
      written.release(); await responseGate.promise; return route.fulfill({ response });
    });
    try {
      await page.goto(`/resumes/${id}`); await page.getByLabel("姓名", { exact: true }).fill("删除前的原稿");
      const summary = page.getByRole("tab", { name: "自我评价", exact: true }); await summary.click();
      await page.getByRole("button", { name: "删除模块「自我评价」", exact: true }).click();
      await page.getByRole("dialog", { name: "删除模块", exact: true }).getByRole("button", { name: "删除", exact: true }).click();
      await written.promise;
      const basic = page.getByRole("tab", { name: "基本信息", exact: true }); await basic.click();
      const name = page.getByLabel("姓名", { exact: true }); await expect(name).toHaveValue("删除前的原稿"); await name.fill("等待期间继续编辑");
      responseGate.release(); await expect(summary).toHaveCount(0); await expect(basic).toHaveAttribute("aria-selected", "true");
      await expect(name).toHaveValue("等待期间继续编辑"); expect(deletes).toBe(1);
      await expect.poll(async () => (await (await request.get(endpoint)).json()).modules.find((module: { key: string }) => module.key === "basic").content.name).toBe("等待期间继续编辑");
      await page.reload(); await expect(name).toHaveValue("等待期间继续编辑"); await expect(summary).toHaveCount(0);
    } finally {
      responseGate.release(); await page.goto("/resumes"); expect((await request.delete(endpoint)).status()).toBe(200);
    }
  });

  test(`模块删除 ${width}px：失败提示离页关闭，原模块保留，重开取消不重发`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 });
    const created = await request.post("/api/resumes", { data: { title: `模块失败 ${width}` } }); expect(created.status()).toBe(201);
    const id = (await created.json()).id; const endpoint = `/api/resumes/${id}`; let deletes = 0;
    const before = await (await request.get(endpoint)).json();
    await page.route(`**${endpoint}`, async route => {
      if (route.request().method() !== "PATCH" || !route.request().postDataJSON().removeModule) return route.continue();
      deletes++; return route.fulfill({ status: 400, json: { error: "合成模块删除被拒绝" } });
    });
    try {
      await page.goto(`/resumes/${id}`); const tab = page.getByRole("tab", { name: "自我评价", exact: true }); await tab.click();
      await page.locator('a[href="/"]').first().click(); await expect(page).toHaveURL(/\/$/); await page.goBack(); await tab.click();
      const remove = page.getByRole("button", { name: "删除模块「自我评价」", exact: true }); await remove.click();
      await page.getByRole("dialog", { name: "删除模块", exact: true }).getByRole("button", { name: "删除", exact: true }).click();
      const failure = page.getByRole("dialog", { name: "删除模块失败", exact: true }); await expect(failure).toContainText("合成模块删除被拒绝");
      await page.goForward(); await expect(page).toHaveURL(/\/$/); await expect(failure).toHaveCount(0);
      expect(deletes).toBe(1); expect(await (await request.get(endpoint)).json()).toEqual(before);
      await page.goBack(); await tab.click(); await remove.click();
      await page.getByRole("dialog", { name: "删除模块", exact: true }).getByRole("button", { name: "取消", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0); expect(deletes).toBe(1);
      expect(await (await request.get(endpoint)).json()).toEqual(before);
    } finally {
      await page.goto("/resumes"); expect((await request.delete(endpoint)).status()).toBe(200);
    }
  });
}
