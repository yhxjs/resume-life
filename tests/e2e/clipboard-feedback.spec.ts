import { expect, test, type Locator, type Page } from "@playwright/test";
import { PRESET_JARGONS } from "../../src/lib/jargon-decoder";
import { PRESET_REMEDIES } from "../../src/lib/career-gap-remedy";
import { mockApi } from "./synthetic-api";

async function verifyCopyRecovery(page: Page, button: Locator, scope: Locator, text: string, screenshotPath: string) {
  const allCopyButtons = page.getByRole("button", { name: /^(复制|复制提问|复制参考|复制示例|已复制|已复制 ✓|📋 一键复制全部要点|✓ 全部草稿已复制)$/ });
  const copiedLabel = /^(已复制(?: ✓)?|✓ 全部草稿已复制)$/;
  await button.click();
  await expect(button).toHaveText(copiedLabel);
  await expect.poll(() => page.evaluate(async () => (await navigator.clipboard.readText()).replace(/\r\n/g, "\n"))).toBe(text);
  await page.evaluate(() => {
    const state = window as Window & { rejectCopy?: () => void; copyCalls?: number };
    state.copyCalls = 0;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: () => {
        state.copyCalls!++;
        return new Promise<void>((_resolve, reject) => { state.rejectCopy = () => reject(new Error("denied")); });
      },
    } });
  });
  await button.click();
  await expect(page.getByRole("button", { name: copiedLabel })).toHaveCount(0);
  for (const copyButton of await allCopyButtons.all()) await expect(copyButton).toBeDisabled();
  expect(await page.evaluate(() => (window as Window & { copyCalls?: number }).copyCalls)).toBe(1);
  await page.evaluate(() => (window as Window & { rejectCopy?: () => void }).rejectCopy?.());
  await expect(scope.getByRole("alert")).toContainText("手动复制");
  await expect(button).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await scope.screenshot({ path: screenshotPath });
  await page.evaluate(() => Reflect.deleteProperty(navigator, "clipboard"));
  await button.click();
  await expect(scope.getByRole("alert")).toHaveCount(0);
  await expect(button).toHaveText(copiedLabel);
  await expect.poll(() => page.evaluate(async () => (await navigator.clipboard.readText()).replace(/\r\n/g, "\n"))).toBe(text);
}

for (const width of [390, 1280]) {
  test(`空窗示例 ${width}px：复制失败就近反馈，切换场景和重试保留真实经历`, async ({ page }, testInfo) => {
    await mockApi(page);
    let writes = 0;
    await page.route("**/api/tools/career-gap-remedies**", (route) => {
      if (route.request().method() !== "GET") writes++;
      return route.fulfill({ json: { items: [], nextCursor: null, total: 0 } });
    });
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/tools/gap");
    const source = "只休息，没有学习或项目 <T> &amp;\n到岗时间尚未确认。";
    const input = page.getByRole("textbox", { name: "真实经历与希望说明的问题" });
    await input.fill(source);
    const preset = PRESET_REMEDIES[0]!;
    await page.getByRole("button", { name: new RegExp(preset.title) }).click();
    const concise = page.getByRole("region", { name: "精炼说明示例", exact: true });
    await verifyCopyRecovery(page, concise.getByRole("button"), concise, preset.quickScript, testInfo.outputPath(`gap-preset-copy-error-${width}.png`));
    await page.getByRole("button", { name: new RegExp(PRESET_REMEDIES[1]!.title) }).click();
    const detail = page.getByRole("region", { name: "详细说明示例", exact: true });
    await expect(detail.getByRole("button", { name: "复制示例", exact: true })).toBeEnabled();
    await detail.getByRole("button").click();
    await expect.poll(() => page.evaluate(async () => (await navigator.clipboard.readText()).replace(/\r\n/g, "\n"))).toBe(PRESET_REMEDIES[1]!.deepScript);
    await expect(input).toHaveValue(source);
    expect(writes).toBe(0);
  });

  test(`经历挖掘 ${width}px：单条和整组复制保留未知与条件，失败重试不改报告`, async ({ page }, testInfo) => {
    const controls = await mockApi(page);
    const bullets = ["只参与校验 <T> &amp;\n尚未上线，未统计收益。", "[待补充：个人分工]，不代表独立完成。"];
    let writes = 0;
    await page.route("**/api/interviews/9016**", (route) => {
      if (route.request().method() !== "GET") writes++;
      return route.fulfill({ json: {
        id: 9016, resume_title: "维护经历", resume_version_id: 90001, resume_version: 1, resume_version_name: "测试发布版本", jd: "按真实经历沟通", rounds: 1, style: "mining",
        series_id: null, round_no: 0, series_status: null, series_rounds: [], status: "finished",
        report: { depth: 7, structure: 7, authenticity: 7, completeness: 7, jd_match: 7, overall: 7,
          strengths: "明确有限分工", weaknesses: "收益未统计", suggestions: "核对事实",
          mining_summary: { project_name: "接口维护", background: "维护已有服务", actions: "参与校验", tradeoffs: "范围有限", results: "尚未上线", contribution: "仅负责校验", pending_confirmations: [], resume_bullets: bullets } },
        evaluator_report: null, reverse_interview: null, created_at: "2026-10-28T00:00:00Z", finished_at: "2026-10-28T00:01:00Z", turns: [],
      } });
    });
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/interviews/9016");
    await page.getByRole("button", { name: "查看挖掘产物 →", exact: true }).click();
    const drafts = page.getByRole("region", { name: "简历描述草稿", exact: true });
    const first = drafts.locator(".group").filter({ hasText: "只参与校验 <T> &amp;" });
    await verifyCopyRecovery(page, first.getByRole("button"), first, bullets[0]!, testInfo.outputPath(`mining-copy-error-${width}.png`));
    await verifyCopyRecovery(page, drafts.getByRole("button", { name: /^(📋 一键复制全部要点|✓ 全部草稿已复制)$/ }), drafts,
      bullets.map((bullet) => `• ${bullet}`).join("\n"), testInfo.outputPath(`mining-all-copy-error-${width}.png`));
    await expect(drafts.getByText(/没有依据时不补写量化结果/)).toBeVisible();
    await page.reload();
    await page.getByRole("button", { name: "查看挖掘产物 →", exact: true }).click();
    await expect(first).toContainText(bullets[0]!);
    expect(writes).toBe(0);
    expect(controls.writes).toHaveLength(0);
  });

  test(`黑话速查 ${width}px：原问题复制失败就近反馈，重试不改输入`, async ({ page }, testInfo) => {
    await mockApi(page);
    let writes = 0;
    await page.route("**/api/tools/jargon-decodings**", (route) => {
      if (route.request().method() !== "GET") writes++;
      return route.fulfill({ json: { items: [], nextCursor: null, total: 0 } });
    });
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/tools/decoder");
    const source = "公司原话 <T> &amp;\n未说明工时条件，不承诺非工作时间在线。";
    await page.getByRole("textbox").fill(source);
    const preset = PRESET_JARGONS[0]!;
    await page.getByRole("button", { name: preset.keyword, exact: true }).click();
    const question = page.getByRole("listitem").filter({ hasText: preset.counterQuestions[0]! });
    await verifyCopyRecovery(page, question.getByRole("button"), question, preset.counterQuestions[0]!, testInfo.outputPath(`preset-copy-error-${width}.png`));
    await expect(page.getByRole("textbox")).toHaveValue(source);
    expect(writes).toBe(0);
  });

  test(`黑话详情 ${width}px：核实问题复制保留原文与末尾条件，失败可恢复`, async ({ page }, testInfo) => {
    const controls = await mockApi(page);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    const question = "核心时段 <T> &amp;\n和非工作时间响应范围尚未确认，分别有哪些约定？";
    await page.route("**/api/tools/jargon-decodings/9014", (route) => route.fulfill({ json: {
      id: 9014, source_text: "原材料：弹性工作制，响应条件未说明。", created_at: "2026-10-28",
      result: {
        targetSummary: "待核实时间安排", punchline: "不能仅凭文本确认实际工时", overallRiskScore: null,
        riskRatings: { overtime: null, stability: null, resources: null, management: null },
        items: [{ keyword: "弹性工作制", surfaceMeaning: "可能灵活安排时间", hiddenMeaning: "适用范围尚未说明", riskLevel: null,
          riskCategory: "时间条件", warning: "若要求持续在线，可能影响休息", interviewRule: "先核实，再表达实际可用时间", counterQuestions: [question] }],
        companyProfile: { teamStyle: "未知", riskFlags: [], cultureSummary: "实际情况待核实" },
        goldenQuestions: ["能否提供近期排期和响应安排的例子？"],
      },
    } }));
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/tools/decoder/9014");
    const row = page.getByRole("listitem").filter({ hasText: "核心时段 <T> &amp;" });
    await verifyCopyRecovery(page, row.getByRole("button"), row, question, testInfo.outputPath(`report-copy-error-${width}.png`));
    await page.reload();
    await expect(page.getByRole("button", { name: "复制", exact: true })).toBeEnabled();
    expect(controls.writes).toHaveLength(0);
  });

  test(`专项练习 ${width}px：参考切题不混用复制反馈，原答与参考保持各自内容`, async ({ page }, testInfo) => {
    const controls = await mockApi(page);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    const questions = [1, 2].map((id) => ({
      id, idx: id, question: `原问题${id}：如何说明接口维护范围？`, answer: `原回答${id}：只做参数校验，尚未上线。`,
      comment: "仅根据已提交回答练习", reference: `参考${id} <T> &amp;\n[待补充：个人分工]，尚未确认线上收益。`,
      scores: null, answered_at: "2026-10-28", kind: "tech", notebook_id: null,
    }));
    let writes = 0;
    await page.route("**/api/drills/9015**", (route) => {
      if (route.request().method() !== "GET") writes++;
      return route.fulfill({ json: { id: 9015, source: "project", project_id: 1, direction: "", jd: "", interview_id: null,
        focus: "", created_at: "2026-10-28", project_name: "维护项目", questions } });
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/drills/9015");
    const reference = page.getByRole("region", { name: "本题回答参考", exact: true });
    await verifyCopyRecovery(page, reference.getByRole("button"), reference, questions[0]!.reference, testInfo.outputPath(`drill-copy-error-${width}.png`));
    await page.getByRole("button", { name: "第 2 题（已答）", exact: true }).click();
    await expect(reference).toContainText(questions[1]!.reference);
    await expect(reference.getByRole("button", { name: "复制参考", exact: true })).toBeEnabled();
    await reference.getByRole("button").click();
    await expect.poll(() => page.evaluate(async () => (await navigator.clipboard.readText()).replace(/\r\n/g, "\n"))).toBe(questions[1]!.reference);
    await expect(page.getByText(questions[1]!.answer, { exact: true })).toBeVisible();
    await page.reload();
    await expect(reference).toContainText(questions[0]!.reference);
    expect(writes).toBe(0);
    expect(controls.writes).toHaveLength(0);
  });
}
