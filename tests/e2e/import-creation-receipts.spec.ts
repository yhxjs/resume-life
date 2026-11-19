import { expect, test } from "@playwright/test";
import { MODULE_KEYS, normalizeContent } from "../../src/lib/modules";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";

for (const width of [390, 1280]) {
  test(`导入创建回执 ${width}px：响应丢失和重复 POST 仍单写，刷新后凭原编号恢复`, async ({ page, request }, testInfo) => {
    const baseline = await exportEncryptedBackup(request);
    expect(baseline.response.ok()).toBe(true);
    let creates = 0; let receiptReads = 0; let detailReads = 0;
    let validReceipt = false; let savedId = 0; let token = "";
    const title = "回执恢复 Array<T> &amp;，未上线";
    const text = "未上线，收益尚未统计。";
    const modules = Object.fromEntries(MODULE_KEYS.map(key => [key, normalizeContent(key, key === "summary" ? { text } : undefined)]));
    try {
      const before = await (await request.get("/api/resumes")).json();
      await page.setViewportSize({ width, height: 900 });
      await page.route("**/api/import/parse", route => route.fulfill({ json: { title, modules } }));
      await page.route("**/api/resumes", async route => {
        if (route.request().method() !== "POST") return route.continue();
        creates++;
        token = route.request().headers()["idempotency-key"]!;
        expect(token).toMatch(/^[0-9a-f-]{36}$/);
        const first = await route.fetch();
        expect(first.status()).toBe(201);
        const saved = await first.json(); savedId = saved.id;
        expect(saved.request_id).toBe(token);
        // 同一个 HTTP 命令被重放；不能留下第二份简历或模块。
        const replay = await route.fetch();
        expect(replay.status()).toBe(200);
        expect(await replay.json()).toEqual(saved);
        return route.fulfill({ status: 502, json: { error: "合成响应丢失，服务端已保存" } });
      });
      await page.route("**/api/resumes/requests/*", async route => {
        receiptReads++;
        expect(route.request().url().endsWith(`/${token}`)).toBe(true);
        const response = await route.fetch(); const receipt = await response.json();
        expect(receipt).toEqual({ request_id: token, status: "succeeded", id: savedId });
        return route.fulfill({ response, json: validReceipt ? receipt : { ...receipt, request_id: "另一命令" } });
      });
      await page.route(/\/api\/resumes\/\d+$/, async route => {
        if (route.request().headers()["referer"]?.endsWith("/resumes/import")) detailReads++;
        return route.continue();
      });
      await page.goto("/resumes/import");
      await page.getByLabel("简历原文", { exact: true }).fill(text);
      await page.getByRole("button", { name: "开始智能解析 →", exact: true }).click();
      const confirm = page.getByRole("button", { name: "确认导入", exact: true });
      await confirm.click();
      const recovery = page.getByRole("region", { name: "导入结果核对" });
      await expect(recovery).toBeVisible();
      await expect(page.getByRole("main").getByRole("alert")).toContainText("创建回执无效");
      await expect(confirm).toBeDisabled();
      expect(creates).toBe(1); expect(receiptReads).toBe(1); expect(detailReads).toBe(0);
      expect((await (await request.get("/api/resumes")).json()).length).toBe(before.length + 1);
      await page.reload();
      await expect(page.getByLabel("简历标题", { exact: true })).toHaveValue(title);
      await expect(confirm).toBeDisabled();
      expect(creates).toBe(1); expect(receiptReads).toBe(1);
      await recovery.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`import-receipt-${width}.png`) });
      validReceipt = true;
      await recovery.getByRole("button", { name: "重新读取导入结果", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/resumes/${savedId}$`));
      expect(creates).toBe(1); expect(receiptReads).toBe(2); expect(detailReads).toBe(1);
      expect(await page.evaluate(() => sessionStorage.getItem("resume-life:resume-import:v1"))).toBeNull();
      const saved = await (await request.get(`/api/resumes/${savedId}`)).json();
      expect(saved.resume.title).toBe(title);
      expect(saved.modules.find((row: { type: string }) => row.type === "summary").content.text).toBe(text);
    } finally {
      expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
    }
  });
}
