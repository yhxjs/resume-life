import { expect, test } from "@playwright/test";
import type { DefenseDrillRecord, ResumeDefenseReport } from "../../src/lib/resume-defense";
import { gate, mockApi } from "./synthetic-api";

const quote = '原文保留 Array&lt;T&gt;、&amp;lt;T&amp;gt; 与 <strong>接口校验</strong>；<img src=x onerror="window.__defenseProbe=true">，尚未上线';
const report: ResumeDefenseReport = {
  id: 9010, resumeId: null, title: "接口校验原文与证据边界", sourceContent: `项目经历\n${quote}`,
  targetRole: "接口工程师", riskLevel: "medium", overallRoast: "个人分工已说明，验证结果仍需核实", createdAt: "2026-10-28T00:00:00Z",
  items: [{
    id: "item_1", originalText: quote, sectionHint: "项目经历", riskLevel: "medium", riskType: "scope_ambiguity",
    interviewerRoast: "请核对验证范围，不能仅凭原文确认结果", deadlyQuestions: ["个人负责哪些部分？", "如何验证结果？"],
    defensePlan: { interviewerIntent: "核对个人分工与验证范围", standardDefense: "假设使用缓存；[待补充：真实方案]", tabooMistakes: ["将假设当作实际经历"] },
  }],
};

test("手机报告和抽屉保留原始引用，参考可改写且85分不显示为最高档", async ({ page }, testInfo) => {
  await mockApi(page);
  const submitted: Record<string, unknown>[] = [];
  await page.route("**/api/tools/resume-defenses/9010", (route) => route.fulfill({ json: { report, drills: [] } }));
  const answer = "我只负责接口校验，尚未上线，没有验证缓存收益。";
  const result: DefenseDrillRecord = {
    id: 9020, defenseId: report.id, itemId: "item_1", question: "如何验证结果？", userAnswer: answer,
    interviewerRoast: "说明了真实边界", defenseScore: 85, defenseCritique: "验证结果仍待确认",
    improvedAnswer: "我仅负责接口校验，项目尚未上线，结果待验证。", createdAt: "2026-10-28", updatedAt: "2026-10-28",
  };
  await page.route("**/api/tools/resume-defenses/9010/drill", async (route) => {
    submitted.push(route.request().postDataJSON());
    await route.fulfill({ json: result });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tools/defense/9010");
  await expect(page.getByRole("heading", { name: report.title })).toBeVisible();
  await expect(page.getByText(report.items[0]!.interviewerRoast, { exact: true })).toBeVisible();
  await page.getByText("核对原始引用", { exact: true }).click();
  await expect(page.getByLabel("原始引用", { exact: true })).toHaveText(quote);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await page.evaluate(() => Object.hasOwn(window, "__defenseProbe"))).toBe(false);
  await page.screenshot({ path: testInfo.outputPath("defense-report-mobile.png"), fullPage: true });
  await page.getByRole("button", { name: "即刻防御演练" }).click();
  const dialog = page.getByRole("dialog", { name: "即时防御演练场" });
  await dialog.getByText("核对原始引用", { exact: true }).click();
  await expect(dialog.getByLabel("原始引用", { exact: true })).toHaveText(quote);
  await dialog.getByRole("button", { name: "填入练习参考" }).click();
  const input = dialog.getByRole("textbox", { name: "你的练习回答：", exact: true });
  await expect(input).toHaveValue(report.items[0]!.defensePlan.standardDefense);
  expect(submitted).toEqual([]);
  await input.fill(answer);
  await dialog.getByRole("button", { name: /如何验证结果/ }).click();
  await dialog.getByRole("button", { name: "提交练习回答" }).click();
  await expect(dialog.getByText("核心回答正确，部分待澄清（85分）", { exact: true })).toBeVisible();
  await expect(dialog.getByText(result.improvedAnswer, { exact: true })).toBeVisible();
  await dialog.getByText(result.improvedAnswer, { exact: true }).scrollIntoViewIfNeeded();
  expect(submitted).toEqual([{ itemId: "item_1", question: result.question, userAnswer: answer, defensePlan: report.items[0]!.defensePlan.standardDefense }]);
  await expect(dialog.getByText(/满分示范|坚不可摧|真实动机|被抓包/)).toHaveCount(0);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("defense-drill-mobile.png"), fullPage: true });
});

test("手机历史的低风险空报告仅表示本次未发现问题，不宣称风险可控", async ({ page }, testInfo) => {
  await mockApi(page);
  let generationCalls = 0;
  const clean = { ...report, riskLevel: "low", items: [], overallRoast: "本次未发现明确问题，审阅范围有限" };
  await page.route("**/api/tools/resume-defenses", async (route) => {
    if (route.request().method() === "POST") generationCalls++;
    await route.fulfill({ json: { items: [{ ...clean, itemCount: 0 }] } });
  });
  await page.route("**/api/tools/resume-defenses/9010", (route) => route.fulfill({ json: { report: clean, drills: [] } }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tools/defense");
  await expect(page.getByText("本次未发现明确问题", { exact: true })).toBeVisible();
  await expect(page.getByText("0 条待核实表述", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("defense-history-mobile.png"), fullPage: true });
  await page.getByRole("link", { name: new RegExp(report.title) }).click();
  await expect(page.getByText("本次未发现明确问题", { exact: true })).toBeVisible();
  await expect(page.getByText(clean.overallRoast, { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "即刻防御演练" })).toHaveCount(0);
  await expect(page.getByText(/风险可控|相对严密|破绽百出/)).toHaveCount(0);
  expect(generationCalls).toBe(0);
});

test("输入预算错误保留粘贴原文和岗位，可缩短重试", async ({ page }) => {
  await mockApi(page);
  const submitted: Record<string, unknown>[] = [];
  await page.route("**/api/tools/resume-defenses", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ json: { items: [] } });
      return;
    }
    submitted.push(route.request().postDataJSON());
    if (submitted.length === 1) await route.fulfill({ status: 413, json: { error: "完整模型输入超过 64000 字符，请缩短后重试" } });
    else await route.fulfill({ json: { id: report.id } });
  });
  await page.route("**/api/tools/resume-defenses/9010", (route) => route.fulfill({ json: { report, drills: [] } }));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tools/defense");
  await page.getByRole("button", { name: "自由粘贴文本", exact: true }).click();
  const source = page.getByRole("textbox", { name: "粘贴简历内容或项目片段：", exact: true });
  const role = page.getByRole("textbox", { name: "目标应聘岗位 / 级别定位（选填）：", exact: true });
  await source.fill(quote);
  await role.fill("接口工程师");
  await page.getByRole("button", { name: "开始简历排雷扫描", exact: true }).click();
  await expect(page.getByText("完整模型输入超过 64000 字符，请缩短后重试", { exact: true })).toBeVisible();
  await expect(source).toHaveValue(quote);
  await expect(role).toHaveValue("接口工程师");
  await source.fill("我只负责接口校验，尚未上线。");
  await page.getByRole("button", { name: "开始简历排雷扫描", exact: true }).click();
  await expect(page).toHaveURL("/tools/defense/9010");
  expect(submitted).toEqual([
    { resumeContent: quote, targetRole: "接口工程师" },
    { resumeContent: "我只负责接口校验，尚未上线。", targetRole: "接口工程师" },
  ]);
});

test("手机端修改原答或问题即停用旧点评，恢复原答可查看，重新提交评分对应新稿", async ({ page }) => {
  await mockApi(page);
  const original: DefenseDrillRecord = {
    id: 9020, defenseId: report.id, itemId: "item_1", question: report.items[0]!.deadlyQuestions[0]!, userAnswer: "已评分的旧原答",
    interviewerRoast: "旧原答对应点评", defenseScore: 85, defenseCritique: "旧原答待澄清项", improvedAnswer: "旧原答改进参考",
    createdAt: "2026-10-28", updatedAt: "2026-10-28",
  };
  await page.route("**/api/tools/resume-defenses/9010", (route) => route.fulfill({ json: { report, drills: [original] } }));
  const submitted: Record<string, unknown>[] = [];
  await page.route("**/api/tools/resume-defenses/9010/drill", async (route) => {
    const body = route.request().postDataJSON();
    submitted.push(body);
    await route.fulfill({ json: { ...original, question: body.question, userAnswer: body.userAnswer, defenseScore: 92, interviewerRoast: "新原答对应点评" } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tools/defense/9010");
  await page.getByRole("button", { name: "查看/重做对练" }).click();
  const dialog = page.getByRole("dialog", { name: "即时防御演练场" });
  const input = dialog.getByRole("textbox", { name: "你的练习回答：", exact: true });
  await expect(dialog.getByText(original.interviewerRoast, { exact: true })).toBeVisible();
  await input.fill("新的真实分工说明");
  await expect(dialog.getByText(original.interviewerRoast, { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("status")).toHaveText("问题或回答已修改，请重新提交评估。");
  await input.fill(original.userAnswer);
  await expect(dialog.getByText(original.interviewerRoast, { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: /如何验证结果/ }).click();
  await expect(dialog.getByText(original.interviewerRoast, { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "填入练习参考", exact: true }).click();
  await expect(input).toHaveValue(report.items[0]!.defensePlan.standardDefense);
  expect(submitted).toEqual([]);
  await input.fill("新原答说明尚未验证结果");
  await dialog.getByRole("button", { name: "提交练习回答", exact: true }).click();
  await expect(dialog.getByText("回答充分（92分）", { exact: true })).toBeVisible();
  await expect(dialog.getByText("新原答对应点评", { exact: true })).toBeVisible();
  expect(submitted).toEqual([{ itemId: "item_1", question: "如何验证结果？", userAnswer: "新原答说明尚未验证结果", defensePlan: report.items[0]!.defensePlan.standardDefense }]);
});

test("首次评估等待期间继续键入的草稿保留，旧响应不冒充新草稿评分", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/tools/resume-defenses/9010", (route) => route.fulfill({ json: { report, drills: [] } }));
  const pending = gate();
  const submitted: Record<string, unknown>[] = [];
  await page.route("**/api/tools/resume-defenses/9010/drill", async (route) => {
    const body = route.request().postDataJSON();
    submitted.push(body);
    if (submitted.length === 1) await pending.promise;
    await route.fulfill({ json: {
      id: 9020, defenseId: report.id, itemId: "item_1", question: body.question, userAnswer: body.userAnswer,
      interviewerRoast: `点评_${body.userAnswer}`, defenseScore: 85, defenseCritique: "仍需核实", improvedAnswer: "按事实补充",
      createdAt: "2026-10-28", updatedAt: "2026-10-28",
    } });
  });
  await page.goto("/tools/defense/9010");
  await page.getByRole("button", { name: "即刻防御演练" }).click();
  const dialog = page.getByRole("dialog", { name: "即时防御演练场" });
  const input = dialog.getByRole("textbox", { name: "你的练习回答：", exact: true });
  await input.fill("首次原答");
  await dialog.getByRole("button", { name: "提交练习回答", exact: true }).click();
  await expect(dialog.getByRole("status").filter({ hasText: "正在评估本次回答…" })).toBeVisible();
  await input.focus();
  await input.press("Control+End");
  await input.pressSequentially("；等待期间补充：只负责联调");
  const updated = "首次原答；等待期间补充：只负责联调";
  await expect(input).toHaveValue(updated);
  pending.release();
  await expect(dialog.getByText("问题或回答已修改，请重新提交评估。", { exact: true })).toBeVisible();
  await expect(input).toHaveValue(updated);
  await expect(dialog.getByText("点评_首次原答", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "提交练习回答", exact: true }).click();
  await expect(dialog.getByText(`点评_${updated}`, { exact: true })).toBeVisible();
  expect(submitted.map((body) => body.userAnswer)).toEqual(["首次原答", updated]);
});
