import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { publishResume } from "./resume-version-helpers";

async function createResume(request: APIRequestContext) {
  const created = await request.post("/api/resumes", { data: { title: "版本树回归简历", modules: {
    basic: { name: "测试求职者", email: "version@example.test" },
    work: [
      { id: "a", company: "甲公司", title: "工程师", description: "响应时间优化 20%", descriptionItems: ["响应时间优化 <strong>20%</strong>"] },
      { id: "b", company: "乙公司", title: "实习生", description: "维护组件" },
    ], summary: { text: "注重工程质量" },
  } } });
  expect(created.status()).toBe(201);
  return (await created.json()).id as number;
}

async function publish(page: Page, name: string) {
  await page.getByRole("button", { name: "发布新版本", exact: true }).click();
  await page.getByRole("textbox", { name: "版本名称" }).fill(name);
  await page.getByRole("textbox", { name: "修改说明" }).fill(`发布说明：${name}`);
  await page.getByRole("button", { name: "确认发布", exact: true }).click();
  await expect(page.getByRole("heading", { name: new RegExp(`v\\d+ · ${name}$`) })).toBeVisible();
}

test("手动发布、左右差异、历史分叉与投递固定版本", async ({ page, request }, testInfo) => {
  const id = await createResume(request);
  let applicationId: number | undefined;
  try {
    await page.goto(`/resumes/${id}`);
    await publish(page, "基础版");
    const first = (await (await request.get(`/api/resumes/${id}/versions`)).json()).versions[0];
    const application = await request.post("/api/applications", { data: { company: "版本验证公司", role: "工程师", stage: "applied", resume_id: id, resume_version_id: first.id } });
    expect(application.status()).toBe(201);
    applicationId = (await application.json()).id;

    const draft = await (await request.get(`/api/resumes/${id}`)).json();
    const work = draft.modules.find((item: { key: string }) => item.key === "work");
    const saved = await request.patch(`/api/resumes/${id}`, { data: { modules: { work: [
      { ...work.content[0], description: "响应时间优化 40%", descriptionItems: ["响应时间优化 <strong>40%</strong>"] },
      { id: "c", company: "丙公司", title: "技术顾问", description: "搭建组件体系" },
    ] }, moduleRevisions: { work: work.revision }, dataGeneration: draft.resume.dataGeneration, template: "modern", styleOverrides: { baseSize: 14 }, styleRevision: draft.resume.styleRevision } });
    expect(saved.status()).toBe(200);
    await page.goto(`/resumes/${id}`);
    await publish(page, "主线优化版");
    const second = (await (await request.get(`/api/resumes/${id}/versions`)).json()).versions[0];
    const diff = page.getByRole("region", { name: "简历左右对照" });
    const onlyChanges = page.getByRole("checkbox", { name: "仅看变化" });
    await expect(onlyChanges).not.toBeChecked();
    const papers = diff.locator(".paper");
    await expect(papers).toHaveCount(2);
    await expect(papers.nth(0)).toContainText("响应时间优化 20%");
    await expect(papers.nth(0)).toContainText("乙公司");
    await expect(papers.nth(0)).not.toContainText("丙公司");
    await expect(papers.nth(1)).toContainText("响应时间优化 40%");
    await expect(papers.nth(1)).toContainText("丙公司");
    await expect(papers.nth(1)).not.toContainText("乙公司");
    for (const paper of await papers.all()) await expect(paper).toContainText("注重工程质量");
    await expect(papers.nth(0).locator('[data-resume-module="work"] [data-resume-entry="0"]')).toHaveAttribute("data-version-change", "changed");
    await expect(papers.nth(1).locator('[data-resume-module="work"] [data-resume-entry="0"]')).toHaveAttribute("data-version-change", "changed");
    await expect(papers.nth(0).locator('[data-resume-module="work"] [data-resume-entry="0"] strong')).toContainText("20%");
    await expect(papers.nth(0).locator('[data-resume-module="work"] [data-resume-entry="0"]')).toHaveAttribute("data-version-inline", "true");
    await expect.poll(() => page.evaluate(() => Array.from(CSS.highlights.get("resume-version-before") ?? []).map((range) => range.toString()))).toContain("20");
    await expect.poll(() => page.evaluate(() => Array.from(CSS.highlights.get("resume-version-after") ?? []).map((range) => range.toString()))).toContain("40");
    const precise = await page.evaluate(() => ["resume-version-before", "resume-version-after"].flatMap((name) => Array.from(CSS.highlights.get(name) ?? []).map((range) => range.toString())));
    expect(precise.some((text) => text.includes("甲公司") || text.includes("工程师"))).toBe(false);
    await expect(papers.nth(0).locator('[data-resume-module="work"] [data-resume-entry="1"]')).toHaveAttribute("data-version-change", "removed");
    await expect(papers.nth(1).locator('[data-resume-module="work"] [data-resume-entry="1"]')).toHaveAttribute("data-version-change", "added");
    await expect(papers.nth(0).locator('[data-resume-module="work"] [data-resume-entry="1"]')).toHaveAttribute("data-version-label", "删除");
    await expect(diff.getByText("排版已修改", { exact: true })).toBeVisible();
    // 列表接口不再携带 snapshot，样式断言改从版本详情接口按需获取
    const firstDetail = await (await request.get(`/api/resumes/${id}/versions/${first.id}`)).json();
    await expect(papers.nth(0).locator(":scope > div")).toHaveCSS("font-size", `${firstDetail.snapshot.resolved_style.baseSize}px`);
    await expect(papers.nth(1).locator(":scope > div")).toHaveCSS("font-size", "14px");
    const bounds = await papers.evaluateAll((elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }));
    const left = bounds[0]!;
    const right = bounds[1]!;
    expect(left.x + left.width).toBeLessThanOrEqual(right.x);
    expect(Math.abs(left.y - right.y)).toBeLessThan(1);
    expect(Math.abs(left.width - right.width)).toBeLessThan(1);
    await page.setViewportSize({ width: 2200, height: 1200 });
    await page.getByRole("button", { name: "全屏展示", exact: true }).click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.classList.contains("version-compare-viewport"))).toBe(true);
    await expect(papers).toHaveCount(2);
    await expect.poll(() => papers.evaluateAll((elements) => Math.min(...elements.map((paper) => {
      const column = paper.parentElement!;
      return paper.getBoundingClientRect().width / column.getBoundingClientRect().width;
    })))).toBeGreaterThan(0.97);
    await expect(page.getByLabel("左侧参照版本")).toBeVisible();
    await expect(page.getByRole("button", { name: "退出全屏", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("version-preview-fullscreen.png"), fullPage: true });
    await page.keyboard.press("Escape");
    await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: testInfo.outputPath("version-preview-desktop.png"), fullPage: true });

    await onlyChanges.check();
    await expect(papers).toHaveCount(0);
    await expect(diff).not.toContainText("注重工程质量");
    await expect(diff).toContainText("甲公司");
    await expect(diff).toContainText("乙公司");
    await expect(diff).toContainText("丙公司");
    const workDiff = diff.getByRole("region", { name: "工作经历差异" });
    await expect(workDiff.locator("del")).toContainText("2");
    await expect(workDiff.locator("ins")).toContainText("4");
    for (const operation of ["+ 新增", "− 删除", "~ 修改"]) await expect(page.getByRole("status")).toContainText(operation);

    await onlyChanges.uncheck();
    await expect(papers).toHaveCount(2);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expect(diff).toBeVisible();
    expect(await diff.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("version-preview-mobile.png"), fullPage: true });
    await onlyChanges.check();
    await expect(workDiff.locator("del")).toContainText("2");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.setViewportSize({ width: 1280, height: 900 });

    await page.getByRole("button", { name: /● v1 基础版/ }).click();
    await page.getByRole("button", { name: "查看此版本", exact: true }).click();
    await expect(page.getByRole("region", { name: "已发布简历预览" })).toContainText("响应时间优化 20%");
    await page.getByRole("button", { name: "从此版本开始分支", exact: true }).click();
    await page.getByRole("button", { name: "替换草稿并开始编辑", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/resumes/${id}$`));
    await page.getByLabel("简历标题", { exact: true }).fill("分支定制简历");
    await publish(page, "历史分支版");
    const final = await (await request.get(`/api/resumes/${id}/versions`)).json();
    expect(final.versions[0]).toMatchObject({ parent_id: first.id, version: 3 });
    const finalDetail = await (await request.get(`/api/resumes/${id}/versions/${final.versions[0].id}`)).json();
    expect(finalDetail.snapshot.title).toBe("分支定制简历");
    expect(final.versions.find((version: { id: number }) => version.id === second.id)).toEqual(second);
    const bound = await (await request.get(`/api/applications/${applicationId}/versions`)).json();
    expect(bound.current.resume.modules.find((item: { key: string }) => item.key === "work").content[0].description).toBe("响应时间优化 <strong>20%</strong>");
    expect(bound.submitted.resume.modules).toEqual(bound.current.resume.modules);
  } finally {
    if (applicationId) await request.delete(`/api/applications/${applicationId}`);
    await request.delete(`/api/resumes/${id}`);
  }
});

test("完整对照保留相同版本的预览，并支持空白参照", async ({ page, request }) => {
  const id = await createResume(request);
  try {
    await publishResume(request, id, "原始版");
    await publishResume(request, id, "内容相同版");
    await page.goto(`/resumes/${id}/versions`);
    const diff = page.getByRole("region", { name: "简历左右对照" });
    const onlyChanges = page.getByRole("checkbox", { name: "仅看变化" });
    await expect(diff.locator(".paper")).toHaveCount(2);
    await expect(diff.locator("[data-version-change]")).toHaveCount(0);
    for (const paper of await diff.locator(".paper").all()) await expect(paper).toContainText("注重工程质量");
    await onlyChanges.check();
    await expect(page.getByText("这两个版本的内容与排版没有变化。", { exact: true })).toBeVisible();
    await onlyChanges.uncheck();
    await expect(diff.locator(".paper")).toHaveCount(2);
    await page.getByLabel("左侧参照版本").selectOption("");
    await expect(diff.getByText("未选择参照版本", { exact: true })).toBeVisible();
    await expect(diff.locator(".paper")).toHaveCount(1);
    await expect(diff.locator(".paper")).toContainText("响应时间优化 20%");
    await expect(diff.locator('.paper [data-resume-module="work"]')).toHaveAttribute("data-version-change", "added");
    await onlyChanges.check();
    await expect(diff.getByRole("heading", { name: "基本信息", exact: true })).toBeVisible();
    await expect(diff).toContainText("+ 新增");
  } finally {
    await request.delete(`/api/resumes/${id}`);
  }
});

test("删除的段落不能吞掉新增短语末尾的同字", async ({ page, request }, testInfo) => {
  const id = await createResume(request);
  const originalItems = [
    "响应时间优化 99.9%。",
    "设计话务实时监控链路，构建事件持久化与 Redis 实时投影；结合 CAS，保障并发统计一致性。",
    "设计可配置的工单自动分配模块",
  ];
  const saveItems = async (items: string[]) => {
    const draft = await (await request.get(`/api/resumes/${id}`)).json();
    const work = draft.modules.find((item: { key: string }) => item.key === "work");
    const saved = await request.patch(`/api/resumes/${id}`, { data: { modules: { work: [
      { ...work.content[0], descriptionItems: items }, ...work.content.slice(1),
    ] }, moduleRevisions: { work: work.revision } } });
    expect(saved.status()).toBe(200);
  };
  try {
    await saveItems(originalItems);
    await publishResume(request, id, "长项目旧版");
    await saveItems([`${originalItems[0]}定位方法份未发`, originalItems[2]!]);
    await publishResume(request, id, "长项目新版");
    await page.goto(`/resumes/${id}/versions`);
    const entry = page.getByRole("region", { name: "简历左右对照" }).locator('.paper').nth(1).locator('[data-resume-module="work"] [data-resume-entry="0"]');
    await expect(entry).toContainText("定位方法份未发");
    await expect.poll(() => page.evaluate(() => Array.from(CSS.highlights.get("resume-version-after") ?? []).map((range) => range.toString()))).toContain("定位方法份未发");
    await expect.poll(() => page.evaluate(() => Array.from(CSS.highlights.get("resume-version-before") ?? []).map((range) => range.toString()).join(""))).toContain("并发统计");
    await page.screenshot({ path: testInfo.outputPath("version-long-entry-diff.png"), fullPage: true });
  } finally {
    await request.delete(`/api/resumes/${id}`);
  }
});

test("发布等待在途模板保存，不会冻结旧模板", async ({ page, request }) => {
  const id = await createResume(request);
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let started = false;
  let published = false;
  await page.route(`**/api/resumes/${id}`, async (route) => {
    if (route.request().method() === "PATCH" && route.request().postDataJSON().template === "modern") {
      started = true;
      await blocked;
    }
    await route.continue();
  });
  page.on("request", (req) => { if (req.method() === "POST" && req.url().endsWith(`/resumes/${id}/versions`)) published = true; });
  try {
    await page.goto(`/resumes/${id}`);
    await page.getByTitle("点击切换简历模板").click();
    const picker = page.getByRole("dialog", { name: "选择简历模板" });
    await picker.getByRole("button").filter({ hasText: "现代简约" }).first().click();
    await expect.poll(() => started).toBe(true);
    await picker.getByRole("button", { name: "完成", exact: true }).click();
    await page.getByRole("button", { name: "发布新版本", exact: true }).click();
    await page.getByRole("textbox", { name: "版本名称" }).fill("等待排版版");
    await page.getByRole("button", { name: "确认发布", exact: true }).click();
    await expect(page.getByRole("button", { name: "正在保存并发布…", exact: true })).toBeDisabled();
    expect(published).toBe(false);
    release();
    await expect(page.getByRole("heading", { name: "v1 · 等待排版版", exact: true })).toBeVisible();
    const data = await (await request.get(`/api/resumes/${id}/versions`)).json();
    const detail = await (await request.get(`/api/resumes/${id}/versions/${data.versions[0].id}`)).json();
    expect(detail.snapshot.template).toBe("modern");
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
    await request.delete(`/api/resumes/${id}`);
  }
});
