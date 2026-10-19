import { expect, test, type Locator, type Page } from "@playwright/test";
import type { Application } from "../../src/lib/applications-types";
import { gate, mockApi } from "./synthetic-api";

test("outline entries can be located with Enter and Space", async ({ page }) => {
  const api = await mockApi(page);
  api.resume().modules.push({
    key: "work", type: "work", label: "工作经历", sort: 2,
    content: [{ company: "键盘公司", title: "工程师", start: "", end: "" }],
  });
  await page.goto("/resumes/9001");

  for (const key of ["Enter", "Space"]) {
    await page.getByRole("button", { name: /大纲排序/ }).click();
    const entry = page.getByRole("button", { name: /键盘公司/ });
    await entry.focus();
    await expect(entry).toBeFocused();
    await entry.press(key);
    await expect(entry).toBeHidden();
    await expect(page.getByRole("tab", { name: "工作经历", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('[data-resume-module="work"] [data-resume-entry="0"]'))
      .toHaveClass(/resume-highlight-pulse/);
  }
});

for (const reducedMotion of ["no-preference", "reduce"] as const) {
  test(`mobile outline entry opens its editor and focuses the target (${reducedMotion})`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    await page.setViewportSize({ width: 390, height: 844 });
    const api = await mockApi(page);
    api.resume().modules.push({
      key: "work", type: "work", label: "工作经历", sort: 2,
      content: [{ company: "键盘公司", title: "工程师", start: "", end: "" }],
    });
    await page.goto("/resumes/9001");
    await page.getByRole("button", { name: /简历预览/ }).click();
    await page.getByRole("button", { name: /大纲排序/ }).click();
    await page.getByRole("button", { name: /键盘公司/ }).click();

    await expect(page.getByRole("tab", { name: "工作经历", exact: true })).toBeVisible();
    const card = page.locator('[data-edit-card-index="0"]');
    await expect(card).toHaveClass(/resume-highlight-pulse/);
    await expect(card.locator("input").first()).toBeFocused();
  });
}

test("spacing sliders expose their visible names and support keyboard changes", async ({ page }) => {
  await mockApi(page);
  await page.goto("/resumes/9001");
  await page.getByRole("button", { name: /排版微调/ }).click();
  for (const name of ["模块间距", "经历条目间距", "页面边距 (上下左右)", "正文行高", "正文字号"]) {
    await expect(page.getByRole("slider", { name, exact: true })).toBeVisible();
  }
  const margin = page.getByRole("slider", { name: "页面边距 (上下左右)" });
  const previous = Number(await margin.inputValue());
  await margin.focus();
  await margin.press("ArrowRight");
  await expect(margin).toHaveValue(String(previous + 1));
});

async function checkFocusLoop(page: Page, dialog: Locator) {
  const controls = dialog.locator(
    'button:enabled:visible, a[href]:visible, input:enabled:visible, textarea:enabled:visible, select:enabled:visible'
  );
  await controls.last().focus();
  await page.keyboard.press("Tab");
  await expect(controls.first()).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(controls.last()).toBeFocused();
}

async function clickBackdrop(dialog: Locator) {
  await dialog.locator("..").click({ position: { x: 1, y: 1 } });
}

function captureRuntimeErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

function syntheticInterview(finished: boolean, reverseCompleted = false) {
  return {
    id: 9004,
    resume_title: "合成测试简历",
    resume_version_id: 90001,
    resume_version: 1,
    resume_version_name: "测试发布版本",
    jd: "合成前端岗位",
    rounds: 1,
    style: "technical",
    series_id: null,
    round_no: 1,
    series_status: null,
    series_rounds: [],
    status: finished ? "finished" : "ongoing",
    report: null,
    evaluator_report: null,
    reverse_interview: reverseCompleted
      ? {
          question: "团队如何做技术决策？",
          answer: "合成面试官回答",
          evaluation: {
            score: 8,
            level: "优秀",
            insight: "关注团队协作",
            feedback: "问题具体",
            suggestions: "继续追问决策案例",
          },
          created_at: "2026-09-16T00:12:00Z",
        }
      : null,
    created_at: "2026-09-16T00:00:00Z",
    finished_at: finished ? "2026-09-16T00:10:00Z" : "",
    turns: [
      {
        id: 9101,
        idx: 1,
        kind: "question",
        question: "请介绍一个最有挑战的项目。",
        answer: finished ? "合成回答" : "",
        comment: finished ? "合成点评" : "",
        scores: finished
          ? { depth: 8, structure: 8, authenticity: 8, completeness: 8 }
          : null,
        reference: "",
        retries: [],
        answered_at: finished ? "2026-09-16T00:10:00Z" : "",
        notebook_id: null,
      },
    ],
  };
}

const syntheticSalaryNegotiation = {
  id: 9005,
  target_company_tier: "top_tech",
  target_role: "高级前端工程师",
  expected_salary: "35k * 15",
  current_or_competing_offer: "",
  hr_style: "standard",
  status: "ongoing",
  initial_offer: "30k * 14",
  final_package: "",
  report: null,
  created_at: "2026-09-16T00:00:00Z",
  finished_at: "",
  turns: [],
};

const syntheticDefense = {
  report: {
    id: 9006,
    resumeId: 9001,
    resumeVersionId: 90001,
    title: "合成简历排雷报告",
    sourceContent: "负责核心系统性能优化。",
    targetRole: "高级前端工程师",
    riskLevel: "high",
    overallRoast: "量化结论缺少基线。",
    createdAt: "2026-09-16T00:00:00Z",
    items: [
      {
        id: "item_1",
        originalText: "将页面性能提升 50%",
        sectionHint: "项目经历",
        riskLevel: "high",
        riskType: "data_suspicion",
        interviewerRoast: "提升从何而来？",
        deadlyQuestions: ["性能基线、采样范围和验证方法分别是什么？"],
        defensePlan: {
          interviewerIntent: "验证指标真实性",
          standardDefense: "说明采样基线、优化动作和复测方法。",
          tabooMistakes: ["只重复百分比，不解释基线。"],
        },
      },
    ],
  },
  drills: [],
};

test("command palette traps focus, closes from Escape and restores its trigger", async ({ page }) => {
  const runtimeErrors = captureRuntimeErrors(page);
  await mockApi(page);
  await page.goto("/tools");
  const trigger = page.getByRole("button", { name: "全局搜索", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "全局搜索", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("combobox", { name: "搜索关键词", exact: true })).toBeFocused();
  await checkFocusLoop(page, dialog);
  await expect(page.locator("body")).toHaveCSS("overflow", "hidden");
  await dialog.click({ position: { x: 8, y: 8 } });
  await expect(dialog).toBeVisible();
  await clickBackdrop(dialog);
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(runtimeErrors).toEqual([]);
});

test("command palette exposes the active result through aria-activedescendant", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/search**", async (route) => {
    const query = new URL(route.request().url()).searchParams.get("q");
    await route.fulfill({
      json: {
        resumes: query === "第二" ? [{ id: 9001, title: "第二份简历", updated_at: "2026-09-16T00:00:00Z" }] : [
          { id: 9001, title: "第一份简历", updated_at: "2026-09-16T00:00:00Z" },
          { id: 9002, title: "第二份简历", updated_at: "2026-09-16T00:00:00Z" },
        ],
        projects: [],
        questions: [],
        interviews: [],
      },
    });
  });
  await page.goto("/tools");
  await page.getByRole("button", { name: "全局搜索", exact: true }).click();
  const input = page.getByRole("combobox", { name: "搜索关键词", exact: true });
  await input.fill("简历");
  const dialog = page.getByRole("dialog", { name: "全局搜索", exact: true });
  await expect(dialog.getByRole("option")).toHaveCount(2);
  await input.press("ArrowDown");
  const activeId = await input.getAttribute("aria-activedescendant");
  expect(activeId).toBeTruthy();
  await expect(page.locator(`[id="${activeId}"]`)).toHaveAttribute("aria-selected", "true");

  await input.fill("第二");
  await expect(dialog.getByRole("option")).toHaveCount(1);
  const filteredActiveId = await input.getAttribute("aria-activedescendant");
  expect(filteredActiveId).toBeTruthy();
  await expect(page.locator(`[id="${filteredActiveId}"]`)).toHaveAttribute("aria-selected", "true");
});

test("model combobox 区分选中值与键盘光标语义", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/settings/models", (route) =>
    route.fulfill({ json: { ok: true, models: ["gpt-alpha", "gpt-beta"] } })
  );
  await page.goto("/settings");
  await page.getByRole("button", { name: "获取模型列表", exact: true }).click();
  const combo = page.getByRole("combobox", { name: "候选模型", exact: true }).first();
  await combo.click();
  const listbox = page.getByRole("listbox", { name: "候选模型", exact: true }).first();
  await expect(listbox).toBeVisible();

  // 只是输入文本时没有任何「选中项」：选中语义属于已确认的值，键盘光标另由 aria-activedescendant 表达
  await combo.fill("alpha");
  await expect(listbox.getByRole("option")).toHaveCount(1);
  const filteredActiveId = await combo.getAttribute("aria-activedescendant");
  expect(filteredActiveId).toBeTruthy();
  await expect(listbox.getByRole("option", { name: "gpt-alpha", exact: true })).toHaveAttribute(
    "aria-selected",
    "false"
  );

  // 移动键盘光标同样不产生选中项
  await combo.fill("g");
  await expect(listbox.getByRole("option")).toHaveCount(2);
  await combo.press("ArrowDown");
  const activeId = await combo.getAttribute("aria-activedescendant");
  expect(activeId).toBeTruthy();
  await expect(page.locator(`[id="${activeId}"]`)).toHaveAttribute("aria-selected", "false");

  // 真正选定某个候选后，该选项才带 aria-selected
  await combo.fill("beta");
  await expect(listbox.getByRole("option")).toHaveCount(1);
  await listbox.getByRole("option", { name: "gpt-beta", exact: true }).click();
  // 已选值在浮层展示，搜索框保持为空；重开后的选中语义仍由父级值驱动。
  await expect(combo).toHaveValue("");
  await expect(combo.locator("..").getByText("gpt-beta", { exact: true })).toBeVisible();
  await combo.click();
  await expect(listbox.getByRole("option", { name: "gpt-beta", exact: true })).toHaveAttribute(
    "aria-selected",
    "true"
  );

  await combo.fill("no-match");
  await expect(listbox.getByText("无匹配模型", { exact: false })).toBeVisible();
  await expect(combo).not.toHaveAttribute("aria-activedescendant");
});

test("notebook dialog keeps card clicks open and backdrop clicks close", async ({ page }) => {
  const runtimeErrors = captureRuntimeErrors(page);
  await mockApi(page);
  await page.route("**/api/notebook/categories", (route) => route.fulfill({ json: [] }));
  await page.route(/\/api\/notebook(?:\?.*)?$/, (route) => route.fulfill({ json: { items: [], nextCursor: null } }));
  await page.goto("/notebook");
  const trigger = page.getByRole("button", { name: "管理错题分类", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "管理分类", exact: true });
  const initial = dialog.getByPlaceholder("新分类名称", { exact: true });
  await expect(initial).toBeFocused();
  await checkFocusLoop(page, dialog);
  await dialog.getByRole("heading", { name: "管理分类", exact: true }).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await clickBackdrop(page.getByRole("dialog", { name: "管理分类", exact: true }));
  await expect(page.getByRole("dialog", { name: "管理分类", exact: true })).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(runtimeErrors).toEqual([]);
});

test("reverse interview choice and input dialogs follow their real flow", async ({ page }) => {
  const runtimeErrors = captureRuntimeErrors(page);
  await mockApi(page);
  let finished = false;
  let reverseCompleted = false;
  const reverseRequest = gate();
  await page.route("**/api/interviews/9004", (route) =>
    route.fulfill({ json: syntheticInterview(finished, reverseCompleted) })
  );
  await page.route("**/api/interviews/9004/answer", async (route) => {
    finished = true;
    await route.fulfill({
      contentType: "text/event-stream",
      body: 'event: done\ndata: {"natural_finished":true}\n\n',
    });
  });
  await page.route("**/api/interviews/9004/finish", (route) => route.fulfill({ json: {} }));
  await page.route("**/api/interviews/9004/reverse", async (route) => {
    await reverseRequest.promise;
    reverseCompleted = true;
    await route.fulfill({
      json: {
        question: "团队如何做技术决策？",
        answer: "合成面试官回答",
        evaluation: {
          score: 8,
          level: "优秀",
          insight: "关注团队协作",
          feedback: "问题具体",
          suggestions: "继续追问决策案例",
        },
      },
    });
  });
  await page.goto("/interviews/9004");
  await page.locator('textarea[placeholder^="建议采用分点阐述"]').fill("合成回答");
  await page.getByRole("button", { name: "提交回答", exact: true }).click();

  const choice = page.getByRole("dialog", { name: "主提问环节已全部完成！", exact: true });
  await expect(choice).toBeVisible();
  await expect(choice.getByRole("button", { name: "跳过，直接生成报告", exact: true })).toBeFocused();
  await checkFocusLoop(page, choice);
  await choice.getByRole("button", { name: "进入反问环节", exact: true }).click();
  await expect(choice).toBeHidden();
  const inputDialog = page.getByRole("dialog", { name: "向面试官提问", exact: true });
  await expect(inputDialog).toBeVisible();
  await expect(inputDialog.getByPlaceholder("输入您想向面试官了解的问题…", { exact: true })).toBeFocused();
  await inputDialog.getByRole("heading", { name: "向面试官提问", exact: true }).click();
  await expect(inputDialog).toBeVisible();
  await clickBackdrop(inputDialog);
  await expect(inputDialog).toBeHidden();

  const trigger = page.getByRole("button", { name: /进入反问环节/ });
  await trigger.click();
  const question = inputDialog.getByPlaceholder("输入您想向面试官了解的问题…", { exact: true });
  await expect(question).toBeFocused();
  await checkFocusLoop(page, inputDialog);
  await inputDialog.getByRole("heading", { name: "向面试官提问", exact: true }).click();
  await expect(inputDialog).toBeVisible();
  await clickBackdrop(inputDialog);
  await expect(inputDialog).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await question.fill("团队如何做技术决策？");
  await inputDialog.getByRole("button", { name: "向面试官提问", exact: true }).click();
  await expect(inputDialog.getByRole("button", { name: "面试官思考与评估中…", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await clickBackdrop(inputDialog);
  await expect(inputDialog).toBeVisible();
  reverseRequest.release();
  await expect(inputDialog).toBeHidden();
  await expect(page.getByText("合成面试官回答", { exact: true }).first()).toBeVisible();
  expect(runtimeErrors).toEqual([]);
});

test("salary finalize dialog cannot close while report generation is pending", async ({ page }) => {
  const runtimeErrors = captureRuntimeErrors(page);
  await mockApi(page);
  const finalizeRequest = gate();
  await page.route("**/api/tools/salary-negotiations/9005", (route) =>
    route.fulfill({ json: syntheticSalaryNegotiation })
  );
  await page.route("**/api/tools/salary-negotiations/9005/finalize", async (route) => {
    await finalizeRequest.promise;
    await route.fulfill({
      json: {
        status: "finished",
        final_package: "34k * 15",
        report: {
          final_package_summary: "34k * 15",
          persuasion_grade: "A",
          score: 88,
          leverage_efficiency: "核心筹码得到有效转化。",
          turn_critiques: [],
          real_world_tips: ["确认书面 offer 后再安排离职。"],
          mentor_summary: "节奏稳健，边界清晰。",
        },
      },
    });
  });
  await page.goto("/tools/salary/9005");
  const trigger = page.getByRole("button", { name: "达成共识 / 结束复盘", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "达成一致 · 结束并生成复盘报告", exact: true });
  const initial = dialog.getByRole("textbox", { name: "最终确认表态（可选）", exact: true });
  await expect(initial).toBeFocused();
  await checkFocusLoop(page, dialog);
  await dialog.getByRole("heading", { name: "达成一致 · 结束并生成复盘报告", exact: true }).click();
  await expect(dialog).toBeVisible();
  await clickBackdrop(dialog);
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  await trigger.click();
  await dialog.getByRole("button", { name: "确认封板并生成报告", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "正在生成复盘报告…", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await clickBackdrop(dialog);
  await expect(dialog).toBeVisible();
  finalizeRequest.release();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("🏆 薪酬谈判终局复盘报告", { exact: true })).toBeVisible();
  expect(runtimeErrors).toEqual([]);
});

test("defense drill drawer is a named dialog with contained focus", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const runtimeErrors = captureRuntimeErrors(page);
  await mockApi(page);
  await page.route("**/api/tools/resume-defenses/9006", (route) =>
    route.fulfill({ json: syntheticDefense })
  );
  await page.goto("/tools/defense/9006");
  const trigger = page.getByRole("button", { name: /即刻防御演练/ });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "即时防御演练场", exact: true });
  await expect(dialog.getByRole("button", { name: "关闭", exact: true })).toBeFocused();
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  if (!box) throw new Error("对话框没有可测量的布局盒");
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.y + box.height).toBeLessThanOrEqual(844);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await dialog.locator("button").evaluateAll((buttons) =>
    buttons.filter((button) => !(
      button.getAttribute("aria-label") ||
      button.getAttribute("aria-labelledby") ||
      button.getAttribute("title") ||
      button.textContent?.trim()
    )).length
  )).toBe(0);
  await checkFocusLoop(page, dialog);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();

  await page.setViewportSize({ width: 1024, height: 844 });
  await trigger.click();
  await dialog.getByText("被抓包的原句", { exact: true }).click();
  await expect(dialog).toBeVisible();
  await clickBackdrop(dialog);
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(runtimeErrors).toEqual([]);
});

test("add module dialog loops keyboard focus and restores its trigger", async ({ page }) => {
  await mockApi(page);
  await page.goto("/resumes/9001");
  const trigger = page.getByRole("tablist").getByRole("button", { name: "+ 添加模块", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "添加模块", exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("input")).toBeFocused();
  await checkFocusLoop(page, dialog);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("knowledge and bank primary inputs have persistent accessible labels", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(page);

  await page.goto("/knowledge");
  await expect(page.getByRole("textbox", { name: "项目名称", exact: true })).toBeVisible();

  await page.goto("/bank");
  await expect(page.getByRole("textbox", { name: "导入考题", exact: true })).toBeVisible();
});

test("application dialog has a name, ten associated labels and restores keyboard focus", async ({ page }) => {
  await mockApi(page);
  await page.goto("/applications");
  const trigger = page.getByRole("button", { name: "登记新投递" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "新建求职投递", exact: true });
  await expect(dialog).toBeVisible();
  const labels = ["公司名称", "目标岗位", "当前阶段", "薪资范围", "关联简历", "下次面试时间", "关联单轮模拟面试", "关联进阶多轮面试", "岗位 JD", "投递备注"];
  for (const label of labels) await expect(dialog.getByLabel(new RegExp(label))).toHaveCount(1);
  await expect(dialog.getByRole("button", { name: "下次面试时间 (约面/待面)", exact: true })).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: /公司名称/ })).toBeFocused();
  await checkFocusLoop(page, dialog);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("interview round dialog exposes its date-time picker by the visible label", async ({ page }) => {
  const application: Application = {
    flow_status: "active", batch_name: "", hiring_stage: null, stage_changed_at: "", terminal_stage: null, terminal_reason: "", terminal_at: "",
    id: 9002, company: "合成公司", role: "测试岗位", salary_range: "", stage: "interviewing", resume_id: null,
    jd: "", interview_id: null, interview_series_id: null, next_interview_at: "", notes: "",
    created_at: "2026-09-16T00:00:00Z", updated_at: "2026-09-16T00:00:00Z",
  };
  await mockApi(page, [application]);
  await page.goto("/applications");
  await page.getByTitle("添加新面试轮次", { exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /登记新面试轮次/ });
  await expect(dialog.getByLabel("面试时间", { exact: true })).toHaveCount(1);
  await expect(dialog.getByRole("button", { name: "面试时间", exact: true })).toBeVisible();
});

test("clearing date-time by keyboard preserves closed popover and returns focus", async ({ page }) => {
  await mockApi(page);
  await page.goto("/applications");
  await page.getByRole("button", { name: "登记新投递" }).click();
  const dialog = page.getByRole("dialog", { name: "新建求职投递", exact: true });
  const trigger = dialog.getByRole("button", { name: "下次面试时间 (约面/待面)", exact: true });
  await trigger.click();
  await dialog.getByRole("button", { name: "今天10:00" }).click();
  const clear = dialog.getByRole("button", { name: "清除已选时间" });
  await clear.focus();
  await clear.press("Space");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toBeFocused();
  await expect(clear).toHaveCount(0);
});

test("confirmation dialog contains focus and returns it after Escape", async ({ page }) => {
  await mockApi(page);
  await page.goto("/resumes/9001");
  const trigger = page.getByRole("button", { name: "删除模块「基本信息」", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "删除模块", exact: true });
  await expect(dialog.getByRole("button", { name: "取消", exact: true })).toBeFocused();
  await checkFocusLoop(page, dialog);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("mobile navigation receives and traps focus, Escape restores the menu trigger", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockApi(page);
  await page.goto("/tools");
  const trigger = page.getByRole("button", { name: "打开导航菜单", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "导航菜单", exact: true });
  await expect(dialog.getByRole("button", { name: "关闭菜单", exact: true })).toBeFocused();
  await checkFocusLoop(page, dialog);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(await page.locator("body").evaluate((body) => body.style.overflow)).toBe("");
});

for (const [timezoneId, original, displayed] of [
  ["Asia/Shanghai", "2026-09-16T02:00:37.123Z", "2026-09-16T10:00"],
  ["UTC", "2026-09-16T02:00:37.123Z", "2026-09-16T02:00"],
  ["America/New_York", "2026-11-01T06:30:37.123Z", "2026-11-01T01:30"],
] as const) {
  test.describe(`interview time in ${timezoneId}`, () => {
    test.use({ timezoneId });
    test("editing notes keeps the original instant including seconds and DST occurrence", async ({ page }) => {
      const application: Application = {
        flow_status: "active", batch_name: "", hiring_stage: null, stage_changed_at: "", terminal_stage: null, terminal_reason: "", terminal_at: "",
        id: 9002, company: "合成公司", role: "测试岗位", salary_range: "", stage: "interested", resume_id: null,
        jd: "", interview_id: null, interview_series_id: null, next_interview_at: original, notes: "",
        created_at: "2026-09-16T00:00:00Z", updated_at: "2026-09-16T00:00:00Z",
      };
      const api = await mockApi(page, [application]);
      await page.goto("/applications");
      await page.getByTitle("编辑卡片", { exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "编辑求职投递卡片", exact: true });
      const picker = dialog.getByRole("button", { name: "下次面试时间 (约面/待面)", exact: true });
      await expect(picker).toContainText(displayed.replace("T", " "));
      await dialog.getByRole("textbox", { name: /投递备注/ }).fill("只修改备注");
      await dialog.getByRole("button", { name: "更新卡片", exact: true }).click();
      await expect.poll(() => api.applicationWrites[0]?.next_interview_at).toBe(original);
    });
  });
}

test("投递页 select 与 textarea 都有可访问名称", async ({ page }) => {
  const application: Application = {
    flow_status: "active", batch_name: "", hiring_stage: null, stage_changed_at: "", terminal_stage: null, terminal_reason: "", terminal_at: "",
    id: 9002, company: "合成公司", role: "测试岗位", salary_range: "", stage: "interested", resume_id: null,
    jd: "", interview_id: null, interview_series_id: null, next_interview_at: "", notes: "",
    created_at: "2026-09-16T00:00:00Z", updated_at: "2026-09-16T00:00:00Z",
  };
  await mockApi(page, [application]);
  await page.goto("/applications");
  // 卡片是异步取数后才挂载的：不等它出现就扫描会得到空集，让断言恒真（守卫空跑，见 R18-b）
  await expect(page.getByTitle("编辑卡片", { exact: true }).first()).toBeVisible();
  const unnamed = await page.evaluate(() => {
    const controls = Array.from(document.querySelectorAll("select, textarea")) as (
      | HTMLSelectElement
      | HTMLTextAreaElement
    )[];
    return controls
      .filter((el) => {
        if (el.getAttribute("aria-label")?.trim()) return false;
        if (el.getAttribute("aria-labelledby")?.trim()) return false;
        if (el.id && document.querySelector(`label[for="${el.id}"]`)) return false;
        return true;
      })
      .map((el) => `${el.tagName.toLowerCase()}[${el.outerHTML.slice(0, 80)}]`);
  });
  expect(unnamed).toEqual([]);
});

test("知识库总结标签可聚焦字段，材料编辑框有名称", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/projects/1", async (route) => {
    await route.fulfill({ json: {
      id: 1, name: "测试项目", summary: {
        overview: "原概述", architecture: "架构", highlights: "亮点",
        responsibilities: "职责", challenges: "难点",
      }, summary_updated_at: "2026-09-16", materials: [
        { id: 1, title: "现有材料", source: "paste", filename: "", content: "材料正文", created_at: "2026-09-16" },
      ],
    } });
  });
  await page.goto("/knowledge/1");
  await expect(page.getByRole("heading", { name: "测试项目" })).toBeVisible();
  for (const label of ["项目概述", "架构设计", "技术亮点", "主要职责", "难点与成果"]) {
    const field = page.getByRole("textbox", { name: label, exact: true });
    await expect(field).toBeVisible();
    await page.getByText(label, { exact: true }).click();
    await expect(field).toBeFocused();
  }
  await page.getByRole("button", { name: "编辑", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "编辑「现有材料」材料正文" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "粘贴材料正文" })).toBeVisible();
  expect(await page.locator("textarea").count()).toBeGreaterThan(0);
});
