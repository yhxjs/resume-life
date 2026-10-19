import { expect, test, type APIRequestContext } from "@playwright/test";
import { publishResume } from "./resume-version-helpers";

async function seed(request: APIRequestContext, resume = true) {
  let resumeId: number | null = null;
  let resumeVersionId: number | null = null;
  if (resume) {
    const response = await request.post("/api/resumes", { data: { title: "投递时简历",
      modules: { basic: { name: "测试求职者", email: "candidate@example.com" }, summary: { text: "投递时的项目经历" } } } });
    expect(response.status()).toBe(201);
    resumeId = (await response.json()).id;
    resumeVersionId = (await publishResume(request, resumeId!, "投递版")).id;
  }
  const company = `快照验证-${Date.now()}`;
  const response = await request.post("/api/applications", { data: { company, role: "前端工程师",
    resume_id: resumeId, resume_version_id: resumeVersionId, jd: "投递时的 JD", stage: "interested" } });
  expect(response.status()).toBe(201);
  return { id: (await response.json()).id as number, resumeId, company };
}

test("标记投递、修改简历和 JD、回看对比与删除源简历", async ({ page, request }, testInfo) => {
  const app = await seed(request);
  let failed = false;
  try {
    await page.goto("/applications");
    const matchesList = (response: import("@playwright/test").Response) => {
      const url = new URL(response.url());
      return url.pathname === "/api/applications" && url.searchParams.get("q") === app.company && response.request().method() === "GET";
    };
    const searched = page.waitForResponse(matchesList);
    await page.getByPlaceholder("搜索公司、岗位或笔记...").fill(app.company);
    expect((await searched).status()).toBe(200);
    const card = page.locator('[draggable="true"]').filter({ has: page.getByRole("heading", { name: app.company, exact: true }) });
    const saved = page.waitForResponse((response) => response.url().endsWith(`/api/applications/${app.id}`) && response.request().method() === "PATCH");
    const refreshed = page.waitForResponse(matchesList);
    await card.getByRole("combobox", { name: "流转阶段" }).selectOption("applied");
    expect((await saved).status()).toBe(200);
    expect((await refreshed).status()).toBe(200);
    await expect(card.getByRole("combobox", { name: "流转阶段" })).toHaveValue("applied");
    const frozen = await (await request.get(`/api/applications/${app.id}/versions`)).json();
    expect(frozen.submitted.resume.title).toBe("投递时简历");
    const current = await (await request.get(`/api/resumes/${app.resumeId}`)).json();
    const changed = await request.patch(`/api/resumes/${app.resumeId}`, { data: { title: "修改后简历", titleRevision: current.resume.titleRevision,
      modules: { summary: { text: "后来新增的项目经历" } },
      moduleRevisions: { summary: current.modules.find((module: { key: string }) => module.key === "summary").revision } } });
    expect(changed.status()).toBe(200);
    const stillBound = await (await request.get(`/api/applications/${app.id}/versions`)).json();
    expect(stillBound.current.resume.title).toBe("投递时简历");
    const updatedVersion = await publishResume(request, app.resumeId!, "更新后的关联版");
    expect((await request.patch(`/api/applications/${app.id}`, { data: {
      resume_version_id: updatedVersion.id, jd: "修改后的 JD", stage: "applied",
    } })).status()).toBe(200);
    await card.getByRole("button", { name: "投递版 / 对比", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: `${app.company} · 前端工程师 · 投递版本` });
    await expect(dialog.getByRole("region", { name: "投递版简历正文" })).toContainText("投递时的项目经历");
    await expect(dialog.getByRole("region", { name: "投递版岗位 JD" })).toContainText("投递时的 JD");
    await expect(dialog).not.toContainText("后来新增的项目经历");
    await dialog.getByRole("button", { name: "当前版", exact: true }).click();
    await expect(dialog.getByRole("region", { name: "当前版简历正文" })).toContainText("后来新增的项目经历");
    await dialog.getByRole("button", { name: "查看差异", exact: true }).click();
    await expect(dialog.getByRole("status")).toHaveText("3 处变化");
    const summary = dialog.getByRole("region", { name: "自我评价差异" });
    await expect(summary).toContainText("投递时的项目经历");
    await expect(summary).toContainText("后来新增的项目经历");
    await page.screenshot({ path: testInfo.outputPath("snapshot-diff-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("snapshot-diff-mobile.png") });
    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible();
    await expect(card.getByRole("button", { name: "投递版 / 对比", exact: true })).toBeFocused();
    expect((await request.delete(`/api/resumes/${app.resumeId}`)).status()).toBe(200);
    await card.getByRole("button", { name: "投递版 / 对比", exact: true }).click();
    await expect(dialog.getByRole("region", { name: "投递版简历正文" })).toContainText("投递时的项目经历");
    await dialog.getByRole("button", { name: "当前版", exact: true }).click();
    await expect(dialog).toContainText("当前未关联简历，或源简历已删除");
    await page.keyboard.press("Escape");
    const round = await request.post(`/api/applications/${app.id}/interviews`, { data: {
      round_name: "技术一面", interview_time: new Date().toISOString(), status: "scheduled",
    } });
    expect(round.status()).toBe(201);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.reload();
    await page.getByRole("tab", { name: /日程日历/ }).click();
    await page.getByRole("button", { name: "投递版", exact: true }).click();
    await expect(dialog.getByRole("region", { name: "投递版简历正文" })).toContainText("投递时的项目经历");
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      await request.delete(`/api/applications/${app.id}`);
      if (app.resumeId) await request.delete(`/api/resumes/${app.resumeId}`);
    } catch (error) {
      if (!failed) throw error;
    }
  }
});

test("缺少快照明确提示，请求失败可重试，无关联也能回看 JD", async ({ page, request }) => {
  const app = await seed(request, false);
  try {
    await page.goto("/applications");
    await page.getByPlaceholder("搜索公司、岗位或笔记...").fill(app.company);
    const card = page.locator('[draggable="true"]').filter({ has: page.getByRole("heading", { name: app.company, exact: true }) });
    await page.route(`**/api/applications/${app.id}/versions`, (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "暂时无法读取" }) }));
    await card.getByRole("button", { name: "投递版 / 对比", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: `${app.company} · 前端工程师 · 投递版本` });
    await expect(dialog.getByRole("alert")).toContainText("暂时无法读取");
    await page.unroute(`**/api/applications/${app.id}/versions`);
    await dialog.getByRole("button", { name: "点击重试" }).click();
    await expect(dialog).toContainText("暂无投递快照");
    await dialog.getByRole("button", { name: "查看差异", exact: true }).click();
    await expect(dialog).toContainText("没有投递快照，暂时无法比较差异");
    await page.keyboard.press("Escape");
    await request.patch(`/api/applications/${app.id}`, { data: { stage: "applied" } });
    await card.getByRole("button", { name: "投递版 / 对比", exact: true }).click();
    await expect(dialog).toContainText("标记已投递时未关联简历");
    await expect(dialog.getByRole("region", { name: "投递版岗位 JD" })).toContainText("投递时的 JD");
  } finally { await request.delete(`/api/applications/${app.id}`); }
});
