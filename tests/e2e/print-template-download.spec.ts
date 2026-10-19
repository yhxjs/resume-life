import { expect, test } from "@playwright/test";
import { gate, mockApi } from "./synthetic-api";

async function chooseModern(page: import("@playwright/test").Page) {
  const trigger = page.getByRole("button", { name: /模板/ });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "选择简历模板" });
  await dialog.getByRole("button").filter({ hasText: "现代简约" }).first().click();
  await dialog.getByRole("button", { name: "完成" }).click();
  return trigger;
}

test("真实打印页模板切换携带加载世代并持久保存", async ({ page, request }) => {
  const created = await request.post("/api/resumes", { data: { title: "E2E 打印模板世代" } });
  expect(created.status()).toBe(201);
  const { id } = await created.json();
  try {
    const loaded = await (await request.get(`/api/resumes/${id}`)).json();
    await page.goto(`/resumes/${id}/print`);
    const saving = page.waitForResponse((response) =>
      response.url().endsWith(`/api/resumes/${id}`) && response.request().method() === "PATCH");
    await chooseModern(page);
    const saved = await saving;
    expect(saved.request().postDataJSON()).toEqual({ template: "modern", dataGeneration: loaded.resume.dataGeneration });
    expect(saved.status()).toBe(200);
    expect((await (await request.get(`/api/resumes/${id}`)).json()).resume.template).toBe("modern");
  } finally {
    expect((await request.delete(`/api/resumes/${id}`)).ok()).toBe(true);
  }
});

test("模板保存完成后才请求 PDF，并使用已保存的模板", async ({ page }) => {
  const controls = await mockApi(page);
  const pending = gate();
  let exports = 0;
  let exportedTemplate = "";
  controls.beforePatch = async (body) => {
    if (body.template) await pending.promise;
  };
  await page.route("**/api/resumes/9001/export/pdf", async (route) => {
    exports += 1;
    exportedTemplate = controls.resume().resume.template;
    await route.fulfill({ contentType: "application/pdf", body: "%PDF-1.4\n" });
  });

  try {
    await page.goto("/resumes/9001/print");
    await chooseModern(page);
    await expect.poll(() => controls.writes.length).toBe(1);
    await page.getByRole("button", { name: /直接下载 PDF/ }).click();
    await page.getByRole("dialog", { name: "导出前检查" }).getByRole("button", { name: "继续导出" }).click();
    await expect(page.getByRole("button", { name: /正在生成 PDF/ })).toBeVisible();
    expect(exports).toBe(0);
    pending.release();
    await expect.poll(() => exports).toBe(1);
    expect(exportedTemplate).toBe("modern");
  } finally {
    pending.release();
  }
});

test("模板保存失败时恢复预览、提示错误且不导出错版 PDF", async ({ page }) => {
  const controls = await mockApi(page);
  const pending = gate();
  controls.failSaves = true;
  controls.beforePatch = async (body) => {
    if (body.template) await pending.promise;
  };
  let exports = 0;
  await page.route("**/api/resumes/9001/export/pdf", async (route) => {
    exports += 1;
    await route.fulfill({ contentType: "application/pdf", body: "%PDF-1.4\n" });
  });

  try {
    await page.goto("/resumes/9001/print");
    const trigger = await chooseModern(page);
    await expect.poll(() => controls.writes.length).toBe(1);
    await page.getByRole("button", { name: /直接下载 PDF/ }).click();
    await page.getByRole("dialog", { name: "导出前检查" }).getByRole("button", { name: "继续导出" }).click();
    pending.release();
    await expect(page.getByRole("dialog", { name: "导出前检查" }).getByRole("alert").filter({ hasText: "合成保存失败" })).toBeVisible();
    await expect(trigger).toContainText("经典单栏");
    expect(exports).toBe(0);
  } finally {
    pending.release();
  }
});
