import { expect, test } from "@playwright/test";
import { mockApi } from "./synthetic-api";

for (const leaveEditor of [false, true]) {
test(`failed saves warn before reload ${leaveEditor ? "after leaving the editor" : "in the editor"}`, async ({ page }) => {
  const api = await mockApi(page);
  api.failSaves = true;
  await page.goto("/resumes/9001");
  const name = page.getByLabel("姓名", { exact: true });
  await name.fill("尚未提交的姓名");
  await expect(page.getByText(/草稿仅在当前标签页中保留/)).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem("resume-life:draft:9001"))).toContain("尚未提交的姓名");
  if (leaveEditor) {
    await page.getByRole("link", { name: "工具箱", exact: true }).click();
    await expect(page).toHaveURL(/\/tools$/);
  }
  const dialog = page.waitForEvent("dialog");
  // 原生取消 reload 不产生 load 事件，不能等待 Playwright 的 reload 完成。
  await page.evaluate(() => { setTimeout(() => location.reload(), 0); });
  const warning = await dialog;
  expect(warning.type()).toBe("beforeunload");
  await warning.dismiss();
  if (leaveEditor) {
    await page.evaluate(() => history.back());
    await expect(page).toHaveURL(/\/resumes\/9001$/);
  }
  await expect(name).toHaveValue("尚未提交的姓名");
  api.failSaves = false;
  await expect.poll(() => api.resume().modules[0]!.content).toMatchObject({ name: "尚未提交的姓名" });
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem("resume-life:draft:9001"))).toBeNull();
  const prevented = await page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(false);
});
}
