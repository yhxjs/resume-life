import { expect, test } from "@playwright/test";
import { mockApi } from "./synthetic-api";

test("损坏排版可显式修复，保存成功后移除完整性警告", async ({ page }) => {
  const api = await mockApi(page);
  const data = Object.assign(api.resume(), { warnings: ["排版数据损坏：当前仅显示默认样式预览"] });
  const resume = Object.assign(data.resume, { styleCorrupted: true });
  api.beforePatch = async (body) => {
    if (Object.hasOwn(body, "styleOverrides")) {
      resume.styleCorrupted = false;
      data.warnings = [];
    }
  };
  await page.goto("/resumes/9001");
  await expect(page.getByText(/排版数据损坏/)).toBeVisible();
  await page.getByRole("button", { name: "使用模板默认排版修复" }).click();
  await expect.poll(() => api.writes.some((body) => Object.hasOwn(body, "styleOverrides") && body.styleOverrides === null)).toBe(true);
  await expect(page.getByText(/排版数据损坏/)).toBeHidden();
  await expect(page.getByRole("button", { name: "使用模板默认排版修复" })).toBeHidden();
});

test("润色弹窗首焦点在富文本中，键入、焦点围栏与关闭归还均可用", async ({ page }) => {
  await mockApi(page);
  await page.goto("/resumes/9001");
  await page.getByRole("tab", { name: "个人简介", exact: true }).click();
  const trigger = page.getByRole("button", { name: "✨ AI 润色", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "自我评价智能润色" });
  const editor = dialog.getByRole("textbox", { name: "待润色自我评价第 1 行" });
  await expect(editor).toBeFocused();
  await page.keyboard.type("keyboard-edit");
  await expect(editor).toContainText("keyboard-edit");
  const close = dialog.getByRole("button", { name: "关闭弹窗" });
  const cancel = dialog.getByRole("button", { name: "取消", exact: true });
  await cancel.focus();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(cancel).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});
