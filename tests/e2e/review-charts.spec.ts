import { expect, test } from "@playwright/test";
import { overallOf } from "../../src/lib/scores";

test.use({ hasTouch: true });

const sessions = Array.from({ length: 45 }, (_, i) => {
  const avg = { depth: i % 2 ? 0 : 10, structure: 7.4, authenticity: 8.2, completeness: 6.6 };
  return {
  id: `${i % 2 ? "interview" : "drill"}-${i + 1}`,
  kind: i % 2 ? "interview" : "drill",
  label: i === 0 ? "原始长标题 <T> &amp; " + "字段".repeat(80) : `场次标题 ${i + 1}`,
  date: `2026-11-01T${String(Math.floor(i / 3)).padStart(2, "0")}:00:00.000Z`,
  count: 1,
  avg,
  overall: overallOf(avg),
  };
});
const data = {
  totals: { drills: 23, interviews: 22, scoredAnswers: 45 },
  overall: { depth: 5.1, structure: 7.4, authenticity: 8.2, completeness: 6.6 }, overallScore: 6.8,
  drillAvg: { depth: 10, structure: 7.4, authenticity: 8.2, completeness: 6.6 },
  interviewAvg: { depth: 0, structure: 7.4, authenticity: 8.2, completeness: 6.6 }, truncated: false, sessions, projects: [],
};

for (const width of [320, 390, 1280]) {
  test(`复盘图表 ${width}px：字可读、场次可翻页、键盘读取精确分数`, async ({ page }, testInfo) => {
    let reads = 0;
    const writes: string[] = [];
    page.on("request", request => {
      if (new URL(request.url()).pathname.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(request.method())) {
        writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
      }
    });
    await page.route("**/api/review", async route => {
      reads++;
      await route.fulfill({ json: data });
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/review");
    const chart = page.getByRole("img", { name: "四维评分趋势折线图", exact: true });
    await expect(chart).toBeVisible();
    await chart.scrollIntoViewIfNeeded();
    const effectiveFontSizes = () => chart.locator("text").evaluateAll(elements => elements.map(element => {
      const text = element as SVGTextElement;
      return parseFloat(getComputedStyle(text).fontSize) * (text.getScreenCTM()?.a ?? 0);
    }));
    await testInfo.attach("trend-fonts.json", { body: JSON.stringify(await effectiveFontSizes()), contentType: "application/json" });
    await page.screenshot({ path: testInfo.outputPath(`review-trend-${width}.png`) });
    await expect.poll(async () => Math.min(...await effectiveFontSizes())).toBeGreaterThanOrEqual(11.9);
    expect(await chart.locator("circle, rect").count()).toBeLessThanOrEqual(80);
    const range = page.getByRole("combobox", { name: "选择场次范围", exact: true });
    await expect(range).toHaveValue("0");
    const expand = page.getByText("查看本页场次明细", { exact: true });
    await expand.focus();
    await expand.press("Enter");
    const details = page.getByRole("list", { name: "本页场次明细", exact: true });
    await expect(details.getByRole("listitem")).toHaveCount(20);
    await expect(details).toContainText("场次标题 45");
    await expect(details.getByRole("listitem").last()).toContainText("10.0");
    await expect(details.getByRole("listitem").last()).toContainText("7.4");
    await expect(details.getByRole("listitem").last()).toContainText(`综合 ${sessions[44]!.overall.toFixed(1)} 分`);
    await expect(details.getByRole("listitem").nth(18)).toContainText("0.0");
    if (width <= 390) {
      await expand.tap(); await expect(details).toBeHidden();
      await expand.tap(); await expect(details).toBeVisible();
    }
    const older = page.getByRole("button", { name: "更早场次", exact: true });
    await older.focus(); await older.press("Enter");
    await expect(range).toHaveValue("1");
    await expect(details).toContainText("场次标题 25");
    await range.selectOption("2");
    await expect(details.getByRole("listitem")).toHaveCount(5);
    await expect(details).toContainText(sessions[0]!.label);
    await expect(older).toBeDisabled();
    await details.getByRole("listitem").first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`review-details-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const radar = page.getByRole("table", { name: "四维均分对比", exact: true });
    await expect(radar).toContainText("7.4");
    await expect(radar.getByRole("row").filter({ hasText: "技术深度" })).toContainText("10.0");
    await expect(radar.getByRole("row").filter({ hasText: "技术深度" })).toContainText("0.0");
    const radarGraphic = page.getByRole("img", { name: "练习与面试的四维雷达对比图", exact: true });
    await radarGraphic.locator("..").scrollIntoViewIfNeeded();
    const titleBounds = await radarGraphic.getByText("技术深度", { exact: true }).boundingBox();
    const tickBounds = await radarGraphic.getByText("10", { exact: true }).boundingBox();
    expect(titleBounds).not.toBeNull();
    expect(tickBounds).not.toBeNull();
    expect(tickBounds!.y - titleBounds!.y - titleBounds!.height).toBeGreaterThan(3);
    await page.screenshot({ path: testInfo.outputPath(`review-radar-${width}.png`) });
    await page.setViewportSize({ width: width === 1280 ? 390 : 1280, height: 900 });
    await expect.poll(async () => Math.min(...await effectiveFontSizes())).toBeGreaterThanOrEqual(11.9);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(reads).toBe(1);
    expect(writes).toEqual([]);
  });
}
