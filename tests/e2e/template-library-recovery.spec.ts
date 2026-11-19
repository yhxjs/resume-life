import { expect, test } from "@playwright/test";
import { BUILTIN_STYLES, type CustomTemplate } from "../../src/lib/templates";

for (const width of [390, 1280]) {
  test(`模板删除 ${width}px：确认归属、未知只读核对及简历回退范围`, async ({ page, request }, testInfo) => {
    test.setTimeout(60_000);
    const templates: CustomTemplate[] = []; const resumeIds: number[] = [];
    async function template(name: string) {
      const response = await request.post("/api/templates", { data: { name, style: BUILTIN_STYLES.modern } }); expect(response.status()).toBe(201);
      const item = await response.json() as CustomTemplate; templates.push(item); return item;
    }
    const a = await template(`待删除模板<T>-${width}`); const b = await template(`保留模板-${width}`);
    const endpoint = `/api/templates/${a.id}`; let deletes = 0; let unknown = false; let brokenRead = false;
    try {
      for (const item of [a, b]) {
        const response = await request.post("/api/resumes", { data: { title: `模板范围验证-${item.id}` } }); expect(response.status()).toBe(201);
        const { id } = await response.json(); resumeIds.push(id);
        const { resume } = await (await request.get(`/api/resumes/${id}`)).json();
        expect((await request.patch(`/api/resumes/${id}`, { data: { dataGeneration: resume.dataGeneration, styleRevision: resume.styleRevision, template: `custom:${item.id}`, styleOverrides: { accent: "#123456", baseSize: 14 } } })).ok()).toBe(true);
      }
      const originals = await Promise.all(resumeIds.map(async id => (await request.get(`/api/resumes/${id}`)).json()));
      await page.route("**/api/templates", route => unknown && brokenRead && route.request().method() === "GET" ? route.fulfill({ json: { items: [null] } }) : route.continue());
      await page.route(`**${endpoint}`, async route => {
        if (route.request().method() !== "DELETE") return route.continue();
        deletes++; const response = await route.fetch(); expect(response.ok()).toBe(true); unknown = true; brokenRead = true;
        await route.fulfill({ json: { ok: false } });
      });
      await page.setViewportSize({ width, height: 900 }); await page.goto("/styles");
      const row = page.getByRole("button", { name: new RegExp(`^${a.name}`) }).locator(".."); const trigger = row.getByRole("button", { name: "删除", exact: true });
      await expect(trigger).toBeEnabled(); await page.locator('a[href="/"]').first().click(); await expect(page).toHaveURL(/\/$/); await page.goBack(); await expect(trigger).toBeEnabled();
      await trigger.click(); await expect(page.getByRole("dialog", { name: "删除模板" })).toBeVisible();
      await page.goForward(); await expect(page).toHaveURL(/\/$/); await expect(page.getByRole("dialog")).toHaveCount(0); expect(deletes).toBe(0);
      await page.goBack(); await expect(trigger).toBeEnabled();
      await trigger.click(); await page.getByRole("button", { name: "取消", exact: true }).click(); await expect(trigger).toBeFocused();
      await trigger.evaluate(node => { (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click(); }); await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0); await expect(trigger).toBeFocused(); expect(deletes).toBe(0);
      await page.getByRole("button", { name: a.name, exact: true }).click(); const name = page.getByRole("textbox", { name: "模板名称" }); await name.fill("尚未保存的检查器草稿");
      await trigger.click(); const dialog = page.getByRole("dialog", { name: "删除模板" });
      await expect(dialog).toContainText(`#${a.id}`); await expect(dialog).toContainText(a.created_at); await expect(dialog).toContainText("样式覆盖保留");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`template-delete-${width}.png`), animations: "disabled" });
      await dialog.getByRole("button", { name: "删除", exact: true }).click();
      const retry = page.getByRole("button", { name: "重新读取删除状态" }); await expect(retry).toBeVisible();
      await expect(page.getByRole("button", { name: "另存为新模板" })).toBeDisabled(); await expect(trigger).toBeDisabled(); await expect(name).toHaveValue("尚未保存的检查器草稿");
      expect(deletes).toBe(1); expect((await (await request.get("/api/templates")).json()).items.some((item: CustomTemplate) => item.id === a.id)).toBe(false);
      await page.screenshot({ path: testInfo.outputPath(`template-unknown-${width}.png`), animations: "disabled" });
      brokenRead = false; await retry.click(); await expect(retry).toHaveCount(0); await expect(page.getByRole("button", { name: new RegExp(a.name.replace(/[<>]/g, ".")) })).toHaveCount(0);
      await expect(name).toHaveValue("尚未保存的检查器草稿"); await expect(page.getByRole("button", { name: "保存修改", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "另存为新模板" })).toBeEnabled(); expect(deletes).toBe(1);
      const remaining = (await (await request.get("/api/templates")).json()).items as CustomTemplate[]; expect(remaining.find(item => item.id === b.id)).toEqual(b);
      const after = await Promise.all(resumeIds.map(async id => (await request.get(`/api/resumes/${id}`)).json()));
      expect(after[0].resume.template).toBe("classic"); expect(after[0].resume.style_overrides).toEqual(originals[0].resume.style_overrides);
      expect(after[0].resume.title).toBe(originals[0].resume.title); expect(after[0].modules).toEqual(originals[0].modules); expect(after[1]).toEqual(originals[1]);
    } finally {
      await page.goto("/"); for (const id of resumeIds) await request.delete(`/api/resumes/${id}`); for (const item of templates) await request.delete(`/api/templates/${item.id}`);
    }
  });

  test(`模板修复 ${width}px：离页清理、取消焦点及显式保存`, async ({ page, request }, testInfo) => {
    const response = await request.post("/api/templates", { data: { name: `待修复模板<T>-${width}`, style: BUILTIN_STYLES.modern } }); expect(response.status()).toBe(201);
    const item = await response.json() as CustomTemplate; let patches = 0; let preview = true;
    await page.route("**/api/templates", async route => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch(); const body = await response.json();
      if (preview) body.items = body.items.map((entry: CustomTemplate) => entry.id === item.id ? { ...entry, style: BUILTIN_STYLES.classic, corrupted: true } : entry);
      await route.fulfill({ response, json: body });
    });
    await page.route(`**/api/templates/${item.id}`, async route => { if (route.request().method() === "PATCH") { patches++; preview = false; } await route.continue(); });
    try {
      await page.setViewportSize({ width, height: 900 }); await page.goto("/styles");
      const trigger = page.getByRole("button", { name: new RegExp(`${item.name}.*已损坏`) });
      await expect(trigger).toBeVisible(); await page.locator('a[href="/"]').first().click(); await expect(page).toHaveURL(/\/$/); await page.goBack(); await expect(trigger).toBeVisible();
      await trigger.click(); await expect(page.getByRole("dialog", { name: "修复损坏模板" })).toBeVisible();
      await page.goForward(); await expect(page).toHaveURL(/\/$/); await expect(page.getByRole("dialog")).toHaveCount(0); expect(patches).toBe(0);
      await page.goBack(); await expect(trigger).toBeVisible();
      await trigger.click(); await page.getByRole("button", { name: "取消", exact: true }).click(); await expect(trigger).toBeFocused();
      await trigger.evaluate(node => { (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click(); }); await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0); await expect(trigger).toBeFocused();
      await trigger.click(); const dialog = page.getByRole("dialog", { name: "修复损坏模板" }); await expect(dialog).toContainText(`#${item.id}`); await expect(dialog).toContainText(item.name);
      await page.screenshot({ path: testInfo.outputPath(`template-repair-${width}.png`), animations: "disabled" });
      await dialog.getByRole("button", { name: "确定", exact: true }).click(); await expect(page.getByRole("textbox", { name: "模板名称" })).toHaveValue(item.name);
      await expect(page.getByRole("radio", { name: "单栏", exact: true })).toHaveAttribute("aria-checked", "true"); expect(patches).toBe(0);
      expect((await (await request.get("/api/templates")).json()).items.find((entry: CustomTemplate) => entry.id === item.id)).toEqual(item);
      await page.getByRole("button", { name: "保存修改", exact: true }).click(); await expect(page.getByRole("button", { name: new RegExp(`${item.name}.*编辑中`) })).not.toContainText("已损坏");
      expect(patches).toBe(1); expect((await (await request.get("/api/templates")).json()).items.find((entry: CustomTemplate) => entry.id === item.id).style.layout).toBe("single");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { await page.goto("/"); await request.delete(`/api/templates/${item.id}`); }
  });
}
