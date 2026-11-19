import { expect, test, type Page } from "@playwright/test";
import { MODULE_KEYS, normalizeContent } from "../../src/lib/modules";

const importKey = "resume-life:resume-import:v1";
const rawText = "原始导入 Array<T> &amp;\n内部  空格，尚未上线。";
type Kind = "local" | "discard" | "allow";
const title = (kind: Kind) => kind === "local" ? "清除本机敏感副本" : kind === "discard" ? "清除导入暂存" : "允许再次创建简历";
const buttonText = (kind: Kind) => kind === "allow" ? "已核对，允许再次创建" : title(kind);
async function ready(page: Page, kind: Kind) {
  if (kind === "allow") {
    await page.getByRole("button", { name: "重新读取导入结果", exact: true }).click();
    await expect(page.getByRole("button", { name: buttonText(kind), exact: true })).toBeEnabled();
  } else if (kind === "discard") await expect(page.getByLabel("简历原文", { exact: true })).toHaveValue(rawText);
  else await expect(page.getByRole("button", { name: buttonText(kind), exact: true })).toBeVisible();
}

for (const width of [390, 1280]) for (const kind of ["local", "discard", "allow"] as const) {
  test(`草稿确认 ${kind} ${width}px：离页清理、取消焦点及明确确认的实际范围`, async ({ page, request }, testInfo) => {
    test.setTimeout(60_000); const before = await (await request.get("/api/resumes")).json(); let posts = 0; let savedId = 0;
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.route("**/api/resumes", async route => {
        if (route.request().method() !== "POST") return route.continue(); posts++;
        const response = await route.fetch(); expect(response.status()).toBe(201); savedId = (await response.json()).id;
        return route.fulfill({ json: { id: "合成损坏回复" } });
      });
      if (kind === "local") {
        const created = await request.post("/api/resumes", { data: { title: "清理本机时服务端简历必须保留" } }); expect(created.status()).toBe(201); savedId = (await created.json()).id;
        await page.goto("/settings"); await page.evaluate(() => {
          sessionStorage.setItem("resume-life:draft:synthetic", '{"title":"原草稿 <T> &amp; 内部  空格"}');
          localStorage.setItem("resume_life_anonymize_config", "原脱敏规则"); localStorage.setItem("resume_life_project_repo_paths_old:7", '["C:/旧源码"]'); localStorage.setItem("resume_life_project_repo_paths_initial:8", '["C:/当前源码"]');
          sessionStorage.setItem("unrelated", "保留"); localStorage.setItem("unrelated", "保留");
        });
      } else {
        await page.route("**/api/resumes/requests/*", route => route.fulfill({ status: 503, json: { error: "合成回执暂不可读" } }));
        const modules = Object.fromEntries(MODULE_KEYS.map(key => [key, normalizeContent(key, key === "summary" ? { text: rawText } : undefined)]));
        await page.route("**/api/import/parse", route => route.fulfill({ json: { title: "导入原稿 <T> &amp;", modules } }));
        await page.goto("/resumes/import"); await page.getByLabel("简历原文", { exact: true }).fill(rawText);
        if (kind === "allow") {
          await page.getByRole("button", { name: "开始智能解析 →", exact: true }).click(); await expect(page.getByLabel("简历标题", { exact: true })).toHaveValue("导入原稿 <T> &amp;");
          await page.getByRole("button", { name: "确认导入", exact: true }).click(); await expect(page.getByRole("button", { name: buttonText(kind), exact: true })).toBeEnabled(); expect(posts).toBe(1);
        }
      }
      const saved = savedId ? await (await request.get(`/api/resumes/${savedId}`)).json() : null;
      const storage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
      await page.locator('a[href="/"]').first().click(); await expect(page).toHaveURL(/\/$/); await page.goBack(); await ready(page, kind);
      await page.getByRole("button", { name: buttonText(kind), exact: true }).click(); await expect(page.getByRole("dialog", { name: title(kind), exact: true })).toBeVisible();
      await page.goForward(); await expect(page).toHaveURL(/\/$/); await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }))).toEqual(storage);
      await page.goBack(); await ready(page, kind); const trigger = page.getByRole("button", { name: buttonText(kind), exact: true });
      await trigger.click(); const dialog = page.getByRole("dialog", { name: title(kind), exact: true }); await dialog.getByRole("button", { name: "取消", exact: true }).click(); await expect(trigger).toBeFocused();
      await trigger.evaluate(node => { (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click(); }); await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
      expect(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }))).toEqual(storage); expect(posts).toBe(kind === "allow" ? 1 : 0);
      await trigger.click(); await page.screenshot({ path: testInfo.outputPath(`draft-confirm-${kind}-${width}.png`), animations: "disabled" }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await dialog.getByRole("button", { name: kind === "local" ? "清除副本" : kind === "discard" ? "清除暂存" : "允许再次创建", exact: true }).click(); await expect(dialog).toHaveCount(0);
      if (kind === "local") {
        await expect(page.getByRole("status").filter({ hasText: "已清除本机脱敏规则" })).toBeVisible();
        expect(await page.evaluate(() => ({ draft: sessionStorage.getItem("resume-life:draft:synthetic"), config: localStorage.getItem("resume_life_anonymize_config"), paths: Object.keys(localStorage).filter(key => key.startsWith("resume_life_project_repo_paths_")), sessionOther: sessionStorage.getItem("unrelated"), localOther: localStorage.getItem("unrelated") }))).toEqual({ draft: null, config: null, paths: [], sessionOther: "保留", localOther: "保留" });
      } else if (kind === "discard") {
        await expect(page.getByLabel("简历原文", { exact: true })).toHaveValue(""); expect(await page.evaluate(key => sessionStorage.getItem(key), importKey)).toBeNull();
      } else {
        await expect(page.getByLabel("简历标题", { exact: true })).toBeEnabled(); await expect(page.getByLabel("简历标题", { exact: true })).toHaveValue("导入原稿 <T> &amp;");
        const after = await page.evaluate(key => JSON.parse(sessionStorage.getItem(key)!), importKey); expect(after.pending).toBeNull(); expect(after.editor).toEqual(JSON.parse(storage.session[importKey]!).editor);
      }
      expect(posts).toBe(kind === "allow" ? 1 : 0); if (savedId) expect(await (await request.get(`/api/resumes/${savedId}`)).json()).toEqual(saved);
      expect((await (await request.get("/api/resumes")).json()).length).toBe(before.length + (savedId ? 1 : 0));
    } finally { await page.goto("/"); if (savedId) expect((await request.delete(`/api/resumes/${savedId}`)).ok()).toBe(true); }
  });
}
