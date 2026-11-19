import { expect, test } from "@playwright/test";
import { publishResume } from "./resume-version-helpers";
import { gate } from "./synthetic-api";

test.use({ actionTimeout: 10_000 });
for (const width of [390, 1280]) {
  test(`版本分支 ${width}px：离页取消确认，重开取消零写入，连续点击只分支一次`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 });
    const created = await request.post("/api/resumes", { data: { title: `分支确认 ${width}` } }); expect(created.status()).toBe(201);
    const id = (await created.json()).id; const endpoint = `/api/resumes/${id}`;
    const version = await publishResume(request, id); let posts = 0;
    const before = await (await request.get(endpoint)).json();
    await page.route(`**${endpoint}/versions/*/branch`, route => { posts++; return route.continue(); });
    const button = page.getByRole("button", { name: "从此版本开始分支", exact: true });
    const dialog = page.getByRole("dialog", { name: "从 v1 开始分支", exact: true });
    try {
      await page.goto(`/resumes/${id}/versions?version=${version.id}`); await expect(button).toBeVisible();
      await page.locator('a[href="/"]').first().click(); await expect(page).toHaveURL(/\/$/); await page.goBack();
      await button.click(); await expect(dialog).toBeVisible(); await page.goForward(); await expect(page).toHaveURL(/\/$/);
      await expect(dialog).toHaveCount(0); expect(posts).toBe(0);
      expect(await (await request.get(endpoint)).json()).toEqual(before);
      await page.goBack(); await button.click(); await dialog.getByRole("button", { name: "取消", exact: true }).click();
      await expect(dialog).toHaveCount(0); await expect(button).toBeFocused(); expect(posts).toBe(0);
      await button.evaluate(node => { (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click(); });
      await dialog.getByRole("button", { name: "替换草稿并开始编辑", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/resumes/${id}$`)); await expect(dialog).toHaveCount(0); expect(posts).toBe(1);
      await expect(page.getByRole("tab", { name: "基本信息", exact: true })).toBeVisible();
      expect((await (await request.get(`${endpoint}/versions`)).json()).versions).toHaveLength(1);
    } finally { await page.goto("/resumes"); expect((await request.delete(endpoint)).status()).toBe(200); }
  });

  test(`版本分支 ${width}px：服务端已写入，离页后迟到回复不拉回旧编辑器`, async ({ page, request }) => {
    await page.setViewportSize({ width, height: 900 });
    const created = await request.post("/api/resumes", { data: { title: `分支等待 ${width}` } }); expect(created.status()).toBe(201);
    const id = (await created.json()).id; const endpoint = `/api/resumes/${id}`; const version = await publishResume(request, id);
    const written = gate(); const responseGate = gate(); const delivered = gate(); let posts = 0;
    await page.route(`**${endpoint}/versions/${version.id}/branch`, async route => {
      posts++; const response = await route.fetch(); expect(response.status()).toBe(200); written.release();
      await responseGate.promise;
      try { await route.fulfill({ response }); } catch { /* 离页可取消本地接收，服务端事务已提交。 */ }
      finally { delivered.release(); }
    });
    try {
      await page.goto(`/resumes/${id}/versions?version=${version.id}`);
      await page.locator('a[href="/"]').first().click(); await expect(page).toHaveURL(/\/$/); await page.goBack();
      await page.getByRole("button", { name: "从此版本开始分支", exact: true }).click();
      await page.getByRole("dialog").getByRole("button", { name: "替换草稿并开始编辑", exact: true }).click(); await written.promise;
      await page.goForward(); await expect(page).toHaveURL(/\/$/); responseGate.release(); await delivered.promise;
      // 迟到回调若仍调用 router.push，会把首页拉回旧简历。
      await page.waitForTimeout(300); await expect(page).toHaveURL(/\/$/); expect(posts).toBe(1);
      const after = await (await request.get(endpoint)).json(); expect(after.resume.title).toBe(version.snapshot.title);
      expect((await (await request.get(`${endpoint}/versions`)).json()).base_version_id).toBe(version.id);
    } finally { responseGate.release(); await page.goto("/resumes"); expect((await request.delete(endpoint)).status()).toBe(200); }
  });
}
