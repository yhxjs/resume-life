import { expect, test, type Page } from "@playwright/test";
import { gate, mockApi, syntheticResume } from "./synthetic-api";

const options = [{ ...syntheticResume().resume, versions: [{ id: 90001, version: 1, name: "测试发布版本" }] }];
const draft = "参与联调 <T> &amp;\n尚未上线，不是独立负责。";

async function setup(page: Page, initial: unknown, hold = false) {
  await mockApi(page);
  const writes: string[] = [];
  await page.route("**/api/**", async (route) => {
    if (!["GET", "HEAD"].includes(route.request().method())) {
      writes.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    }
    await route.fallback();
  });
  const waiting = gate();
  const state = { response: initial, hold, reads: 0, writes, release: () => { state.hold = false; waiting.release(); } };
  await page.route("**/api/resumes", async (route) => {
    state.reads += 1;
    const response = state.response;
    if (state.hold) await waiting.promise;
    await route.fulfill({ json: response });
  });
  return state;
}

for (const width of [390, 1280]) {
  test(`简历候选 ${width}px 排雷：等待和失败不误报空，重读保留岗位草稿`, async ({ page }, testInfo) => {
    const state = await setup(page, { error: "错误外壳不能作为候选" }, true);
    await page.setViewportSize({ width, height: 900 });
    try {
      await page.goto("/tools/defense");
      await expect(page.getByRole("status", { name: "读取已保存简历…" })).toBeVisible();
      await expect(page.getByText(/暂无已保存的简历/)).toHaveCount(0);
      state.release();
      const error = page.getByRole("alert").filter({ hasText: "简历列表加载失败" });
      await expect(error).toContainText("简历列表响应不完整或存在重复记录");
      await expect(page.getByRole("status", { name: "读取已保存简历…" })).toHaveCount(0);
      await expect(page.getByText(/暂无已保存的简历/)).toHaveCount(0);
      const role = page.getByLabel("目标应聘岗位 / 级别定位（选填）：", { exact: true });
      const roleDraft = "前端 <T> &amp; · 岗位草稿";
      await role.fill(roleDraft);
      await error.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`defense-options-error-${width}.png`) });
      state.response = options;
      await error.getByRole("button", { name: "点击重试" }).click();
      await expect(page.getByRole("combobox", { name: "选择要体检排雷的简历" })).toHaveValue("9001");
      await expect(page.getByRole("combobox", { name: "已发布版本", exact: true })).toHaveValue("90001");
      await expect(error).toHaveCount(0);
      await expect(role).toHaveValue(roleDraft);
      expect(state.reads).toBe(2);
      expect(state.writes).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { state.release(); }
  });

  test(`简历候选 ${width}px 诊断：坏版本可重读，岗位和 JD 保留且零写入`, async ({ page }, testInfo) => {
    const state = await setup(page, [{ ...options[0], versions: null }]);
    await page.route("**/api/resumes/9001/diagnose*", (route) => route.fulfill({ json: { current: null, previous: null, history: [] } }));
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/resumes/9001");
    if (width < 768) await page.getByRole("button", { name: "👁️ 简历预览", exact: true }).click();
    await page.getByRole("button", { name: "JD 诊断", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "对 JD 体检诊断简历" });
    const error = dialog.getByRole("alert").filter({ hasText: "简历列表加载失败" });
    await expect(error).toBeVisible();
    await expect(dialog.getByText("正在读取已发布版本…", { exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "开始诊断", exact: true })).toBeDisabled();
    await dialog.getByLabel("岗位名称", { exact: false }).fill("保留的岗位草稿 <T>");
    await dialog.getByRole("textbox", { name: "岗位要求（JD）", exact: true }).fill(draft);
    await error.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`diagnose-options-error-${width}.png`) });
    state.response = options;
    await error.getByRole("button", { name: "点击重试" }).click();
    await expect(dialog.getByRole("combobox", { name: "已发布版本", exact: true })).toHaveValue("90001");
    await expect(error).toHaveCount(0);
    await expect(dialog.getByLabel("岗位名称", { exact: false })).toHaveValue("保留的岗位草稿 <T>");
    await expect(dialog.getByRole("textbox", { name: "岗位要求（JD）", exact: true })).toHaveValue(draft);
    await expect(dialog.getByRole("button", { name: "开始诊断", exact: true })).toBeEnabled();
    expect(state.writes).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  test(`简历候选 ${width}px 投递：重复记录整份拒绝，重试保留公司与 JD`, async ({ page }) => {
    const state = await setup(page, [options[0], options[0]]);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/applications");
    await page.getByRole("button", { name: "登记新投递", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "新建求职投递" });
    await dialog.getByLabel("公司名称", { exact: false }).fill("保留的公司草稿");
    await dialog.getByLabel("目标岗位", { exact: false }).fill("前端 <T>");
    await dialog.getByLabel("岗位 JD / 职位要求", { exact: true }).fill(draft);
    const error = dialog.getByRole("alert").filter({ hasText: "简历候选加载失败" });
    await expect(error).toContainText("存在重复记录");
    await expect(dialog.getByLabel("关联简历").getByRole("option")).toHaveCount(1);
    state.response = options;
    await error.getByRole("button", { name: "点击重试" }).click();
    await expect(dialog.getByLabel("关联简历").getByRole("option")).toHaveCount(2);
    await dialog.getByLabel("关联简历").selectOption("9001");
    await expect(dialog.getByRole("combobox", { name: "已发布版本", exact: true })).toHaveValue("90001");
    await expect(dialog.getByLabel("公司名称", { exact: false })).toHaveValue("保留的公司草稿");
    await expect(dialog.getByLabel("目标岗位", { exact: false })).toHaveValue("前端 <T>");
    await expect(dialog.getByLabel("岗位 JD / 职位要求", { exact: true })).toHaveValue(draft);
    await expect(error).toHaveCount(0);
    expect(state.reads).toBe(2);
    expect(state.writes).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });

  for (const entry of ["interviews", "intros"]) {
    test(`简历候选 ${width}px ${entry}：异常版本不进入生成表单，可只读重试`, async ({ page }) => {
      const state = await setup(page, [{ ...options[0], versions: [options[0]!.versions[0], options[0]!.versions[0]] }]);
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/${entry}`);
      const error = page.getByRole("alert").filter({ hasText: "简历列表加载失败" });
      await expect(error).toContainText("存在重复记录");
      await expect(page.getByRole("combobox", { name: "已发布版本", exact: true })).toHaveCount(0);
      state.response = options;
      await error.getByRole("button", { name: "重试加载", exact: true }).click();
      await expect(page.getByRole("combobox", { name: "已发布版本", exact: true })).toHaveValue("90001");
      await expect(error).toHaveCount(0);
      expect(state.reads).toBe(2);
      expect(state.writes).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }
}
