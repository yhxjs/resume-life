import { expect, test } from "@playwright/test";
import { mockApi, syntheticResume } from "./synthetic-api";

const emptyPage = { items: [], nextCursor: null, total: 0 };
const emptyReview = { totals: { drills: 0, interviews: 0, scoredAnswers: 0 }, overall: null, overallScore: null, drillAvg: null, interviewAvg: null, sessions: [], projects: [] };

const cases = [
  { path: "/resumes", api: "/api/resumes", result: [] },
  { path: "/knowledge", api: "/api/projects", result: [] },
  { path: "/intros", api: "/api/intros", result: emptyPage },
  { path: "/interviews", api: "/api/interviews", result: emptyPage },
  { path: "/drills", api: "/api/drills", result: emptyPage },
  { path: "/notebook", api: "/api/notebook", result: emptyPage },
  { path: "/bank", api: "/api/bank", result: emptyPage },
  { path: "/applications", api: "/api/applications", result: emptyPage },
  { path: "/tools/jd", api: "/api/tools/jd-portraits", result: emptyPage },
  { path: "/tools/salary", api: "/api/tools/salary-negotiations", result: emptyPage },
  { path: "/tools/decoder", api: "/api/tools/jargon-decodings", result: emptyPage },
  { path: "/tools/gap", api: "/api/tools/career-gap-remedies", result: emptyPage },
  { path: "/review", api: "/api/review", result: emptyReview },
  { path: "/settings", api: "/api/settings", result: {} },
  { path: "/tools/portfolio", api: "/api/portfolio/sources", result: { resumes: [], projects: [] } },
];

for (const item of cases) {
  test(`${item.path} reports failure, stops loading and recovers on retry`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await mockApi(page);
    await page.route("**/api/notebook/categories", (route) => route.fulfill({ json: [] }));
    let attempts = 0;
    await page.route(`**${item.api}*`, async (route) => {
      if (new URL(route.request().url()).pathname !== item.api) return route.fallback();
      attempts += 1;
      await route.fulfill(attempts === 1
        ? { status: 503, json: { error: "测试加载失败，请重试" } }
        : { json: item.result });
    });
    await page.goto(item.path);
    const alert = page.getByRole("alert").filter({ hasText: "测试加载失败，请重试" });
    await expect(alert).toBeVisible();
    await expect(page.locator(".skeleton")).toHaveCount(0);
    await alert.getByRole("button", { name: "重试加载" }).click();
    await expect.poll(() => attempts).toBe(2);
    await expect(alert).toHaveCount(0);
    await expect(page.locator(".skeleton")).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}

for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
  test(`resume error and recovery layout at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await mockApi(page);
    let attempts = 0;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/resumes", async (route) => {
      attempts += 1;
      if (attempts === 1) return route.fulfill({ status: 500, json: { error: "简历服务暂不可用，请稍后重试。" } });
      await pending;
      await route.fulfill({ json: [{ ...syntheticResume().resume, versions: [] }] });
    });
    await page.goto("/resumes");
    await expect(page.getByRole("main").getByRole("alert")).toBeVisible();
    await expect(page.locator(".skeleton")).toHaveCount(0);
    const screenshot = testInfo.outputPath(`resume-error-${viewport.width}.png`);
    await page.screenshot({ path: screenshot, fullPage: true });
    await testInfo.attach("error-state", { path: screenshot, contentType: "image/png" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("button", { name: "重试加载" }).click();
    await expect(page.getByRole("status", { name: "加载简历列表中…" })).toBeVisible();
    await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
    release();
    await expect(page.getByRole("link", { name: "合成测试简历", exact: true })).toBeVisible();
    await expect(page.locator(".skeleton")).toHaveCount(0);
  });
}

test("retrying print templates keeps the loaded resume and does not refetch it", async ({ page }) => {
  await mockApi(page);
  let resumeRequests = 0;
  await page.route("**/api/resumes/9001", async (route) => {
    resumeRequests += 1;
    await route.fulfill({ json: syntheticResume() });
  });
  let templateRequests = 0;
  await page.route("**/api/templates", async (route) => {
    templateRequests += 1;
    await route.fulfill(templateRequests === 1 ? { status: 503, json: { error: "模板暂不可用" } } : { json: { items: [] } });
  });
  await page.goto("/resumes/9001/print");
  await expect(page.locator(".paper")).toContainText("合成姓名");
  await expect(page.getByRole("main").getByRole("alert")).toContainText("模板暂不可用");
  await page.getByRole("button", { name: "点击重试" }).click();
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  await expect(page.locator(".paper")).toContainText("合成姓名");
  expect(resumeRequests).toBe(1);
  expect(templateRequests).toBe(2);
});
