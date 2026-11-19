import { expect, test, type Page } from "@playwright/test";
import { MODULE_KEYS, normalizeContent } from "../../src/lib/modules";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";

async function enterDraft(page: Page, title: string) {
  const modules = Object.fromEntries(MODULE_KEYS.map(key => [key, normalizeContent(key,
    key === "basic" ? { name: "合成人物" } : key === "summary" ? { text: "未上线，收益尚未统计。" } : undefined)]));
  await page.route("**/api/import/parse", route => route.fulfill({ json: { title, modules } }));
  await page.goto("/resumes/import");
  await page.getByLabel("简历原文", { exact: true }).fill(String.raw`Array<T> &amp; C:\new\resume，未上线，收益尚未统计。`);
  await page.getByRole("button", { name: "开始智能解析 →", exact: true }).click();
  await expect(page.getByRole("heading", { name: "确认解析草稿" })).toBeVisible();
}

for (const width of [390, 1280]) {
  test(`确认导入恢复 ${width}px：保存后坏响应只读核对，双击单写，显式另建才新增`, async ({ page, request }, testInfo) => {
    const baseline = await exportEncryptedBackup(request);
    expect(baseline.response.ok()).toBe(true);
    const release = Promise.withResolvers<void>();
    let creates = 0; let reads = 0;
    let readMode: "fail" | "invalid" | "valid" = "fail";
    let savedId = 0;
    const title = `导入完整原稿 Array<T> &amp; ${"长标题".repeat(12)}`;
    try {
      const before = await (await request.get("/api/resumes")).json();
      await page.setViewportSize({ width, height: 900 });
      await enterDraft(page, title);
      // 回执服务也不可读时，仍须保留人工核对与显式另建路径。
      await page.route("**/api/resumes/requests/*", route => creates === 1
        ? route.fulfill({ status: 503, json: { error: "合成回执读取失败" } }) : route.continue());
      await page.route("**/api/resumes", async route => {
        if (route.request().method() === "POST") {
          creates++;
          const response = await route.fetch();
          expect(response.status()).toBe(201);
          if (creates === 1) {
            savedId = (await response.json()).id;
            await release.promise;
            return route.fulfill({ response, json: { id: "损坏的成功编号" } });
          }
          return route.fulfill({ response });
        }
        reads++;
        if (readMode === "fail") return route.fulfill({ status: 503, json: { error: "合成列表读取失败" } });
        const response = await route.fetch();
        if (readMode === "invalid") {
          const rows = await response.json();
          return route.fulfill({ response, json: [...rows, rows[0]] });
        }
        return route.fulfill({ response });
      });
      const confirm = page.getByRole("button", { name: "确认导入", exact: true });
      await confirm.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
      await expect.poll(() => savedId).toBeGreaterThan(0);
      expect(creates).toBe(1);
      const editors = page.getByRole("group", { name: "导入草稿编辑区", includeHidden: true });
      await expect(editors).toHaveAttribute("inert", "");
      await expect(page.getByLabel("简历标题", { exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: "返回重新解析", exact: true })).toBeDisabled();
      expect((await (await request.get("/api/resumes")).json()).length).toBe(before.length + 1);
      release.resolve();
      const recovery = page.getByRole("region", { name: "导入结果核对" });
      await expect(page.getByRole("main").getByRole("alert")).toContainText("读取简历列表失败");
      await page.reload();
      await expect(page.getByRole("main").getByRole("alert")).toContainText("已恢复上次导入和待核对的创建结果");
      await expect(page.getByLabel("简历标题", { exact: true })).toHaveValue(title);
      await expect(confirm).toBeDisabled();
      expect(creates).toBe(1); expect(reads).toBe(1);
      const allow = recovery.getByRole("button", { name: "已核对，允许再次创建", exact: true });
      await expect(allow).toBeDisabled();
      readMode = "invalid";
      await recovery.getByRole("button", { name: "重新读取导入结果", exact: true }).click();
      await expect(page.getByRole("main").getByRole("alert")).toContainText("重复记录");
      await expect(allow).toBeDisabled();
      readMode = "valid";
      await recovery.getByRole("button", { name: "重新读取导入结果", exact: true }).click();
      await expect(recovery.getByRole("link", { name: `#${savedId} · ${title}（新窗口核对）`, exact: true })).toHaveAttribute("href", `/resumes/${savedId}`);
      await expect(page).toHaveURL(/\/resumes\/import$/);
      await expect(allow).toBeEnabled();
      expect(creates).toBe(1); expect(reads).toBe(3);
      await recovery.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`import-create-unknown-${width}.png`) });
      await allow.click();
      const dialog = page.getByRole("dialog", { name: "允许再次创建简历", exact: true });
      await expect(dialog).toContainText(title);
      await expect(dialog).toContainText("可能产生两份简历");
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      await expect(confirm).toBeDisabled();
      await allow.click();
      await dialog.getByRole("button", { name: "允许再次创建", exact: true }).click();
      await expect(confirm).toBeEnabled();
      expect(creates).toBe(1);
      await page.getByLabel("简历标题", { exact: true }).fill("明确另建的核对稿");
      await confirm.click();
      await expect(page).toHaveURL(/\/resumes\/\d+$/);
      expect(creates).toBe(2);
      const original = await (await request.get(`/api/resumes/${savedId}`)).json();
      expect(original.resume.title).toBe(title);
      expect(original.modules.find((row: { type: string }) => row.type === "summary").content.text).toBe("未上线，收益尚未统计。");
      expect((await (await request.get("/api/resumes")).json()).length).toBe(before.length + 2);
    } finally {
      release.resolve();
      expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
    }
  });

  test(`确认导入回读 ${width}px：串记录响应不导航，重新读取有效存档不重复创建`, async ({ page, request }, testInfo) => {
    const baseline = await exportEncryptedBackup(request);
    expect(baseline.response.ok()).toBe(true);
    let creates = 0; let wrong = true; let savedId = 0; let detailReads = 0;
    try {
      await page.setViewportSize({ width, height: 900 });
      await enterDraft(page, "回读身份核对");
      await page.route("**/api/resumes", async route => {
        if (route.request().method() === "POST") creates++;
        return route.continue();
      });
      await page.route(/\/api\/resumes\/\d+$/, async route => {
        // 导航后的正式编辑器也会读取详情；这里只计导入页的创建核对。
        if (!route.request().headers()["referer"]?.endsWith("/resumes/import")) return route.continue();
        const response = await route.fetch();
        const saved = await response.json();
        savedId = saved.resume.id; detailReads++;
        return route.fulfill({ response, json: wrong ? { ...saved, resume: { ...saved.resume, id: savedId + 99 } } : saved });
      });
      await page.getByRole("button", { name: "确认导入", exact: true }).click();
      const recovery = page.getByRole("region", { name: "导入结果核对" });
      await expect(recovery.getByRole("button", { name: "重新读取导入结果", exact: true })).toBeEnabled();
      await expect(page.getByRole("main").getByRole("alert")).toContainText("保存回读与本次导入草稿不符");
      await expect(page).toHaveURL(/\/resumes\/import$/);
      expect(creates).toBe(1);
      await page.reload();
      await expect(page.getByRole("main").getByRole("alert")).toContainText("已恢复上次导入和待核对的创建结果");
      expect(creates).toBe(1); expect(detailReads).toBe(1);
      await recovery.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`import-create-mismatched-${width}.png`) });
      wrong = false;
      await recovery.getByRole("button", { name: "重新读取导入结果", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/resumes/${savedId}$`));
      expect(creates).toBe(1); expect(detailReads).toBe(2);
      expect(await page.evaluate(() => sessionStorage.getItem("resume-life:resume-import:v1"))).toBeNull();
    } finally {
      expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
    }
  });
}
