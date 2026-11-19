import { expect, test } from "@playwright/test";
import { exportEncryptedBackup, postEncryptedBackup, rewriteEncryptedBackup } from "./backup-helpers";

for (const width of [390, 1280]) for (const kind of ["bank", "jd"] as const) {
  test(`${kind} 删除确认 ${width}px：历史导航离页关闭旧框，重开取消不写入，再次确认只删本项`, async ({ page, request }, info) => {
    test.setTimeout(60_000);
    const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
    const root = kind === "bank" ? "/api/bank" : "/api/tools/jd-portraits";
    const path = kind === "bank" ? "/bank" : "/tools/jd";
    const table = kind === "bank" ? "bank_entries" : "jd_portraits";
    const question = `离页确认原始记录 ${kind} ${width} <T> &amp;`;
    let targetId = 0; let otherId = 0; let deletes = 0; let posts = 0;
    try {
      const seeded = await rewriteEncryptedBackup(baseline.bytes, records => {
        targetId = Math.max(0, ...records.flatMap(row => row.kind === "row" && row.table === table ? [Number(row.data.id)] : [])) + 1;
        otherId = targetId + 1;
        for (const id of [targetId, otherId]) {
          const text = id === targetId ? question : "另一条记录必须保留";
          records.splice(records.findIndex(row => row.kind === "end"), 0, { kind: "row", table, data: kind === "bank"
            ? { id, direction: "离页确认", kind: "tech", question: text, created_at: "2026-11-03T00:00:00.000Z" }
            : { id, jd: text, result: "", created_at: "2026-11-03T00:00:00.000Z" } });
        }
        const manifest = records.find(row => row.kind === "manifest"); const end = records.find(row => row.kind === "end");
        if (manifest?.kind !== "manifest" || end?.kind !== "end") throw new Error("Missing backup envelope");
        end.stats = Object.fromEntries(manifest.tables.map(name => [name, records.filter(row => row.kind === "row" && row.table === name).length]));
        end.totalRecords = Object.values(end.stats).reduce((sum, count) => sum + count, 0);
        manifest.sequences = { ...manifest.sequences, [table]: otherId };
      });
      const restored = await postEncryptedBackup(request, "/api/backup/restore", seeded); expect(restored.status(), await restored.text()).toBe(200);
      const endpoint = `${root}/${targetId}`; const otherEndpoint = `${root}/${otherId}`;
      const before = await (await request.get(endpoint)).json(); const other = await (await request.get(otherEndpoint)).json();
      await page.route(`**${root}**`, async route => {
        if (route.request().method() === "DELETE") deletes++;
        if (route.request().method() === "POST") posts++;
        return route.continue();
      });
      await page.setViewportSize({ width, height: 900 }); await page.goto(path);
      const row = kind === "bank" ? page.getByRole("listitem").filter({ has: page.getByText(question, { exact: true }) })
        : page.locator(`a[href="/tools/jd/${targetId}"]`).filter({ hasText: "查看画像" }).locator("..").locator("..").locator("..");
      const remove = row.getByRole("button", { name: "删除", exact: true });
      await expect(remove).toBeVisible();
      // 通过真实 Next Link 建立 SPA 历史，再回到列表；全页 reload 会顺带卸载全局宿主，掩盖旧确认残留。
      await page.locator('a[href="/"]').first().click(); await expect(page).toHaveURL(/\/$/);
      await page.goBack(); await expect(page).toHaveURL(new RegExp(`${path}$`));
      await remove.click();
      const dialog = page.getByRole("dialog", { name: kind === "bank" ? "删除题目" : "删除历史记录", exact: true });
      await expect(dialog).toContainText(`#${targetId}`);
      await page.goForward(); await expect(page).toHaveURL(/\/$/);
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect.poll(() => page.evaluate(() => document.body.style.overflow)).not.toBe("hidden");
      expect(deletes).toBe(0); expect(posts).toBe(0);
      expect(await (await request.get(endpoint)).json()).toEqual(before);
      await page.goBack(); await expect(remove).toBeEnabled();
      await remove.click(); await expect(dialog).toContainText(`#${targetId}`);
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      await expect(dialog).toHaveCount(0); await expect(remove).toBeEnabled();
      expect(deletes).toBe(0); expect(await (await request.get(endpoint)).json()).toEqual(before);
      await remove.click(); await dialog.getByRole("button", { name: "删除", exact: true }).click();
      await expect(row).toHaveCount(0); expect(deletes).toBe(1); expect(posts).toBe(0);
      expect((await request.get(endpoint)).status()).toBe(404);
      expect(await (await request.get(otherEndpoint)).json()).toEqual(other);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`${kind}-delete-navigation-${width}.png`), animations: "disabled" });
    } finally {
      await page.goto("/");
      expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
    }
  });
}
