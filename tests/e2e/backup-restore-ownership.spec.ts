import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { BACKUP_MEDIA_TYPE, E2E_BACKUP_PASSWORD, exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import { gate } from "./synthetic-api";

async function create(request: APIRequestContext, name: string) { const response = await request.post("/api/projects", { data: { name } }); expect(response.status()).toBe(201); return (await response.json()).id as number; }
const restore = (page: Page) => page.getByRole("button", { name: "完全覆盖并恢复系统数据", exact: true });
const dialog = (page: Page) => page.getByRole("dialog", { name: "危险操作：完全覆盖现有数据", exact: true });
async function select(page: Page, bytes: Buffer) {
  await page.getByLabel("备份文件", { exact: true }).setInputFiles({ name: "完整备份 <T> &amp;.rlbackup", mimeType: BACKUP_MEDIA_TYPE, buffer: bytes });
  await page.getByLabel("导入密码", { exact: true }).fill(E2E_BACKUP_PASSWORD); await expect(page.getByText("待恢复备份包详情", { exact: true })).toBeVisible();
}

for (const width of [390, 1280]) {
  test(`备份恢复 ${width}px：离页取消确认，返回取消与Escape归还焦点，零覆盖`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000); const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true); let writes = 0;
    try {
      const id = await create(request, "取消恢复时必须保留的项目"); const before = await (await request.get(`/api/projects/${id}`)).json();
      await page.route("**/api/backup/restore", route => { writes++; return route.continue(); }); await page.setViewportSize({ width, height: 900 }); await page.goto("/settings");
      await page.locator('a[href="/"]').first().click(); await expect(page).toHaveURL(/\/$/); await page.goBack(); await select(page, baseline.bytes); await restore(page).click(); await expect(dialog(page)).toBeVisible();
      await page.goForward(); await expect(page).toHaveURL(/\/$/); await expect(page.getByRole("dialog")).toHaveCount(0); await page.goBack(); await select(page, baseline.bytes);
      const button = restore(page); await button.click(); await expect(dialog(page)).toContainText("完整备份 <T> &amp;.rlbackup"); await expect(dialog(page)).toContainText("投递及提交快照"); await expect(dialog(page)).toContainText("灾备"); await expect(dialog(page)).toContainText("保留当前设备");
      await page.screenshot({ path: testInfo.outputPath(`restore-confirm-${width}.png`), animations: "disabled" }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await dialog(page).getByRole("button", { name: "取消", exact: true }).click(); await expect(button).toBeFocused();
      await button.evaluate(node => { (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click(); }); await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).toHaveCount(0); await expect(button).toBeFocused(); expect(writes).toBe(0);
      expect(await (await request.get(`/api/projects/${id}`)).json()).toEqual(before);
    } finally { await page.goto("/"); expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });

  test(`备份恢复 ${width}px：真实覆盖坏回复保留未知锁，明确解锁零写入，重新确认后恢复`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000); const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true); let writes = 0; const snapshots: string[] = [];
    try {
      const keptId = await create(request, "备份中原项目 <T> &amp;"); const backup = await exportEncryptedBackup(request); expect(backup.response.ok()).toBe(true); const lostId = await create(request, "恢复前新增项目应被覆盖");
      const before = await (await request.get(`/api/projects/${keptId}`)).json();
      await page.route("**/api/backup/restore", async route => { writes++; const response = await route.fetch(); expect(response.status(), await response.text()).toBe(200); snapshots.push((await response.json()).snapshotCreated); return writes === 1 ? route.fulfill({ json: {} }) : route.fulfill({ response }); });
      await page.setViewportSize({ width, height: 900 }); await page.goto("/settings"); await select(page, backup.bytes);
      if (width === 1280) await page.getByRole("checkbox", { name: /保留当前设备的 AI Key/ }).uncheck();
      await restore(page).evaluate(node => { (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click(); }); await expect(dialog(page)).toContainText(width === 390 ? "保留当前设备" : "覆盖当前设备配置"); await dialog(page).getByRole("button", { name: "确认完全覆盖并恢复", exact: true }).click();
      const error = page.getByRole("alert").filter({ hasText: "恢复结果尚未确认" }); await expect(error).toBeVisible(); await expect(restore(page)).toBeDisabled(); await expect(page.getByLabel("导入密码", { exact: true })).toHaveValue(E2E_BACKUP_PASSWORD); await expect(page.getByLabel("导入密码", { exact: true })).toBeDisabled();
      expect(writes).toBe(1); expect((await request.get(`/api/projects/${lostId}`)).status()).toBe(404); expect(await (await request.get(`/api/projects/${keptId}`)).json()).toEqual(before); expect(snapshots[0]).toBeTruthy();
      const markerId = await create(request, "首次恢复后新增项目，解锁确认本身不得删除");
      const allow = page.getByRole("button", { name: "核对后允许再次恢复", exact: true }); await allow.click(); const retry = page.getByRole("dialog", { name: "允许再次覆盖恢复", exact: true }); await expect(retry).toContainText("清除恢复后新增或修改的数据"); await retry.getByRole("button", { name: "取消", exact: true }).click(); await expect(allow).toBeFocused(); await expect(restore(page)).toBeDisabled();
      await allow.evaluate(node => { (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click(); }); await page.keyboard.press("Escape"); await expect(allow).toBeFocused();
      await allow.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath(`restore-unknown-${width}.png`), animations: "disabled" }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await allow.click(); await retry.getByRole("button", { name: "允许再次恢复", exact: true }).click(); await expect(restore(page)).toBeEnabled(); expect(writes).toBe(1); expect((await request.get(`/api/projects/${markerId}`)).status()).toBe(200);
      await restore(page).click(); await dialog(page).getByRole("button", { name: "确认完全覆盖并恢复", exact: true }).click(); await expect(page.getByText("恢复前灾备位置", { exact: true })).toBeVisible(); await expect(page.getByText(snapshots[1]!, { exact: true })).toBeVisible(); expect(writes).toBe(2);
      expect((await request.get(`/api/projects/${markerId}`)).status()).toBe(404); expect(await (await request.get(`/api/projects/${keptId}`)).json()).toEqual(before); await expect(page.getByLabel("导入密码", { exact: true })).toHaveValue(""); await expect(page.getByText("待恢复备份包详情", { exact: true })).toHaveCount(0); await expect(page.getByRole("button", { name: "确认完成并刷新页面", exact: true })).toBeVisible();
    } finally { await page.goto("/"); expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });

  test(`备份恢复 ${width}px：真实覆盖已提交但回复延迟，离页中止等待且旧结果不清理新页`, async ({ page, request }) => {
    test.setTimeout(90_000); const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true); const pending = gate(); const saved = gate(); const delivered = gate(); let writes = 0;
    try {
      await page.addInitScript(() => {
        const nativeFetch = window.fetch.bind(window);
        const harness = window as typeof window & { __restoreRequestAborted?: boolean };
        window.fetch = (input, init) => {
          const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          if (new URL(url, location.href).pathname === "/api/backup/restore") {
            harness.__restoreRequestAborted = false;
            init?.signal?.addEventListener("abort", () => { harness.__restoreRequestAborted = true; }, { once: true });
          }
          return nativeFetch(input, init);
        };
      });
      const id = await create(request, "恢复前新增项目");
      await page.route("**/api/backup/restore", async route => { writes++; const response = await route.fetch(); expect(response.status()).toBe(200); saved.release(); await pending.promise; try { await route.fulfill({ response }); } catch { /* 已离页，原服务端提交不回滚。 */ } finally { delivered.release(); } });
      await page.setViewportSize({ width, height: 900 }); await page.goto("/settings"); await select(page, baseline.bytes); await restore(page).click(); await dialog(page).getByRole("button", { name: "确认完全覆盖并恢复", exact: true }).click(); await saved.promise;
      expect((await request.get(`/api/projects/${id}`)).status()).toBe(404); expect(writes).toBe(1); await page.locator('a[href="/"]').first().click(); await expect(page).toHaveURL(/\/$/);
      await expect.poll(() => page.evaluate(() => (window as typeof window & { __restoreRequestAborted?: boolean }).__restoreRequestAborted)).toBe(true);
      await page.goBack(); await expect(page.getByRole("alert").filter({ hasText: "加载设置失败：数据已恢复，请刷新后重新操作" })).toBeVisible();
      pending.release(); await delivered.promise; await expect(page.getByText("恢复前灾备位置", { exact: true })).toHaveCount(0); await expect(page.getByText(/数据恢复成功/)).toHaveCount(0);
      await page.reload(); await select(page, baseline.bytes); await expect(page.getByLabel("导入密码", { exact: true })).toHaveValue(E2E_BACKUP_PASSWORD); await expect(restore(page)).toBeEnabled(); expect(writes).toBe(1);
    } finally { pending.release(); await page.goto("/"); expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });
}
