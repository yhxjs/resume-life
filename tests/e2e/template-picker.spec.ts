import { expect, test } from "@playwright/test";
import { mockApi } from "./synthetic-api";

/**
 * 模板选择器拆成 template-picker / template-picker-dialog / template-thumbnail
 * 三个文件后，这条用例守住「拆完还是一个能用的选择器」：
 * 打开弹窗、缩略图卡片渲染、搜索与分类过滤、空状态、选中回写触发按钮。
 *
 * 拆分本身是纯搬移，所以断言只覆盖拆分前就有的行为，不引入新合同。
 */
test("模板选择弹窗可打开、过滤并回写选中模板", async ({ page }) => {
  await mockApi(page);
  await page.goto("/resumes/9001");

  const trigger = page.getByRole("button", { name: /^模板 / });
  await expect(trigger).toContainText("经典单栏");
  await trigger.click();

  const dialog = page.getByRole("dialog", { name: "选择简历模板" });
  await expect(dialog).toBeVisible();

  const classicCard = dialog.getByRole("button").filter({ hasText: "经典单栏" }).first();
  await expect(classicCard).toBeVisible();
  // 缩略图骨架随卡片一起渲染（拆分后仍由 TemplateThumbnail 提供）
  await expect(classicCard.locator("div.aspect-\\[1\\/1\\.25\\]")).toBeVisible();

  // 关键词过滤
  const search = dialog.getByPlaceholder(/搜索模板名称/);
  await search.fill("学术");
  await expect(classicCard).toHaveCount(0);
  await search.fill("zzz-绝不匹配-zzz");
  await expect(dialog.getByText("未找到匹配的模板")).toBeVisible();

  // 分类过滤：经典单栏属于「通用经典」，不该出现在「技术研发」下
  await dialog.getByRole("button", { name: "清空" }).click();
  await dialog.getByRole("button", { name: /技术研发/ }).click();
  await expect(classicCard).toHaveCount(0);

  // 选中另一个模板：底栏摘要与触发按钮都要跟着变
  await dialog.getByRole("button", { name: /全部模板/ }).click();
  await dialog.getByRole("button").filter({ hasText: "极客工程师" }).first().click();
  await expect(dialog.getByText("当前应用模板：").locator("..")).toContainText("极客工程师");

  await dialog.getByRole("button", { name: "完成" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toContainText("极客工程师");
});

test("Escape 与关闭按钮都能关掉模板弹窗", async ({ page }) => {
  await mockApi(page);
  await page.goto("/resumes/9001");

  const trigger = page.getByRole("button", { name: /^模板 / });
  const dialog = page.getByRole("dialog", { name: "选择简历模板" });

  await trigger.click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await trigger.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "关闭" }).click();
  await expect(dialog).toHaveCount(0);
});
