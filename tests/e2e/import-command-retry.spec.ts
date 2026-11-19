import { expect, test } from "@playwright/test";
import { MODULE_KEYS } from "../../src/lib/modules";
import { normalizeImportedModule } from "../../src/lib/resume-import";
import { stripRichText } from "../../src/lib/rich-text";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";

for (const width of [390, 1280]) {
  for (const first of ["not-sent", "saved"] as const) {
    test(`继续本次导入 ${width}px：${first}，刷新后重试沿用原稿且只存一份`, async ({ page, request }, testInfo) => {
      const baseline = await exportEncryptedBackup(request);
      expect(baseline.response.ok()).toBe(true);
      const release = Promise.withResolvers<void>();
      const submissions: { token: string; body: string }[] = [];
      const statuses: number[] = [];
      let receiptReads = 0; let savedId = 0;
      const title = `原稿 ${first} Array<T> &amp;`;
      const text = String.raw`原文 Array<T> &amp; C:\new\resume，未上线，收益尚未统计。`;
      const modules = Object.fromEntries(MODULE_KEYS.map(key => [key, normalizeImportedModule(key, key === "summary" ? { text } : undefined)]));
      try {
        const before = await (await request.get("/api/resumes")).json();
        await page.setViewportSize({ width, height: 900 });
        await page.route("**/api/import/parse", route => route.fulfill({ json: { title, modules } }));
        await page.route("**/api/resumes", async route => {
          if (route.request().method() !== "POST") return route.continue();
          submissions.push({ token: route.request().headers()["idempotency-key"]!, body: route.request().postData()! });
          if (submissions.length === 1 && first === "not-sent") return route.fulfill({ status: 503, json: { error: "合成请求未到服务端" } });
          const response = await route.fetch(); statuses.push(response.status());
          savedId = (await response.json()).id;
          if (submissions.length === 1) return route.fulfill({ status: 503, json: { error: "合成响应丢失，实际已保存" } });
          await release.promise;
          return route.fulfill({ response });
        });
        await page.route("**/api/resumes/requests/*", route => {
          receiptReads++;
          return submissions.length === 1 ? route.fulfill({ status: first === "not-sent" ? 404 : 503, json: { error: "合成回执暂不可用" } }) : route.continue();
        });
        await page.goto("/resumes/import");
        await page.getByLabel("简历原文", { exact: true }).fill(text);
        await page.getByRole("button", { name: "开始智能解析 →", exact: true }).click();
        await page.getByLabel("简历标题", { exact: true }).fill(`校对后的 ${title}`);
        await expect(page.getByRole("textbox", { name: "自我评价第 1 行", exact: true })).toHaveText(text);
        await page.getByRole("button", { name: "确认导入", exact: true }).click();
        const recovery = page.getByRole("region", { name: "导入结果核对" });
        const retry = recovery.getByRole("button", { name: "重试本次导入", exact: true });
        await expect(retry).toBeEnabled();
        expect(submissions).toHaveLength(1); expect(receiptReads).toBe(1);
        expect((await (await request.get("/api/resumes")).json()).length).toBe(before.length + (first === "saved" ? 1 : 0));
        await page.reload();
        await expect(page.getByLabel("简历标题", { exact: true })).toHaveValue(`校对后的 ${title}`);
        await expect(page.getByRole("textbox", { name: "自我评价第 1 行", exact: true })).toHaveText(text);
        await expect(retry).toBeEnabled();
        expect(submissions).toHaveLength(1); expect(receiptReads).toBe(1);
        await retry.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
        await expect.poll(() => statuses.length).toBe(first === "saved" ? 2 : 1);
        await expect(recovery.getByRole("button", { name: "正在重试…", exact: true })).toBeDisabled();
        await expect(recovery.getByRole("button", { name: "重新读取导入结果", exact: true })).toBeDisabled();
        await expect(recovery.getByRole("button", { name: "已核对，允许再次创建", exact: true })).toBeDisabled();
        await expect(page.getByLabel("简历标题", { exact: true })).toBeDisabled();
        expect(submissions).toHaveLength(2); expect(submissions[1]).toEqual(submissions[0]);
        await recovery.scrollIntoViewIfNeeded();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`import-command-retry-${first}-${width}.png`) });
        release.resolve();
        await expect(page).toHaveURL(new RegExp(`/resumes/${savedId}$`));
        expect(statuses).toEqual(first === "saved" ? [201, 200] : [201]);
        expect(submissions).toHaveLength(2); expect(receiptReads).toBe(2);
        expect(await page.evaluate(() => sessionStorage.getItem("resume-life:resume-import:v1"))).toBeNull();
        expect((await (await request.get("/api/resumes")).json()).length).toBe(before.length + 1);
        const saved = await (await request.get(`/api/resumes/${savedId}`)).json();
        expect(saved.resume.title).toBe(`校对后的 ${title}`);
        const summary = saved.modules.find((row: { type: string }) => row.type === "summary").content;
        expect(summary).toEqual(modules.summary);
        expect(stripRichText(summary.text)).toBe(text);
      } finally {
        release.resolve();
        expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
      }
    });
  }
}
