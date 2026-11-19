import { expect, test } from "@playwright/test";
import type { ResignationGapRemedyResult } from "../../src/lib/career-gap-remedy";
import { mockApi } from "./synthetic-api";

const result: ResignationGapRemedyResult = {
  title: "按事实说明休整经历", punchline: "休息六个月，没有学习与项目，后续安排尚未确认。",
  hrMindsetAnalysis: { coreConcerns: [], riskPoints: [], whatHrWantsToHear: "仅需核实与岗位相关的安排，无须披露无关病史。" },
  reframeFormula: { factAcknowledgment: "休整六个月", positiveAttribution: "个人选择休息", growthAndValue: "未开展项目与学习", motivationAlignment: "[待补充：真实求职方向]" },
  scripts: {
    concise: { label: "原精炼标签", applicableScene: "初步沟通", script: "我休息了六个月，没有开展学习或项目；到岗安排尚未确认。", keyPoints: ["保留时间与未知"] },
    detailed: { label: "原详细标签", applicableScene: "进一步沟通", script: "六个月用于休息，没有开展项目。\n<T> &amp; 是原文；[待补充：岗位相关安排]，不披露无关病史。", keyPoints: ["保留原字符与边界"] },
    pivoting: { label: "原衔接标签", applicableScene: "讨论岗位", script: "可以继续沟通岗位职责，求职方向尚未确定，未承诺立即到岗。", keyPoints: ["不虚构承诺"] },
  },
  drills: [{ question: "目前能确认哪些时间安排？", hrConcern: "可能核实到岗条件，不代表已知真实心理", bestResponse: "[待补充：真实安排]，目前尚未承诺到岗。" }],
  forbiddenList: ["不编造学习、项目或康复结论"], closingTips: ["只说明岗位相关安排"],
};
const record = { id: 9012, scenario_type: "gap", raw_story: "六个月用于休息，没有学习与项目；<T> &amp; 到岗尚未确定。", target_role: "尚未确定", persona_style: "composed", result, created_at: "2026-10-28" };

for (const width of [390, 1280]) {
  test(`空窗 ${width}px：三版与追问复制保留事实限定，复制失败可恢复`, async ({ page }, testInfo) => {
    await mockApi(page);
    let writes = 0;
    await page.route("**/api/tools/career-gap-remedies/9012", (route) => route.fulfill({ json: record }));
    await page.route("**/api/tools/career-gap-remedies", async (route) => {
      if (route.request().method() === "POST") writes++;
      await route.fulfill({ status: 500, json: { error: "查看和复制不应生成新方案" } });
    });
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/tools/gap/9012");
    await expect(page.getByRole("heading", { name: new RegExp(result.title) })).toBeVisible();
    await page.getByText("查看您输入的原始经历与痛点", { exact: true }).click();
    await expect(page.getByRole("region", { name: "原始经历", exact: true })).toHaveText(record.raw_story);
    await expect(page.getByText(/当前材料未支持明确关注点/)).toBeVisible();
    await expect(page.getByText(/本次未识别具体表述风险/)).toBeVisible();
    for (const [label, key] of [["精炼说明版", "concise"], ["详细说明版", "detailed"], ["岗位衔接版", "pivoting"]] as const) {
      const selector = page.getByRole("group", { name: "话术版本", exact: true }).getByRole("button", { name: label, exact: true });
      await selector.click();
      await expect(selector).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByRole("region", { name: "当前话术原文", exact: true })).toHaveText(`“${result.scripts[key].script}”`);
      await page.getByRole("button", { name: "📋 一键复制此话术", exact: true }).click();
      // Windows 原生剪贴板会把 LF 存为 CRLF；只在断言时统一换行，不改写复制内容。
      await expect.poll(() => page.evaluate(async () => (await navigator.clipboard.readText()).replace(/\r\n/g, "\n"))).toBe(result.scripts[key].script);
      await expect(page.getByRole("button", { name: "✓ 已复制整段话术", exact: true })).toBeVisible();
    }
    await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.reject(new Error("denied")) } }));
    await page.getByRole("button", { name: "✓ 已复制整段话术", exact: true }).click();
    const copyAlert = page.getByRole("alert").filter({ hasText: "复制失败" });
    await expect(copyAlert).toBeVisible();
    await expect(page.getByRole("button", { name: "✓ 已复制整段话术", exact: true })).toHaveCount(0);
    await page.evaluate(() => Reflect.deleteProperty(navigator, "clipboard"));
    await page.getByRole("button", { name: "📋 一键复制此话术", exact: true }).click();
    await expect(copyAlert).toHaveCount(0);
    await page.getByRole("button", { name: "复制", exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(result.drills[0]!.bestResponse);
    await expect(page.getByText(/心理测谎仪|打死不能说漏嘴|满分拆解|可直接背诵|听着舒适|连环追杀/)).toHaveCount(0);
    expect(writes).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await page.screenshot({ path: testInfo.outputPath(`gap-report-${width}.png`), fullPage: true });
  });
}

test("损坏空窗报告保留原始经历与返回入口，刷新后仍可核对", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/tools/career-gap-remedies/9012", (route) => route.fulfill({ json: { ...record, result: null } }));
  await page.goto("/tools/gap/9012");
  await expect(page.getByText(/该报告内容无法解析/)).toBeVisible();
  await page.reload();
  await page.getByText("查看您输入的原始经历与痛点", { exact: true }).click();
  await expect(page.getByRole("region", { name: "原始经历", exact: true })).toHaveText(record.raw_story);
  await expect(page.getByRole("link", { name: "返回重试", exact: true })).toHaveAttribute("href", "/tools/gap");
  await expect(page.getByRole("button", { name: /一键复制此话术/ })).toHaveCount(0);
});

for (const width of [390, 1280]) {
  test(`部分历史空窗报告 ${width}px：优先展示已有正文，空版本不覆盖剪贴板`, async ({ page }, testInfo) => {
    await mockApi(page);
    const partial = structuredClone(record);
    partial.result.scripts.concise.script = " \n ";
    partial.result.scripts.pivoting.script = "";
    let writes = 0;
    await page.route("**/api/tools/career-gap-remedies**", (route) => {
      if (route.request().method() !== "GET") writes++;
      return route.fulfill({ json: partial });
    });
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/tools/gap/9012");
    const source = page.getByRole("region", { name: "当前话术原文", exact: true });
    await expect(source).toHaveText(`“${partial.result.scripts.detailed.script}”`);
    await expect(page.getByRole("button", { name: "详细说明版", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: /一键复制此话术/ }).click();
    await expect.poll(() => page.evaluate(async () => (await navigator.clipboard.readText()).replace(/\r\n/g, "\n")))
      .toBe(partial.result.scripts.detailed.script);
    for (const name of ["精炼说明版", "岗位衔接版"]) {
      await page.getByRole("button", { name, exact: true }).click();
      await expect(source).toContainText("此版本未保存话术正文");
      await expect(page.getByRole("button", { name: /一键复制此话术/ })).toBeDisabled();
      await expect.poll(() => page.evaluate(async () => (await navigator.clipboard.readText()).replace(/\r\n/g, "\n")))
        .toBe(partial.result.scripts.detailed.script);
    }
    await page.reload();
    await expect(source).toHaveText(`“${partial.result.scripts.detailed.script}”`);
    await page.getByText("查看您输入的原始经历与痛点", { exact: true }).click();
    await expect(page.getByRole("region", { name: "原始经历", exact: true })).toHaveText(record.raw_story);
    expect(writes).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
    await page.screenshot({ path: testInfo.outputPath(`gap-partial-${width}.png`), fullPage: true });
  });
}
