import { expect, test } from "@playwright/test";

for (const width of [390, 1280]) {
  test(`关联预检等待时可以点击取消，迟到回复不能启动扫描，路径保留可重试 (${width}px)`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 });
    const created = await request.post("/api/projects", { data: { name: `预检取消 ${width}` } });
    expect(created.status()).toBe(201);
    const root = `/api/projects/${(await created.json()).id}`;
    const paths = ["D:\\synthetic\\frontend", "D:\\synthetic\\backend"];
    const release = Promise.withResolvers<void>();
    const delivered = Promise.withResolvers<void>();
    let checking = 0;
    let scans = 0;
    await page.route(`**${root}/scan-repo*`, async route => {
      const url = new URL(route.request().url());
      if (route.request().method() === "GET") return route.fulfill({ json: { codex: { available: true }, claude: { available: false }, recommended: "codex" } });
      if (url.searchParams.get("action") !== "check-relation") {
        scans++;
        return route.fulfill({ status: 503, json: { error: "合成扫描未启动" } });
      }
      expect(route.request().postDataJSON().repoPaths).toEqual(paths);
      checking++;
      if (checking > 1) return route.fulfill({ json: { isRelated: null, reason: "合成未知关联", method: "heuristic" } });
      await release.promise;
      try { await route.fulfill({ json: { isRelated: true, reason: "合成共同模块", method: "model" } }); }
      catch { /* 取消会中止浏览器请求。 */ }
      finally { delivered.resolve(); }
    });
    try {
      await page.goto(root.replace("/api/projects/", "/knowledge/"));
      await page.getByRole("button", { name: /扫描本地代码仓库/ }).click();
      const dialog = page.getByRole("dialog", { name: /一键扫描本地仓库提炼项目亮点/ });
      for (const repoPath of paths) {
        await dialog.locator("#repo-path-input").fill(repoPath);
        await dialog.getByRole("button", { name: "+ 添加", exact: true }).click();
      }
      await dialog.getByRole("button", { name: "合并扫描 2 个代码库", exact: true }).click();
      await expect.poll(() => checking).toBe(1);
      await expect(dialog.getByRole("button", { name: "AI 关联性研判中…", exact: true })).toBeDisabled();
      // 普通真实点击必须通过命中测试；不使用 force 越过加载遮罩。
      await dialog.getByRole("button", { name: "取消", exact: true }).click({ timeout: 2500 });
      await expect(dialog.getByRole("button", { name: "合并扫描 2 个代码库", exact: true })).toBeEnabled();
      await expect(dialog.getByTitle(paths[0]!, { exact: true })).toBeVisible();
      await expect(dialog.getByTitle(paths[1]!, { exact: true })).toBeVisible();
      release.resolve();
      await delivered.promise;
      expect(scans).toBe(0);
      await dialog.getByRole("button", { name: "合并扫描 2 个代码库", exact: true }).click();
      const confirmation = page.getByRole("dialog", { name: "代码库关联性暂时无法确认", exact: true });
      await expect(confirmation).toBeVisible();
      await confirmation.getByRole("button", { name: "取消并调整路径", exact: true }).click();
      await expect(dialog.getByRole("button", { name: "合并扫描 2 个代码库", exact: true })).toBeEnabled();
      expect(checking).toBe(2);
      expect(scans).toBe(0);
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      expect((await (await request.get(root)).json()).materials_total).toBe(0);
      expect((await (await request.get(`${root}/summary-history`)).json()).items).toEqual([]);
    } finally {
      release.resolve();
      await page.goto("/knowledge");
      expect((await request.delete(root)).status()).toBe(200);
    }
  });
}
