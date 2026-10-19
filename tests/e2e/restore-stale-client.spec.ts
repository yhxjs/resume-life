import { expect, test } from "@playwright/test";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";

test("真实恢复后旧页面删除被拒绝，整页刷新后可操作", async ({ page, request }) => {
  const name = `E2E旧页面世代-${Date.now()}`;
  const created = await request.post("/api/projects", { data: { name } });
  expect(created.status()).toBe(201);
  const { id } = await created.json();
  await page.goto("/knowledge");
  const card = () => page.locator("div.group").filter({ has: page.getByRole("link", { name, exact: true }) });
  await expect(card().getByRole("button", { name: "删除档案" })).toBeVisible();
  const oldGeneration = await page.locator('meta[name="resume-life-data-generation"]').getAttribute("content");
  const { response, bytes } = await exportEncryptedBackup(request);
  expect(response.status()).toBe(200);
  const otherPage = await page.context().newPage();
  try {
    await otherPage.goto("/settings");
    expect((await postEncryptedBackup(otherPage.request, "/api/backup/restore", bytes, { preserveAiConfig: true })).status()).toBe(200);
    const deletion = page.waitForResponse((res) => res.url().endsWith(`/api/projects/${id}`) && res.request().method() === "DELETE");
    await card().getByRole("button", { name: "删除档案" }).click();
    await page.getByRole("dialog", { name: "删除项目" }).getByRole("button", { name: "删除", exact: true }).click();
    const rejected = await deletion;
    expect(rejected.status()).toBe(409);
    expect(rejected.request().headers()["x-resume-life-data-generation"]).toBe(oldGeneration);
    await expect(page.getByRole("dialog", { name: "删除失败" })).toContainText("数据已恢复");
    expect((await request.get(`/api/projects/${id}`)).status()).toBe(200);
    await page.reload();
    expect(await page.locator('meta[name="resume-life-data-generation"]').getAttribute("content")).not.toBe(oldGeneration);
    await card().getByRole("button", { name: "删除档案" }).click();
    const accepted = page.waitForResponse((res) => res.url().endsWith(`/api/projects/${id}`) && res.request().method() === "DELETE");
    await page.getByRole("dialog", { name: "删除项目" }).getByRole("button", { name: "删除", exact: true }).click();
    expect((await accepted).status()).toBe(200);
    await expect(card()).toHaveCount(0);
  } finally {
    await otherPage.close();
    await request.delete(`/api/projects/${id}`);
  }
});
