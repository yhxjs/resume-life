import { expect, test } from "@playwright/test";
import { mkdtempSync, mkdirSync, rmdirSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

for (const width of [390, 1280]) {
  test(`关闭重开目录选择器，迟到旧目录不能替换新选择 (${width}px)`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 });
    const temp = mkdtempSync(path.join(tmpdir(), "resume-picker-"));
    const first = path.join(temp, "first");
    const second = path.join(temp, "second");
    mkdirSync(first); mkdirSync(second);
    const created = await request.post("/api/projects", { data: { name: `目录会话 ${width}` } });
    expect(created.status()).toBe(201);
    const root = `/api/projects/${(await created.json()).id}`;
    const release = Promise.withResolvers<void>();
    const delivered = Promise.withResolvers<void>();
    const settled = Promise.withResolvers<void>();
    let oldRead = false;
    page.on("response", response => {
      const url = new URL(response.url());
      if (url.pathname === `${root}/scan-repo` && url.searchParams.get("path") === first)
        void response.finished().then(() => settled.resolve());
    });
    page.on("requestfailed", next => {
      const url = new URL(next.url());
      if (url.pathname === `${root}/scan-repo` && url.searchParams.get("path") === first) settled.resolve();
    });
    await page.route(`**${root}/scan-repo?*`, async route => {
      if (new URL(route.request().url()).searchParams.get("path") !== first) return route.continue();
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      expect((await response.json()).currentPath).toBe(first);
      oldRead = true;
      await release.promise;
      try { await route.fulfill({ response }); } catch { /* 关闭会话会取消该浏览器请求。 */ }
      finally { delivered.resolve(); }
    });
    try {
      await page.goto(root.replace("/api/projects/", "/knowledge/"));
      const input = page.getByRole("textbox", { name: "本地工程路径", exact: true });
      await input.fill(first);
      await page.getByRole("button", { name: /浏览目录/ }).click();
      await expect.poll(() => oldRead).toBe(true);
      const dialog = page.getByRole("dialog", { name: "选择本地源码仓库目录" });
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      await input.fill(second);
      await page.getByRole("button", { name: /浏览目录/ }).click();
      await expect(dialog.getByRole("button", { name: "确定选择当前目录", exact: true })).toBeEnabled();
      await expect(dialog.getByTitle(second, { exact: true })).toBeVisible();
      release.resolve();
      await delivered.promise;
      await settled.promise;
      await expect(dialog.getByTitle(second, { exact: true })).toBeVisible();
      await dialog.getByRole("button", { name: "确定选择当前目录", exact: true }).click();
      await expect(page.getByTitle(second, { exact: true })).toBeVisible();
      await expect(page.getByTitle(first, { exact: true })).toHaveCount(0);
      await page.reload();
      await expect(page.getByTitle(second, { exact: true })).toBeVisible();
      expect((await (await request.get(root)).json()).materials_total).toBe(0);
    } finally {
      release.resolve();
      await page.goto("/knowledge");
      expect((await request.delete(root)).status()).toBe(200);
      rmdirSync(first); rmdirSync(second); rmdirSync(temp);
    }
  });

  test(`目录读取失败禁止确认，重试只读并恢复选择 (${width}px)`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 });
    const temp = mkdtempSync(path.join(tmpdir(), "resume-picker-retry-"));
    const created = await request.post("/api/projects", { data: { name: `目录重试 ${width}` } });
    expect(created.status()).toBe(201);
    const root = `/api/projects/${(await created.json()).id}`;
    let failing = true;
    let reads = 0;
    let writes = 0;
    page.on("request", next => {
      if (new URL(next.url()).pathname === `${root}/scan-repo` && next.method() !== "GET") writes++;
    });
    await page.route(`**${root}/scan-repo?*`, async route => {
      reads++;
      if (failing) await route.fulfill({ status: 503, json: { error: "目录暂不可用" } });
      else await route.continue();
    });
    try {
      await page.goto(root.replace("/api/projects/", "/knowledge/"));
      await page.getByRole("textbox", { name: "本地工程路径", exact: true }).fill(temp);
      await page.getByRole("button", { name: /浏览目录/ }).click();
      const dialog = page.getByRole("dialog", { name: "选择本地源码仓库目录" });
      await expect(dialog.getByText(/目录暂不可用/)).toBeVisible();
      await expect(dialog.getByRole("button", { name: "确定选择当前目录", exact: true })).toBeDisabled();
      failing = false;
      await dialog.getByRole("button", { name: "重试读取目录", exact: true }).click();
      await expect(dialog.getByRole("button", { name: "确定选择当前目录", exact: true })).toBeEnabled();
      await expect(dialog.getByTitle(temp, { exact: true })).toBeVisible();
      await dialog.getByRole("button", { name: "确定选择当前目录", exact: true }).click();
      await expect(page.getByTitle(temp, { exact: true })).toBeVisible();
      expect(reads).toBe(2);
      expect(writes).toBe(0);
      expect((await (await request.get(root)).json()).materials_total).toBe(0);
    } finally {
      await page.goto("/knowledge");
      expect((await request.delete(root)).status()).toBe(200);
      rmdirSync(temp);
    }
  });
  test(`真实不存在路径和普通文件明确报错，目录创建后可重试 (${width}px)`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 });
    const temp = mkdtempSync(path.join(tmpdir(), "resume-picker-missing-"));
    const missing = path.join(temp, "created-later");
    const filename = path.join(temp, "note.txt");
    writeFileSync(filename, "合成内容");
    const created = await request.post("/api/projects", { data: { name: `目录错误 ${width}` } });
    expect(created.status()).toBe(201);
    const root = `/api/projects/${(await created.json()).id}`;
    let writes = 0;
    page.on("request", next => {
      if (new URL(next.url()).pathname === `${root}/scan-repo` && next.method() !== "GET") writes++;
    });
    try {
      await page.goto(root.replace("/api/projects/", "/knowledge/"));
      const input = page.getByRole("textbox", { name: "本地工程路径", exact: true });
      await input.fill(filename);
      const fileResponse = page.waitForResponse(response => new URL(response.url()).pathname === `${root}/scan-repo` && new URL(response.url()).searchParams.get("path") === filename);
      await page.getByRole("button", { name: /浏览目录/ }).click();
      const dialog = page.getByRole("dialog", { name: "选择本地源码仓库目录" });
      expect((await fileResponse).status()).toBe(400);
      await expect(dialog.getByRole("alert")).toContainText("目标路径不是文件夹");
      await expect(dialog.getByTitle(filename, { exact: true })).toBeVisible();
      await expect(dialog.getByText("当前目录下没有子文件夹", { exact: true })).toHaveCount(0);
      await expect(dialog.getByRole("button", { name: "确定选择当前目录", exact: true })).toBeDisabled();
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      await expect(input).toHaveValue(filename);
      await input.fill(missing);
      const missingResponse = page.waitForResponse(response => new URL(response.url()).pathname === `${root}/scan-repo` && new URL(response.url()).searchParams.get("path") === missing);
      await page.getByRole("button", { name: /浏览目录/ }).click();
      expect((await missingResponse).status()).toBe(404);
      await expect(dialog.getByRole("alert")).toContainText("目录不存在");
      await expect(dialog.getByTitle(missing, { exact: true })).toBeVisible();
      await expect(dialog.getByText(/^待确认:/)).toContainText(missing);
      await expect(dialog.getByRole("button", { name: "确定选择当前目录", exact: true })).toBeDisabled();
      mkdirSync(missing);
      await dialog.getByRole("button", { name: "重试读取目录", exact: true }).click();
      await expect(dialog.getByRole("button", { name: "确定选择当前目录", exact: true })).toBeEnabled();
      await expect(dialog.getByRole("alert")).toHaveCount(0);
      await expect(dialog.getByText("当前目录下没有子文件夹", { exact: true })).toBeVisible();
      await dialog.getByRole("button", { name: "确定选择当前目录", exact: true }).click();
      await expect(page.getByTitle(missing, { exact: true })).toBeVisible();
      expect(writes).toBe(0);
      expect((await (await request.get(root)).json()).materials_total).toBe(0);
    } finally {
      await page.goto("/knowledge");
      expect((await request.delete(root)).status()).toBe(200);
      if (existsSync(missing)) rmdirSync(missing);
      unlinkSync(filename); rmdirSync(temp);
    }
  });

  test(`真实大目录显示截断提示，进入完整子目录后清除 (${width}px)`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 });
    const temp = mkdtempSync(path.join(tmpdir(), "resume-picker-truncated-"));
    const children = Array.from({ length: 202 }, (_, index) => path.join(temp, `child-${index}`));
    for (const child of children) mkdirSync(child);
    const created = await request.post("/api/projects", { data: { name: `大目录 ${width}` } });
    expect(created.status()).toBe(201);
    const root = `/api/projects/${(await created.json()).id}`;
    try {
      await page.goto(root.replace("/api/projects/", "/knowledge/"));
      await page.getByRole("textbox", { name: "本地工程路径", exact: true }).fill(temp);
      await page.getByRole("button", { name: /浏览目录/ }).click();
      const dialog = page.getByRole("dialog", { name: "选择本地源码仓库目录" });
      await expect(dialog.getByRole("status")).toContainText("仅显示前 200 个子文件夹");
      await expect(dialog.getByRole("button", { name: "进入 >", exact: true })).toHaveCount(200);
      await dialog.getByText("child-0", { exact: true }).click();
      await expect(dialog.getByTitle(children[0]!, { exact: true })).toBeVisible();
      await expect(dialog.getByText("当前目录下没有子文件夹", { exact: true })).toBeVisible();
      await expect(dialog.getByRole("status")).toHaveCount(0);
      await dialog.getByRole("button", { name: "确定选择当前目录", exact: true }).click();
      await expect(page.getByTitle(children[0]!, { exact: true })).toBeVisible();
      expect((await (await request.get(root)).json()).materials_total).toBe(0);
    } finally {
      await page.goto("/knowledge");
      expect((await request.delete(root)).status()).toBe(200);
      for (const child of children) rmdirSync(child);
      rmdirSync(temp);
    }
  });
}
