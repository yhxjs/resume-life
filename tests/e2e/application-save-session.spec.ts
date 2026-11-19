import { expect, test } from "@playwright/test";
import { exportEncryptedBackup, postEncryptedBackup, rewriteEncryptedBackup } from "./backup-helpers";
import { gate } from "./synthetic-api";
import type { RowRecord } from "../../src/lib/backup-records";

for (const width of [390, 1280]) {
  test(`投递保存 ${width}px：未知创建保留原稿，编辑仅只读核对`, async ({ page, request }, testInfo) => {
    test.setTimeout(120_000);
    const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
    try {
      const company = "保存核对 <T> &amp;"; const notes = "尚未上线 <T> &amp;\n内部  空格";
      const other = await request.post("/api/applications", { data: { company: "另一投递", role: "接口开发" } }); expect(other.status()).toBe(201); const otherData = await other.json();
      const records = async () => { let rows: RowRecord[] = []; const backup = await exportEncryptedBackup(request); expect(backup.response.ok()).toBe(true); await rewriteEncryptedBackup(backup.bytes, entries => { rows = entries.filter((row): row is RowRecord => row.kind === "row"); }); return rows; };
      let createdId = 0; let writeCount = 0; let readCount = 0; let mode: "write" | "foreign" | "fail" | "normal" = "write";
      await page.route(/\/api\/applications(?:\/\d+)?$/, async route => {
        const method = route.request().method();
        if (method === "POST" || method === "PATCH") {
          writeCount++; const response = await route.fetch(); expect(response.ok()).toBe(true); if (method === "POST") createdId = (await response.json()).id;
          await route.fulfill({ status: 200, json: {} }); return;
        }
        if (createdId && new URL(route.request().url()).pathname === `/api/applications/${createdId}` && mode !== "write") {
          readCount++; if (mode === "foreign") { await route.fulfill({ status: 200, json: otherData }); return; }
          if (mode === "fail") { await route.fulfill({ status: 503, json: { error: "核对暂不可用" } }); return; }
        }
        await route.continue();
      });
      await page.setViewportSize({ width, height: 900 }); await page.goto("/applications"); await page.getByRole("button", { name: /登记新投递/ }).click();
      const create = page.getByRole("dialog", { name: "新建求职投递", exact: true });
      await create.getByLabel("公司名称 *", { exact: true }).fill(company); await create.getByLabel("目标岗位 *", { exact: true }).fill("接口开发");
      await create.getByLabel("投递备注 / 面试要点手记", { exact: true }).fill(notes);
      await create.locator("form").evaluate(node => { node.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); node.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
      await expect(create.getByRole("alert")).toContainText("保存结果尚未确认"); await expect(create.getByLabel("公司名称 *", { exact: true })).toHaveValue(company); await expect(create.getByLabel("投递备注 / 面试要点手记", { exact: true })).toHaveValue(notes);
      await expect(create.getByRole("button", { name: "立即创建", exact: true })).toBeDisabled(); expect(writeCount).toBe(1);
      await expect(create.getByRole("button", { name: "重新读取保存状态", exact: true })).toHaveCount(0); await expect(create.getByRole("link", { name: "核对投递记录", exact: true })).toHaveAttribute("target", "_blank");
      expect(await create.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true); await page.screenshot({ path: testInfo.outputPath(`application-create-unknown-${width}.png`), animations: "disabled" });
      expect((await (await request.get(`/api/applications/${createdId}`)).json()).notes).toBe(notes);
      await create.getByRole("button", { name: "关闭弹窗", exact: true }).click(); await page.reload();
      const card = page.locator("div[draggable]").filter({ has: page.getByRole("heading", { name: company, exact: true }) }); await card.getByRole("button", { name: "编辑卡片", exact: true }).click();
      const edit = page.getByRole("dialog", { name: "编辑求职投递卡片", exact: true }); const nextNotes = `${notes}\n下一步待确认`;
      await edit.getByLabel("投递备注 / 面试要点手记", { exact: true }).fill(nextNotes);
      await edit.getByRole("button", { name: "更新卡片", exact: true }).click(); await expect(edit.getByRole("alert")).toContainText("保存结果尚未确认"); expect(writeCount).toBe(2);
      const afterWrite = await records();
      for (const readMode of ["foreign", "fail"] as const) {
        mode = readMode; await edit.getByRole("button", { name: "重新读取保存状态", exact: true }).click(); await expect(edit.getByRole("alert")).toContainText("核对失败");
        await expect(edit.getByLabel("投递备注 / 面试要点手记", { exact: true })).toHaveValue(nextNotes); await expect(edit.getByRole("button", { name: "更新卡片", exact: true })).toBeDisabled(); expect(writeCount).toBe(2);
      }
      await expect(edit.getByRole("alert")).toBeFocused(); await expect(edit.getByRole("button", { name: "重新读取保存状态", exact: true })).toBeInViewport(); await page.screenshot({ path: testInfo.outputPath(`application-edit-unknown-${width}.png`), animations: "disabled" });
      mode = "normal"; await edit.getByRole("button", { name: "重新读取保存状态", exact: true }).evaluate(node => { (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click(); });
      await expect(edit).toHaveCount(0); expect(writeCount).toBe(2); expect(readCount).toBe(3); expect(await records()).toEqual(afterWrite);
      expect(await (await request.get(`/api/applications/${otherData.id}`)).json()).toEqual(otherData);
      await card.getByRole("button", { name: "编辑卡片", exact: true }).click(); await expect(edit.getByLabel("投递备注 / 面试要点手记", { exact: true })).toHaveValue(nextNotes);
    } finally { await page.goto("/"); await page.unrouteAll({ behavior: "wait" }); expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });

  test(`投递保存 ${width}px：在途互斥及离页迟到回复不刷新新页面`, async ({ page, request }) => {
    test.setTimeout(120_000);
    const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
    const held = gate(); let writes = 0; let lists = 0; let committed = 0;
    try {
      await page.route("**/api/applications", async route => {
        if (route.request().method() === "POST") { writes++; const response = await route.fetch(); expect(response.status()).toBe(201); committed = (await response.json()).id; await held.promise; await route.fulfill({ response }); }
        else { lists++; await route.continue(); }
      });
      await page.setViewportSize({ width, height: 900 }); await page.goto("/applications");
      await page.locator('a[href="/"]').first().click(); await expect(page).toHaveURL(/\/$/); await page.goBack();
      await page.getByRole("button", { name: /登记新投递/ }).click(); const dialog = page.getByRole("dialog", { name: "新建求职投递", exact: true });
      await dialog.getByLabel("公司名称 *", { exact: true }).fill("在途保存"); await dialog.getByLabel("目标岗位 *", { exact: true }).fill("接口开发");
      await dialog.locator("form").evaluate(node => { node.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); node.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
      await expect.poll(() => committed).toBeGreaterThan(0); expect(writes).toBe(1);
      await expect(dialog.getByRole("button", { name: "关闭弹窗", exact: true })).toBeDisabled(); await page.keyboard.press("Escape"); await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel("公司名称 *", { exact: true })).toBeDisabled();
      const beforeLeave = lists; await page.goForward(); await expect(page).toHaveURL(/\/$/); held.release();
      await page.waitForLoadState("networkidle"); await expect(page).toHaveURL(/\/$/); await expect(dialog).toHaveCount(0); expect(lists).toBe(beforeLeave); expect(writes).toBe(1);
      const persisted = await request.get(`/api/applications/${committed}`); expect(persisted.status()).toBe(200); expect((await persisted.json()).company).toBe("在途保存");
    } finally { held.release(); await page.goto("/"); await page.unrouteAll({ behavior: "wait" }); expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });
}
