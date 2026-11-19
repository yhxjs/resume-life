import { expect, test } from "@playwright/test";
import { MODULE_KEYS } from "../../src/lib/modules";
import { normalizeImportedModule } from "../../src/lib/resume-import";
import { stripRichText } from "../../src/lib/rich-text";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";

const storageKey = "resume-life:resume-import:v1";

for (const width of [390, 1280]) {
  for (const stage of ["posting", "receipt", "detail"] as const) {
    test(`导入暂存归属 ${width}px：${stage} 等待期间换稿，旧响应不能覆盖或清除`, async ({ page, request }, testInfo) => {
      const baseline = await exportEncryptedBackup(request);
      expect(baseline.response.ok()).toBe(true);
      const reached = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let held = false; let creates = 0; let savedId = 0;
      const text = String.raw`原文 Array<T> &amp; C:\new\resume，未上线，收益尚未统计。`;
      const title = `归属 ${stage} Array<T> &amp;`;
      const modules = Object.fromEntries(MODULE_KEYS.map(key => [key, normalizeImportedModule(key, key === "summary" ? { text } : undefined)]));
      try {
        const before = await (await request.get("/api/resumes")).json();
        await page.setViewportSize({ width, height: 900 });
        await page.route("**/api/import/parse", route => route.fulfill({ json: { title, modules } }));
        await page.route("**/api/resumes", async route => {
          if (route.request().method() !== "POST") return route.continue();
          creates++;
          const response = await route.fetch();
          savedId = (await response.json()).id;
          if (stage === "posting" && !held) { held = true; reached.resolve(); await release.promise; }
          return route.fulfill({ response });
        });
        await page.route("**/api/resumes/requests/*", async route => {
          const response = await route.fetch();
          if (stage === "receipt" && !held) { held = true; reached.resolve(); await release.promise; }
          return route.fulfill({ response });
        });
        await page.route(/\/api\/resumes\/\d+$/, async route => {
          const response = await route.fetch();
          if (stage === "detail" && !held) { held = true; reached.resolve(); await release.promise; }
          return route.fulfill({ response });
        });
        await page.goto("/resumes/import");
        await page.getByLabel("简历原文", { exact: true }).fill(text);
        await page.getByRole("button", { name: "开始智能解析 →", exact: true }).click();
        await expect(page.getByLabel("简历标题", { exact: true })).toHaveValue(title);
        await page.getByRole("button", { name: "确认导入", exact: true }).click();
        await reached.promise;
        const original = await page.evaluate(key => sessionStorage.getItem(key)!, storageKey);
        const changed = await page.evaluate(({ key, stage }) => {
          const stored = JSON.parse(sessionStorage.getItem(key)!);
          if (stage === "posting") stored.pending.token = crypto.randomUUID();
          else if (stage === "receipt") stored.editor.text += " 后来修改的原文";
          else { stored.pending.snapshot.title += " 后来的稿"; stored.editor.draft.title = stored.pending.snapshot.title; }
          const raw = JSON.stringify(stored); sessionStorage.setItem(key, raw); return raw;
        }, { key: storageKey, stage });
        release.resolve();
        const recovery = page.getByRole("region", { name: "导入结果核对" });
        await expect(page.getByText(/导入恢复记录已改变/).first()).toBeVisible();
        const allow = recovery.getByRole("button", { name: "已核对，允许再次创建", exact: true });
        await expect(allow).toBeEnabled();
        await expect(page).toHaveURL(/\/resumes\/import$/);
        await expect(page.getByLabel("简历标题", { exact: true })).toBeDisabled();
        expect(await page.evaluate(key => sessionStorage.getItem(key), storageKey)).toBe(changed);
        await allow.click();
        const dialog = page.getByRole("dialog", { name: "允许再次创建简历", exact: true });
        await dialog.getByRole("button", { name: "允许再次创建", exact: true }).click();
        await expect(page.getByText(/尚未允许再次创建/).first()).toBeVisible();
        expect(await page.evaluate(key => sessionStorage.getItem(key), storageKey)).toBe(changed);
        await recovery.scrollIntoViewIfNeeded();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`import-ownership-${stage}-${width}.png`), animations: "disabled" });
        // 恢复命令实际持有的原始记录后，仍能只读核对原存档，无需再发 POST。
        await page.evaluate(({ key, original }) => sessionStorage.setItem(key, original), { key: storageKey, original });
        await recovery.getByRole("button", { name: "重新读取导入结果", exact: true }).click();
        await expect(page).toHaveURL(new RegExp(`/resumes/${savedId}$`));
        expect(creates).toBe(1);
        expect(await page.evaluate(key => sessionStorage.getItem(key), storageKey)).toBeNull();
        expect((await (await request.get("/api/resumes")).json()).length).toBe(before.length + 1);
        const saved = await (await request.get(`/api/resumes/${savedId}`)).json();
        expect(saved.resume.title).toBe(title);
        const summary = saved.modules.find((row: { type: string }) => row.type === "summary").content;
        expect(summary).toEqual(modules.summary);
        expect(stripRichText(summary.text)).toBe(text);
      } finally {
        release.resolve();
        expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
      }
    });
  }

  for (const kind of ["broken", "draft"] as const) {
    test(`导入确认归属 ${width}px：${kind} 确认期间换入新原文，保留最新暂存`, async ({ page, request }, testInfo) => {
      const before = await (await request.get("/api/resumes")).json();
      let creates = 0;
      await page.route("**/api/resumes", route => { if (route.request().method() === "POST") creates++; return route.continue(); });
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/resumes/import");
      await page.getByLabel("简历原文", { exact: true }).fill("确认前的原文");
      const draft = await page.evaluate(key => sessionStorage.getItem(key)!, storageKey);
      if (kind === "broken") {
        await page.evaluate(key => sessionStorage.setItem(key, "{损坏的恢复记录"), storageKey);
        await page.reload();
        const recovery = page.getByRole("region", { name: "导入结果核对" });
        await recovery.getByRole("button", { name: "重新读取导入结果", exact: true }).click();
        await recovery.getByRole("button", { name: "已核对，允许再次创建", exact: true }).click();
      } else {
        await page.getByRole("button", { name: "清除导入暂存", exact: true }).click();
      }
      const dialog = page.getByRole("dialog", { name: kind === "broken" ? "允许再次创建简历" : "清除导入暂存", exact: true });
      await expect(dialog).toBeVisible();
      const changed = await page.evaluate(({ key, draft }) => {
        const stored = JSON.parse(draft); stored.editor.text = String.raw`后来原文 Array<T> &amp; C:\new\resume`;
        const raw = JSON.stringify(stored); sessionStorage.setItem(key, raw); return raw;
      }, { key: storageKey, draft });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`import-confirm-ownership-${kind}-${width}.png`), animations: "disabled" });
      await dialog.getByRole("button", { name: kind === "broken" ? "允许再次创建" : "清除暂存", exact: true }).click();
      await expect(page.getByText(/导入恢复记录已改变/).first()).toBeVisible();
      expect(await page.evaluate(key => sessionStorage.getItem(key), storageKey)).toBe(changed);
      await page.reload();
      await expect(page.getByLabel("简历原文", { exact: true })).toHaveValue(JSON.parse(changed).editor.text);
      expect(creates).toBe(0);
      expect(await (await request.get("/api/resumes")).json()).toEqual(before);
    });
  }
}
