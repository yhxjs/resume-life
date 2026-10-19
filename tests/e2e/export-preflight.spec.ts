import { expect, test, type Page } from "@playwright/test";
import { mockApi } from "./synthetic-api";

async function seed(page: Page, description: string) {
  const api = await mockApi(page);
  api.resume().modules.push({ key: "mod_work", type: "work", label: "相关经历", sort: 2, content: [
    { id: "w1", company: "第一家公司", title: "工程师", description: "完成重构" },
    { id: "w2", company: "第二家公司", title: "工程师", description },
  ] });
  return api;
}

async function openMarkdown(page: Page) {
  await page.getByRole("button", { name: "导出 / 打印" }).click();
  await page.getByRole("button", { name: /导出 Markdown \(\.md\)/ }).click();
  return page.getByRole("dialog", { name: "导出前检查" });
}

test("残留占位符阻止导出，定位到自定义模块的第二条经历", async ({ page }) => {
  await seed(page, "优化 [请填入真实数据，例如：40%]");
  await page.goto("/resumes/9001");
  const check = await openMarkdown(page);
  await expect(check.getByRole("button", { name: "继续导出" })).toBeDisabled();
  await expect(check).toContainText("第二家公司");
  await check.getByRole("region", { name: "残留占位符" }).getByRole("button", { name: "定位条目" }).click();
  const target = page.locator('[data-edit-card-index="1"]');
  await expect(target).toContainText("工作");
  await expect(target.locator("input").first()).toHaveValue("第二家公司");
  await expect(target.locator("input").first()).toBeFocused();
});

test("数字逐条确认后导出，下一次导出重新确认", async ({ page }) => {
  await seed(page, "效率提升 40%");
  const requests: { confirmedIssueIds: string[] }[] = [];
  await page.route("**/api/resumes/9001/export", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ contentType: "text/markdown", body: "# 已核实的简历" });
  });
  await page.goto("/resumes/9001");
  const check = await openMarkdown(page);
  await expect(check.getByRole("button", { name: "继续导出" })).toBeDisabled();
  expect(requests).toHaveLength(0);
  await check.getByRole("checkbox").check();
  await check.getByRole("button", { name: "继续导出" }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]!.confirmedIssueIds).toHaveLength(1);
  await expect(check).not.toBeVisible();
  const again = await openMarkdown(page);
  await expect(again.getByRole("checkbox")).not.toBeChecked();
  await expect(again.getByRole("button", { name: "继续导出" })).toBeDisabled();
});

test("顶部跳过按钮不勾选数字，直接导出有未确认数字和占位符的简历", async ({ page }) => {
  await seed(page, "效率提升 40%，[待补充]");
  const requests: { confirmedIssueIds: string[]; skipExportCheck?: boolean }[] = [];
  await page.route("**/api/resumes/9001/export", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ contentType: "text/markdown", body: "# 已确认的简历" });
  });
  await page.goto("/resumes/9001");
  const check = await openMarkdown(page);
  await expect(check.getByRole("button", { name: "继续导出" })).toBeDisabled();
  await expect(check.getByRole("button", { name: "我已确认，无需核对" })).toBeEnabled();
  await check.getByRole("button", { name: "我已确认，无需核对" }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toMatchObject({ confirmedIssueIds: [], skipExportCheck: true });
  await expect(check).not.toBeVisible();
});

test("浏览器打印选择跳过核对后可打印，打印结束后重新阻断", async ({ page }) => {
  await page.addInitScript(() => { window.print = () => undefined; });
  await seed(page, "效率提升 40%，[待补充]");
  await page.goto("/resumes/9001/print");
  await page.getByRole("button", { name: "浏览器打印", exact: true }).click();
  const check = page.getByRole("dialog", { name: "导出前检查" });
  await check.getByRole("button", { name: "我已确认，无需核对" }).click();
  await expect(check).not.toBeVisible();
  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".paper")).toBeVisible();
  await expect(page.locator(".export-print-blocked")).toBeHidden();
  await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
  await expect(page.locator(".paper")).toBeHidden();
  await expect(page.locator(".export-print-blocked")).toBeVisible();
});

test("直接 PDF 与脱敏 PDF、DOCX 的跳过按钮传递本次确认", async ({ page }) => {
  await seed(page, "[待确认示例：40%]");
  const requests: { format: string; payload: { confirmedIssueIds: string[]; skipExportCheck?: boolean; anonymizeConfig?: unknown } }[] = [];
  await page.route(/\/api\/resumes\/9001\/export\/(pdf|docx)$/, async (route) => {
    const format = route.request().url().split("/").at(-1)!;
    requests.push({ format, payload: route.request().postDataJSON() });
    await route.fulfill({ contentType: format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document", body: "导出文件" });
  });
  await page.goto("/resumes/9001/print");

  await page.getByRole("button", { name: /直接下载 PDF/ }).click();
  await page.getByRole("dialog", { name: "导出前检查" }).getByRole("button", { name: "我已确认，无需核对" }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toMatchObject({ format: "pdf", payload: { confirmedIssueIds: [], skipExportCheck: true } });

  for (const [index, format] of ["PDF", "DOCX"].entries()) {
    await page.getByRole("button", { name: /隐私脱敏导出/ }).click();
    await page.getByRole("button", { name: new RegExp("导出脱敏 " + format) }).click();
    await page.getByRole("dialog", { name: "导出前检查" }).getByRole("button", { name: "我已确认，无需核对" }).click();
    await expect.poll(() => requests.length).toBe(index + 2);
    expect(requests[index + 1]).toMatchObject({
      format: format.toLowerCase(), payload: { confirmedIssueIds: [], skipExportCheck: true, anonymizeConfig: expect.any(Object) },
    });
  }
});

test("未确认数字可全部勾选，仍能逐条撤销", async ({ page }) => {
  await seed(page, "效率提升 40%，成本降低 20%");
  const requests: { confirmedIssueIds: string[] }[] = [];
  await page.route("**/api/resumes/9001/export", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ contentType: "text/markdown", body: "# 已核实的简历" });
  });
  await page.goto("/resumes/9001");
  const check = await openMarkdown(page);
  const metrics = check.getByRole("region", { name: "未确认数字" });
  const boxes = metrics.getByRole("checkbox");
  await expect(boxes).toHaveCount(2);
  await metrics.getByRole("button", { name: "全部勾选" }).click();
  await expect(boxes.first()).toBeChecked();
  await expect(boxes.last()).toBeChecked();
  await expect(check.getByRole("button", { name: "继续导出" })).toBeEnabled();
  await boxes.first().uncheck();
  await expect(boxes.first()).not.toBeChecked();
  await expect(boxes.last()).toBeChecked();
  await expect(check.getByRole("button", { name: "继续导出" })).toBeDisabled();
  await metrics.getByRole("button", { name: "全部勾选" }).click();
  await check.getByRole("button", { name: "继续导出" }).click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]!.confirmedIssueIds).toHaveLength(2);
});

test("全部勾选数字后残留占位符仍阻止导出", async ({ page }) => {
  await seed(page, "效率提升 40%，成本降低 20%；[待补充]");
  await page.goto("/resumes/9001");
  const check = await openMarkdown(page);
  const metrics = check.getByRole("region", { name: "未确认数字" });
  await expect(metrics.getByRole("checkbox")).toHaveCount(2);
  await metrics.getByRole("button", { name: "全部勾选" }).click();
  await expect(check.getByRole("region", { name: "残留占位符" })).toContainText("[待补充]");
  await expect(check.getByRole("button", { name: "继续导出" })).toBeDisabled();
});

test("数字核查展示前后小句，并明显高亮当前数字", async ({ page }) => {
  await seed(page, "参与需求拆解、接口设计、测试上线与故障排查，保障系统可用率 99.9%+，推动线上故障次数下降 80%。持续跟踪稳定性。");
  await page.goto("/resumes/9001");
  const check = await openMarkdown(page);
  const metrics = check.getByRole("region", { name: "未确认数字" });
  const rows = metrics.locator("li");

  await expect(rows).toHaveCount(2);
  await expect(rows.first().locator("mark")).toHaveText("99.9%+");
  await expect(rows.last().locator("mark")).toHaveText("80%");
  await expect(rows.first().locator("mark")).toHaveClass(/(?:^|\s)bg-primary(?:\s|$)/);
  await expect(rows.first()).toContainText("测试上线与故障排查");
  await expect(rows.first()).toContainText("推动线上故障次数下降 80%");
  await expect(rows.last()).toContainText("保障系统可用率 99.9%+");
  await expect(rows.last()).toContainText("持续跟踪稳定性");
  await expect(rows.first()).not.toContainText("参与需求拆解");
  await expect(rows.last()).not.toContainText("接口设计");
});

test("打印页的 PDF 和浏览器打印都检查数字，原生打印不能带出未确认成果", async ({ page }) => {
  await seed(page, "效率提升 40%");
  await page.goto("/resumes/9001/print");
  await page.getByRole("button", { name: "浏览器打印", exact: true }).waitFor();
  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".paper")).not.toBeVisible();
  await expect(page.locator(".export-print-blocked")).toBeVisible();
  await page.emulateMedia({ media: "screen" });
  await page.getByRole("button", { name: /直接下载 PDF/ }).click();
  let check = page.getByRole("dialog", { name: "导出前检查" });
  await expect(check.getByRole("button", { name: "继续导出" })).toBeDisabled();
  await check.getByRole("button", { name: "返回修改" }).click();
  await page.getByRole("button", { name: "浏览器打印", exact: true }).click();
  check = page.getByRole("dialog", { name: "导出前检查" });
  await check.getByRole("region", { name: "未确认数字" }).getByRole("button", { name: "定位条目" }).click();
  await expect(page).toHaveURL(/\/resumes\/9001(?:#.*)?$/);
  await expect(page.locator('[data-edit-card-index="1"] input').first()).toHaveValue("第二家公司");
  await expect(page.locator('[data-edit-card-index="1"] input').first()).toBeFocused();
});

test("脱敏 PDF、Markdown 和 DOCX 都不能跳过示例标记检查", async ({ page }) => {
  await seed(page, "[待确认示例：40%]");
  await page.goto("/resumes/9001/print");
  await page.getByRole("button", { name: /隐私脱敏导出/ }).click();
  for (const format of ["Markdown", "PDF", "DOCX"]) {
    await page.getByRole("button", { name: new RegExp("导出脱敏 " + format) }).click();
    const check = page.getByRole("dialog", { name: "导出前检查" });
    await expect(check).toContainText("[待确认示例：40%]");
    await expect(check.getByRole("button", { name: "继续导出" })).toBeDisabled();
    await check.getByRole("button", { name: "返回修改" }).click();
  }
});

test("保存失败时留在检查界面，不下载服务器旧稿", async ({ page }) => {
  const api = await seed(page, "完成重构");
  api.failSaves = true;
  let downloads = 0;
  await page.route("**/api/resumes/9001/export", async (route) => {
    downloads += 1;
    await route.fulfill({ contentType: "text/markdown", body: "旧稿" });
  });
  await page.goto("/resumes/9001");
  await page.getByLabel("姓名", { exact: true }).fill("修改姓名");
  const check = await openMarkdown(page);
  await check.getByRole("button", { name: "继续导出" }).click();
  await expect(check.getByRole("alert")).toBeVisible();
  expect(downloads).toBe(0);
});

test("分页警告定位超长条目，联系方式和分页警告允许继续", async ({ page }) => {
  await seed(page, "负责业务架构与开发。".repeat(600));
  await page.goto("/resumes/9001");
  const check = await openMarkdown(page);
  await expect(check.getByRole("region", { name: "分页问题" })).toContainText("条目超过一页");
  await expect(check.getByRole("region", { name: "联系方式" })).toContainText("请补充");
  await expect(check.getByRole("button", { name: "继续导出" })).toBeEnabled();
  await check.getByRole("region", { name: "分页问题" }).getByRole("button", { name: "定位条目" }).first().click();
  await expect(page.locator('[data-edit-card-index="1"] input').first()).toBeFocused();
});

test("移动端从检查问题回到对应编辑条目", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page, "[待补充]");
  await page.goto("/resumes/9001");
  await page.getByRole("button", { name: /简历预览/ }).click();
  const check = await openMarkdown(page);
  await check.getByRole("region", { name: "残留占位符" }).getByRole("button", { name: "定位条目" }).click();
  await expect(page.locator('[data-edit-card-index="1"] input').first()).toBeFocused();
});

test("联系方式问题直接定位邮箱字段", async ({ page }) => {
  await seed(page, "完成重构");
  await page.goto("/resumes/9001");
  const check = await openMarkdown(page);
  await check.getByRole("region", { name: "联系方式" }).locator("li").filter({ hasText: "请补充邮箱" }).getByRole("button", { name: "定位条目" }).click();
  await expect(page.getByLabel("邮箱", { exact: true })).toBeFocused();
});

test("示例数字通过格式美化写入后仍被导出检查阻断", async ({ page }) => {
  const api = await seed(page, "提升 [请填入真实数据，例如：40%]");
  await page.goto("/resumes/9001");
  let check = await openMarkdown(page);
  await check.getByRole("region", { name: "残留占位符" }).getByRole("button", { name: "定位条目" }).click();
  await page.getByRole("button", { name: /格式美化/ }).click();
  const format = page.getByRole("dialog", { name: "格式美化" });
  await format.getByRole("checkbox", { name: "自动填入示例值" }).check();
  await format.getByRole("button", { name: /应用到选中的/ }).click();
  await expect.poll(() => JSON.stringify(api.resume().modules)).toContain("待确认示例");
  check = await openMarkdown(page);
  await expect(check.getByRole("region", { name: "残留占位符" })).toContainText("待确认示例");
  await expect(check.getByRole("button", { name: "继续导出" })).toBeDisabled();
});

test("检查弹窗在视口缩窄后仍可操作", async ({ page }) => {
  await seed(page, "[待补充]");
  await page.goto("/resumes/9001");
  const check = await openMarkdown(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(check).toBeVisible();
  await check.getByRole("button", { name: "返回修改" }).click();
  await expect(check).not.toBeVisible();
});

test("分页检查使用脱敏替换后的实际排版", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("resume_life_anonymize_config", JSON.stringify({
    customRules: [{ id: "long", source: "完成重构", replacement: "负责跨部门协作与业务开发。".repeat(400) }],
  })));
  await seed(page, "完成重构");
  await page.goto("/resumes/9001/print");
  await page.getByRole("button", { name: /隐私脱敏导出/ }).click();
  await page.getByRole("button", { name: /导出脱敏 PDF/ }).click();
  await expect(page.getByRole("dialog", { name: "导出前检查" }).getByRole("region", { name: "分页问题" })).toContainText("条目超过一页");
});
