import { expect, test } from "@playwright/test";
import { mockApi } from "./synthetic-api";

for (const enters of [1, 2]) {
  test(`富文本实际按 ${enters} 次 Enter 后保存、重载和打印预览保留段落`, async ({ page }) => {
    const api = await mockApi(page);
    await page.goto("/resumes/9001");
    await page.getByRole("tab", { name: "个人简介", exact: true }).click();
    const editor = page.locator('[contenteditable="true"]').first();
    await expect(editor).toBeVisible();
    await editor.focus();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("first paragraph");
    for (let index = 0; index < enters; index++) await page.keyboard.press("Enter");
    await page.keyboard.type("last paragraph");

    // 由 Chromium 自己生成块元素，保护真实 Enter 行为而非人工填入 HTML。
    await expect.poll(() => editor.innerHTML()).toMatch(/<(?:div|p)[ >]/);
    await expect.poll(() => api.resume().modules.find((module) => module.key === "summary")?.content)
      .toMatchObject({ text: expect.stringContaining("last paragraph") });
    const expectedText = `first paragraph${"\n".repeat(enters)}last paragraph`;
    await expect.poll(() => page.locator(".paper").innerText()).toContain(expectedText);

    await page.reload();
    await page.getByRole("tab", { name: "个人简介", exact: true }).click();
    await expect.poll(() => editor.innerHTML()).toBe(`first paragraph${"<br>".repeat(enters)}last paragraph`);
    await expect.poll(() => page.locator(".paper").innerText()).toContain(expectedText);

    await page.goto("/resumes/9001/print");
    await expect.poll(() => page.locator(".paper").innerText()).toContain(expectedText);
  });
}
