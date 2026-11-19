import { expect, test } from "@playwright/test";

for (const width of [390, 1280]) test(`迟到的 CLI 推荐保留手动工具选择，重开使用新环境 (${width}px)`, async ({ page, request }) => {
  await page.setViewportSize({ width, height: 900 });
  const created = await request.post("/api/projects", { data: { name: `工具选择 ${width}` } });
  expect(created.status()).toBe(201);
  const root = `/api/projects/${(await created.json()).id}`;
  const original = await (await request.get(root)).json();
  const release = Promise.withResolvers<void>();
  const detected = Promise.withResolvers<void>();
  const bodies: { preferredCli: string; repoPaths: string[] }[] = [];
  let detections = 0;
  await page.route(`**${root}/scan-repo`, async route => {
    if (route.request().method() === "GET") {
      detections++;
      if (detections === 1) {
        detected.resolve();
        await release.promise;
        return route.fulfill({ json: { codex: { available: true }, claude: { available: true }, recommended: "claude" } });
      }
      return route.fulfill({ json: { codex: { available: false }, claude: { available: true }, recommended: "claude" } });
    }
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ status: 503, json: { error: "合成扫描失败，可重新选择工具" } });
  });
  try {
    await page.goto(`/knowledge/${original.id}`);
    await page.getByRole("button", { name: /扫描本地代码仓库/ }).click();
    const scan = page.getByRole("dialog", { name: /一键扫描本地仓库提炼项目亮点/ });
    await detected.promise;
    await scan.getByRole("button", { name: /Codex CLI/ }).click();
    release.resolve();
    await expect(scan.getByRole("button", { name: /Claude Code/ }).locator('[title="已安装"]')).toBeVisible();
    await scan.locator("#repo-path-input").fill("D:\\synthetic\\engine-project");
    await scan.getByRole("button", { name: "+ 添加", exact: true }).click();
    await scan.getByRole("button", { name: "开始扫描并提炼", exact: true }).click();
    await expect(scan.getByText("合成扫描失败，可重新选择工具", { exact: false })).toBeVisible();
    expect(bodies).toEqual([{ preferredCli: "codex", repoPaths: ["D:\\synthetic\\engine-project"] }]);
    await scan.getByRole("button", { name: "取消", exact: true }).click();
    await expect(scan).toHaveCount(0);
    await page.getByRole("button", { name: /扫描本地代码仓库/ }).click();
    await expect(scan.getByRole("button", { name: /Codex CLI/ })).toBeDisabled();
    await expect(scan.getByRole("button", { name: /Claude Code/ })).toBeEnabled();
    await expect(scan.getByText("合成扫描失败，可重新选择工具", { exact: false })).toHaveCount(0);
    await scan.getByRole("button", { name: "开始扫描并提炼", exact: true }).click();
    await expect.poll(() => bodies.length).toBe(2);
    expect(bodies[1]).toEqual({ preferredCli: "auto", repoPaths: ["D:\\synthetic\\engine-project"] });
    expect(await (await request.get(root)).json()).toEqual(original);
    expect((await (await request.get(`${root}/summary-history`)).json()).items).toEqual([]);
  } finally {
    release.resolve();
    await page.goto("/knowledge");
    expect((await request.delete(root)).status()).toBe(200);
  }
});
