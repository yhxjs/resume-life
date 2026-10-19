import { expect, test } from "@playwright/test";
import { BUILTIN_STYLES } from "../../src/lib/templates";
import { gate } from "./synthetic-api";

test("样式工厂拆分后仍可载入、保存、更新和删除模板", async ({ page }) => {
  await page.goto("/styles");
  await expect(page.getByRole("heading", { name: "简历样式工厂" })).toBeVisible();

  await page.getByRole("button", { name: "双栏专业" }).click();
  await expect(page.getByRole("radio", { name: "双栏" })).toHaveAttribute("aria-checked", "true");

  const name = page.getByRole("textbox", { name: "模板名称" });
  await name.fill("审计回归模板");
  await page.getByRole("button", { name: "另存为新模板" }).click();
  await expect(page.getByRole("button", { name: /审计回归模板.*编辑中/ })).toBeVisible();

  await name.fill("审计回归模板已更新");
  await page.getByRole("button", { name: "保存修改" }).click();
  await expect(page.getByRole("button", { name: /审计回归模板已更新.*编辑中/ })).toBeVisible();

  await page.getByRole("button", { name: "删除" }).click();
  const dialog = page.getByRole("dialog", { name: "删除模板" });
  await expect(dialog).toContainText("审计回归模板已更新");
  await dialog.getByRole("button", { name: "删除" }).click();
  await expect(page.getByRole("button", { name: /审计回归模板已更新/ })).toHaveCount(0);
});

test("AI 样式生成失败后解除忙碌状态并保留可重试入口", async ({ page }) => {
  await page.route("**/api/styles/generate", (route) => route.fulfill({
    status: 502,
    contentType: "application/json",
    body: JSON.stringify({ error: "合成上游失败" }),
  }));
  await page.goto("/styles");
  await page.getByPlaceholder(/稳重的金融行业风格/).fill("生成一套合成测试样式");
  const generate = page.getByRole("button", { name: "AI 生成" });
  await generate.click();
  const dialog = page.getByRole("dialog", { name: "AI 生成失败" });
  await expect(dialog).toContainText("合成上游失败");
  await dialog.getByRole("button", { name: "确定" }).click();
  await expect(generate).toBeEnabled();
});

test("AI 请求期间切换模板后，旧回包不会覆盖新选择", async ({ page }) => {
  const hold = gate();
  await page.route("**/api/styles/generate", async (route) => {
    await hold.promise;
    await route.fulfill({ json: { style: { ...BUILTIN_STYLES.modern, layout: "twocol" } } });
  });
  try {
    await page.goto("/styles");
    await page.getByPlaceholder(/稳重的金融行业风格/).fill("合成样式请求");
    await page.getByRole("button", { name: "AI 生成" }).click();
    await expect(page.getByRole("button", { name: "另存为新模板" })).toBeDisabled();
    await page.getByRole("button", { name: "经典单栏", exact: true }).click();
    hold.release();
    await expect(page.getByRole("button", { name: "AI 生成" })).toBeEnabled();
    await expect(page.getByRole("textbox", { name: "模板名称" })).toHaveValue("经典单栏");
    await expect(page.getByRole("radio", { name: "单栏", exact: true })).toHaveAttribute("aria-checked", "true");
  } finally {
    hold.release();
  }
});

test("另存模板期间锁定保存，回包后不把新选择绑定到旧模板", async ({ page, request }) => {
  const hold = gate();
  const templateName = "审计异步回归模板";
  let submitted = false;
  await page.route("**/api/templates", async (route) => {
    if (route.request().method() === "POST") {
      submitted = true;
      await hold.promise;
    }
    await route.continue();
  });
  try {
    await page.goto("/styles");
    await page.getByRole("textbox", { name: "模板名称" }).fill(templateName);
    const save = page.getByRole("button", { name: "另存为新模板" });
    await save.click();
    await expect.poll(() => submitted).toBe(true);
    await expect(save).toBeDisabled();
    await expect(page.getByRole("status")).toContainText("正在保存模板");
    await page.getByRole("button", { name: "经典单栏", exact: true }).click();
    hold.release();
    await expect(save).toBeEnabled();
    await expect(page.getByRole("button", { name: templateName, exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "模板名称" })).toHaveValue("经典单栏");
    await expect(page.getByRole("button", { name: "保存修改", exact: true })).toHaveCount(0);
  } finally {
    hold.release();
    const response = await request.get("/api/templates");
    const { items } = await response.json() as { items: Array<{ id: number; name: string }> };
    for (const item of items.filter((item) => item.name === templateName)) {
      await request.delete(`/api/templates/${item.id}`);
    }
  }
});
