import { expect, test } from "@playwright/test";
import { PRESET_JARGONS, type JargonDecoderResult } from "../../src/lib/jargon-decoder";
import { mockApi } from "./synthetic-api";

test("速查不预评公司风险，手机端逐项查看和追加原话无需模型调用", async ({ page }, testInfo) => {
  await mockApi(page);
  let generationCalls = 0;
  await page.route("**/api/tools/jargon-decodings**", async (route) => {
    if (route.request().method() === "POST") {
      generationCalls++;
      await route.fulfill({ status: 500, json: { error: "本用例不应生成报告" } });
      return;
    }
    await route.fulfill({ json: { items: [], nextCursor: null, total: 0 } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tools/decoder");
  const input = page.getByRole("textbox");
  let source = "公司原话：无需加班。";
  await input.fill(source);
  for (const preset of PRESET_JARGONS) {
    await page.getByRole("button", { name: preset.keyword, exact: true }).click();
    await expect(page.getByText("通用示例 · 未评估", { exact: true })).toBeVisible();
    await expect(page.getByText(preset.hiddenMeaning, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "+ 加到输入框", exact: true }).click();
    source += `\n${preset.keyword}`;
    await expect(input).toHaveValue(source);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  expect(generationCalls).toBe(0);
  await page.screenshot({ path: testInfo.outputPath("jargon-presets-mobile.png"), fullPage: true });
});

test("报告手机端保留未知与原文解释，四维信号不转换为公司事实", async ({ page }, testInfo) => {
  await mockApi(page);
  const result: JargonDecoderResult = {
    targetSummary: "合成岗位的值班约定", punchline: "核实值班与补偿，并补充未说明的支持条件", overallRiskScore: 75,
    riskRatings: { overtime: 7, stability: 1, resources: 4, management: null },
    items: [{
      keyword: "值班无补偿", surfaceMeaning: "文本明确说值班没有补偿",
      hiddenMeaning: "文本含明确不利条件，但其他安排尚不清楚", riskLevel: "high",
      riskCategory: "值班与补偿", warning: "若按此条件执行，休息与收入预期可能受到影响",
      interviewRule: "确认值班频率和书面约定，表达真实边界", counterQuestions: ["最近一次值班如何排期？"],
    }],
    companyProfile: { teamStyle: "其余信息不足", riskFlags: ["值班无补偿"], cultureSummary: "只有值班条件，不能确认业务稳定性、资源或管理状况" },
    goldenQuestions: ["值班频率和补偿能否在书面约定中说明？"],
  };
  await page.route("**/api/tools/jargon-decodings/9008", (route) => route.fulfill({ json: {
    id: 9008, source_text: "岗位说明：值班无补偿；支持条件待确认。", result, created_at: "2026-10-28",
  } }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tools/decoder/9008");
  await expect(page.getByRole("heading", { name: result.targetSummary })).toBeVisible();
  for (const [name, score, signal] of [
    ["加班过劳指数", 7, "风险信号较强"], ["业务动荡指数", 1, "文本风险信号较弱"],
    ["资源匮乏指数", 4, "存在待核实信号"], ["管理内耗指数", null, "未提供有效评分"],
  ] as const) {
    const group = page.getByRole("group", { name, exact: true });
    await expect(group.getByText(signal, { exact: false })).toBeVisible();
    if (score === null) await expect(group.getByRole("meter")).toHaveCount(0);
    else await expect(group.getByRole("meter", { name, exact: true })).toHaveAttribute("aria-valuenow", String(score));
  }
  await expect(page.getByText(result.companyProfile.cultureSummary, { exact: true })).toBeVisible();
  await expect(page.getByText(result.items[0]!.hiddenMeaning, { exact: true })).toBeVisible();
  await expect(page.getByText(/风险可控|相对稳健|主营业务稳固|资源与支撑体系较健全/)).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("jargon-report-mobile.png"), fullPage: true });
});
