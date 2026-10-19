import { expect, test } from "@playwright/test";
import { BUILTIN_STYLES } from "../../src/lib/templates";
import { mockApi } from "./synthetic-api";

test("两个真实标签页排版冲突时保留本页设置，数据库保留已保存字号", async ({ page, context, request }) => {
  const created = await request.post("/api/resumes", { data: { title: "排版并发回归" } });
  expect(created.status()).toBe(201);
  const { id } = await created.json();
  const other = await context.newPage();
  try {
    for (const tab of [page, other]) {
      await tab.goto(`/resumes/${id}`);
      await tab.getByRole("button", { name: /排版微调/ }).click();
      await expect(tab.getByRole("slider", { name: "正文字号", exact: true })).toBeVisible();
    }
    const saved = page.waitForResponse((response) => response.url().endsWith(`/api/resumes/${id}`) && response.request().method() === "PATCH");
    await page.getByRole("slider", { name: "正文字号", exact: true }).fill("14");
    expect((await saved).status()).toBe(200);
    const conflict = other.waitForResponse((response) => response.url().endsWith(`/api/resumes/${id}`) && response.request().method() === "PATCH");
    const margin = other.getByRole("slider", { name: "页面边距 (上下左右)", exact: true });
    await margin.fill("20");
    expect((await conflict).status()).toBe(409);
    await expect(other.getByRole("dialog", { name: "排版微调保存失败" })).toBeVisible();
    await expect(margin).toHaveValue("20");
    const data = await (await request.get(`/api/resumes/${id}`)).json();
    expect(data.resume.style_overrides).toEqual({ baseSize: 14 });
  } finally {
    await other.close();
    expect((await request.delete(`/api/resumes/${id}`)).ok()).toBe(true);
  }
});

test("损坏模块不可跳过检查打印，修复后打印恢复", async ({ page }) => {
  await page.addInitScript(() => { window.print = () => { document.documentElement.dataset.auditPrinted = "yes"; }; });
  const api = await mockApi(page);
  Object.assign(api.resume(), { corruptedKeys: ["work"], warnings: ["工作经历无法解析"] });
  await page.goto("/resumes/9001/print");
  await expect(page.getByRole("alert").filter({ hasText: "部分模块数据损坏" })).toBeVisible();
  await page.getByRole("button", { name: "浏览器打印", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "导出前检查" })).toHaveCount(0);
  expect(await page.locator("html").getAttribute("data-audit-printed")).toBeNull();
  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".paper")).toBeHidden();
  await expect(page.locator(".export-print-blocked")).toBeVisible();
  Object.assign(api.resume(), { corruptedKeys: [], warnings: [] });
  await page.emulateMedia({ media: "screen" });
  await page.reload();
  await page.getByRole("button", { name: "浏览器打印", exact: true }).click();
  await page.getByRole("dialog", { name: "导出前检查" }).getByRole("button", { name: "我已确认，无需核对" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-audit-printed", "yes");
  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".paper")).toBeVisible();
});

test("坏模板确认修复前不写库，保存后解除损坏状态", async ({ page }) => {
  await mockApi(page);
  let corrupted = true;
  let saves = 0;
  const template = () => ({ id: 1, name: "历史坏模板", style: BUILTIN_STYLES.classic,
    ...(corrupted ? { corrupted: true } : {}), created_at: "", updated_at: "" });
  await page.route("**/api/templates", (route) => route.fulfill({ json: { items: [template()] } }));
  await page.route("**/api/templates/1", async (route) => {
    expect(route.request().method()).toBe("PATCH");
    expect(route.request().postDataJSON().style).toEqual(BUILTIN_STYLES.classic);
    saves++;
    corrupted = false;
    await route.fulfill({ json: template() });
  });
  await page.goto("/styles");
  await page.getByRole("button", { name: /历史坏模板.*已损坏/ }).click();
  const confirm = page.getByRole("dialog", { name: "修复损坏模板" });
  await expect(confirm).toBeVisible();
  expect(saves).toBe(0);
  await confirm.getByRole("button", { name: "确定", exact: true }).click();
  await expect(page.getByText(/正在修复损坏模板/)).toBeVisible();
  expect(saves).toBe(0);
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect.poll(() => saves).toBe(1);
  await expect(page.getByRole("button", { name: /历史坏模板.*已损坏/ })).toHaveCount(0);
});
