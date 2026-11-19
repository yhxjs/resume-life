import { expect, test } from "@playwright/test";

for (const width of [390, 1280]) test(`预检确认期间后退离页移除旧确认框，前进重开可重新确认 (${width}px)`, async ({ page, request }) => {
  await page.setViewportSize({ width, height: 900 });
  const name = `确认会话 ${width}`;
  const created = await request.post("/api/projects", { data: { name } });
  expect(created.status()).toBe(201);
  const root = `/api/projects/${(await created.json()).id}`;
  const before = await (await request.get(root)).json();
  let checks = 0;
  let scans = 0;
  await page.route(`**${root}/scan-repo*`, async route => {
    if (route.request().method() === "GET") return route.fulfill({ json: { codex: { available: true }, claude: { available: false }, recommended: "codex" } });
    if (new URL(route.request().url()).searchParams.get("action") !== "check-relation") {
      scans++;
      return route.fulfill({ status: 503, json: { error: "不应启动扫描" } });
    }
    checks++;
    return route.fulfill({ json: { isRelated: null, reason: checks === 1 ? "离页前的旧关联提示" : "重新进入后的新关联提示", method: "heuristic" } });
  });
  try {
    await page.goto("/knowledge");
    await page.getByRole("link", { name, exact: true }).click();
    await page.getByRole("button", { name: /扫描本地代码仓库/ }).click();
    const scan = page.getByRole("dialog", { name: /一键扫描本地仓库提炼项目亮点/ });
    for (const repoPath of ["D:\\synthetic\\frontend", "D:\\synthetic\\backend"]) {
      await scan.locator("#repo-path-input").fill(repoPath);
      await scan.getByRole("button", { name: "+ 添加", exact: true }).click();
    }
    await scan.getByRole("button", { name: "合并扫描 2 个代码库", exact: true }).click();
    const confirmation = page.getByRole("dialog", { name: "代码库关联性暂时无法确认", exact: true });
    await expect(confirmation).toContainText("离页前的旧关联提示");
    await page.goBack();
    await expect(page).toHaveURL(/\/knowledge$/);
    await expect(confirmation).toHaveCount(0);
    await expect(scan).toHaveCount(0);
    await page.goForward();
    await expect(page).toHaveURL(new RegExp(`/knowledge/${before.id}$`));
    await page.getByRole("button", { name: /扫描本地代码仓库/ }).click();
    await scan.getByRole("button", { name: "合并扫描 2 个代码库", exact: true }).click();
    await expect(confirmation).toContainText("重新进入后的新关联提示");
    await expect(confirmation).not.toContainText("离页前的旧关联提示");
    await confirmation.getByRole("button", { name: "取消并调整路径", exact: true }).click();
    await expect(scan.getByRole("button", { name: "合并扫描 2 个代码库", exact: true })).toBeEnabled();
    expect(checks).toBe(2);
    expect(scans).toBe(0);
    expect(await (await request.get(root)).json()).toEqual(before);
    expect((await (await request.get(`${root}/summary-history`)).json()).items).toEqual([]);
  } finally {
    await page.goto("/knowledge");
    expect((await request.delete(root)).status()).toBe(200);
  }
});
