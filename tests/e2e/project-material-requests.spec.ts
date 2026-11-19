import { expect, test } from "@playwright/test";

for (const width of [390, 1280]) {
  test(`原文旧回包晚于真实保存，重新编辑仍使用新正文和版本 (${width}px)`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 });
    const created = await request.post("/api/projects", { data: { name: `材料时序项目 ${width}` } });
    expect(created.status()).toBe(201);
    const root = `/api/projects/${(await created.json()).id}`;
    const added = await request.post(`${root}/materials`, { data: { title: "待更正材料", content: "旧职责正文" } });
    expect(added.status()).toBe(201);
    const detail = `${root}/materials/${(await added.json()).id}`;
    const release = Promise.withResolvers<void>();
    const delivered = Promise.withResolvers<void>();
    let oldRead = false;
    let reads = 0;
    let writes = 0;
    let failList = false;
    await page.route(`**${detail}`, async route => {
      if (route.request().method() === "PATCH") { writes++; return route.continue(); }
      if (route.request().method() !== "GET" || ++reads !== 1) return route.continue();
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      oldRead = true;
      await release.promise;
      try { await route.fulfill({ response }); } finally { delivered.resolve(); }
    });
    await page.route(`**${root}`, route => route.request().method() === "GET" && failList
      ? route.fulfill({ status: 503, json: { error: "列表暂不可用" } }) : route.continue());
    try {
      await page.goto(root.replace("/api/projects/", "/knowledge/"));
      await page.getByRole("button", { name: "原文", exact: true }).click();
      await expect.poll(() => oldRead).toBe(true);
      await page.getByRole("button", { name: "编辑", exact: true }).click();
      const editor = page.getByRole("textbox", { name: "编辑「待更正材料」材料正文", exact: true });
      await expect(editor).toBeEnabled();
      await editor.fill("更正后的职责，仅测试环境，无线上收益。");
      await page.getByRole("textbox", { name: "编辑材料标题", exact: true }).fill("已更正材料");
      failList = true;
      await page.getByRole("button", { name: "保存", exact: true }).click();
      await expect(page.getByRole("alert").filter({ hasText: "材料已保存" })).toBeVisible();
      const confirmed = await (await request.get(detail)).json();
      expect(confirmed.content).toBe("更正后的职责，仅测试环境，无线上收益。");
      await page.getByRole("button", { name: "原文", exact: true }).click();
      await expect(page.locator("pre").filter({ hasText: confirmed.content })).toBeVisible();
      const oldDelivered = page.waitForResponse(response => response.url().endsWith(detail) && response.request().method() === "GET");
      release.resolve();
      await delivered.promise;
      await (await oldDelivered).finished();
      await expect(page.locator("pre").filter({ hasText: confirmed.content })).toBeVisible();
      await page.getByRole("button", { name: "编辑", exact: true }).click();
      const nextEditor = page.getByRole("textbox", { name: "编辑「已更正材料」材料正文", exact: true });
      await expect(nextEditor).toHaveValue(confirmed.content);
      await nextEditor.fill("再次核实后的职责，仅测试环境。");
      failList = false;
      await page.getByRole("button", { name: "保存", exact: true }).click();
      await expect(nextEditor).toHaveCount(0);
      await expect(page.getByRole("alert").filter({ hasText: "列表刷新失败" })).toHaveCount(0);
      expect((await (await request.get(detail)).json()).content).toBe("再次核实后的职责，仅测试环境。");
      expect(writes).toBe(2);
      expect(reads).toBe(2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally {
      release.resolve();
      failList = false;
      await page.goto("/knowledge");
      expect((await request.delete(root)).status()).toBe(200);
    }
  });
}
