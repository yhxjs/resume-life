import { expect, test } from "@playwright/test";
import { overallOf, type ScoreMap } from "../../src/lib/scores";

const projectName = "项目原名 <T> &amp; " + "完整项目名称".repeat(16) + "OriginalProjectIdentifier".repeat(8) + "辨识后缀";

function reviewData(avg: ScoreMap, truncated: boolean) {
  return {
    totals: { drills: 1, interviews: 1, scoredAnswers: 10_001 },
    overall: avg, overallScore: overallOf(avg), drillAvg: avg, interviewAvg: avg, truncated,
    sessions: [
      { id: "drill-1", kind: "drill", label: "项目练习", date: "2026-11-01", count: 10_000, avg, overall: overallOf(avg) },
      { id: "interview-1", kind: "interview", label: "模拟面试", date: "2026-11-02", count: 1, avg, overall: overallOf(avg) },
    ],
    projects: [{ id: 1, name: projectName, answers: 10_000, overall: overallOf(avg) }],
  };
}

for (const width of [390, 1280]) {
  test(`复盘统计 ${width}px：截断范围、并列维度与零分`, async ({ page }, testInfo) => {
    let data = reviewData({ depth: 4.2, structure: 8.2, authenticity: 8.2, completeness: 4.2 }, true);
    const writes: string[] = [];
    let reads = 0;
    page.on("request", request => {
      if (new URL(request.url()).pathname.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(request.method())) {
        writes.push(request.method());
      }
    });
    await page.route("**/api/review", async route => { reads++; await route.fulfill({ json: data }); });
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/review");
    const notice = page.getByRole("status").filter({ hasText: "本页仅统计部分历史作答" });
    await expect(notice).toContainText("场次数、均分、趋势、维度分析和项目分布");
    await expect(notice).toContainText("部分场次可能只计入部分题目");
    await expect(page.getByText("纳入统计的作答数", { exact: true }).locator("..")).toContainText("10001");
    await expect(page.getByText("本次统计综合均分", { exact: true }).locator("..")).toContainText("6.2");
    await page.screenshot({ path: testInfo.outputPath(`review-scope-${width}.png`) });
    const section = page.locator("section").filter({ has: page.getByRole("heading", { name: "薄弱维度定向分析", exact: true }) });
    await expect(section).toContainText("结构表达、真实性");
    await expect(section).toContainText("技术深度、完整度");
    await expect(section.getByText("并列较低", { exact: true })).toHaveCount(2);
    await section.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`review-ties-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const projects = page.locator("section").filter({ has: page.getByRole("heading", { name: "各项目已评分作答分布" }) });
    const project = projects.getByText(projectName, { exact: true });
    await project.scrollIntoViewIfNeeded();
    const bounds = await project.evaluate(element => ({
      width: element.clientWidth, fullWidth: element.scrollWidth,
      height: element.clientHeight, fullHeight: element.scrollHeight,
      lineHeight: parseFloat(getComputedStyle(element).lineHeight),
    }));
    expect(bounds.fullWidth).toBeLessThanOrEqual(bounds.width + 1);
    expect(bounds.fullHeight).toBeLessThanOrEqual(bounds.height + 1);
    expect(bounds.height).toBeGreaterThan(bounds.lineHeight);
    await expect(projects).toContainText("辨识后缀");
    await page.screenshot({ path: testInfo.outputPath(`review-project-name-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    data = reviewData({ depth: 0, structure: 0, authenticity: 0, completeness: 0 }, false);
    await page.reload();
    await expect(section).toContainText("四个维度的均分均为 0.0 分，当前没有分数高低差异");
    await expect(notice).toHaveCount(0);
    await expect(section.getByText(/相对较低|并列较低|核心补强项/)).toHaveCount(0);
    await expect(section.getByRole("meter")).toHaveCount(4);
    for (const meter of await section.getByRole("meter").all()) {
      await expect(meter).toHaveAttribute("aria-valuenow", "0");
      expect((await meter.locator("div").boundingBox())!.width).toBe(0);
    }
    await section.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`review-zero-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(reads).toBe(2);
    expect(writes).toEqual([]);
  });
}
