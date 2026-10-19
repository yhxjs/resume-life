import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import { mockApi } from "./synthetic-api";
import { publishResume } from "./resume-version-helpers";

test("投递准备聚合资料、复用 JD、持久保存待办和模拟面试归属", async ({ page, request }, testInfo) => {
  test.setTimeout(120_000);
  const baseline = await exportEncryptedBackup(request);
  expect(baseline.response.ok()).toBe(true);
  const reviewPayloads: string[] = [];
  const privateMarkers = ["PRIVATE_REVIEW_NAME", "PRIVATE_REVIEW_PHONE", "PRIVATE_REVIEW_EMAIL", "PRIVATE_REVIEW_ADDRESS"];
  const provider = createServer(async (incoming, outgoing) => {
    let raw = "";
    for await (const chunk of incoming) raw += chunk;
    const body = JSON.parse(raw);
    const system = String(body.messages[0]?.content ?? "");
    if (system.includes("面试复盘教练")) reviewPayloads.push(JSON.stringify(body.messages));
    const reply = system.includes("面试复盘教练") ? {
      mistakes: [{ question_index: 1, gap: "缺少一致性策略", improved_answer: "说明缓存失效和回源保护" }],
      drills: [{ question_index: 1, question: "缓存击穿时如何保护数据库？" }],
      resume_suggestions: [{ question_index: 1, suggestion: "补充缓存优化的量化结果" }],
    } : system.includes("自我介绍") ? { versions: [
      { kind: "30s", sentences: [{ text: "我擅长 React 和可访问性。", comment: "技术定位清楚" }] },
      { kind: "2min", sentences: [{ text: "我在项目中优化了交互与性能。", comment: "补充成果" }] },
    ] } : system.includes("资深技术招聘专家") ? { match: 7, summary: "突出岗位相关成果", modules: [{ module_key: "summary",
      scores: { depth: 7, structure: 7, authenticity: 8, completeness: 7 }, gaps: "补充业务结果",
      suggestions: [{ item_id: "", field: "text", reason: "对齐岗位", draft: "注重可访问性的前端工程师" }],
    }] } : system.includes("雷达") ? { role: "React 前端开发与工程化", must_skills: [
      { name: "React", weight: 9, why: "岗位要求" }, { name: "TypeScript", weight: 8, why: "岗位要求" }, { name: "测试", weight: 7, why: "岗位要求" },
    ], followups: [{ topic: "组件设计", questions: ["如何划分组件职责？"] }], company_style: { style: "工程导向", signals: ["强调工程质量"] } }
      : { question: "如何设计一个可访问的 React 表单？" };
    outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
    outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(reply) } }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("Missing provider address");
  try {
    expect((await request.put("/api/settings", { data: { base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-preparation-key", api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic" } })).ok()).toBe(true);
    const resume = await request.post("/api/resumes", { data: { title: "准备页验证简历", modules: {
      basic: { name: privateMarkers[0], phone: privateMarkers[1], email: privateMarkers[2], location: privateMarkers[3] },
      summary: { text: "我有前端开发经验" },
    } } });
    expect(resume.status()).toBe(201);
    const resumeId = (await resume.json()).id;
    const version = await publishResume(request, resumeId);
    const jd = "需要 React、TypeScript、可访问性和自动化测试经验。";
    const create = async (company: string) => {
      const response = await request.post("/api/applications", { data: { company, role: "前端工程师", resume_id: resumeId, resume_version_id: version.id, jd } });
      expect(response.status()).toBe(201);
      return (await response.json()).id as number;
    };
    const first = await create("准备页甲公司");
    const second = await create("准备页乙公司");
    const prepareUrl = `/applications/${first}/prepare`;
    await page.goto("/applications");
    await page.locator('[draggable="true"]').filter({ hasText: "准备页甲公司" }).getByRole("link", { name: "投递准备" }).click();
    await expect(page).toHaveURL(new RegExp(`${prepareUrl}$`));
    await expect(page.getByRole("heading", { name: "准备页甲公司 · 前端工程师" })).toBeVisible();
    await page.getByLabel("新待办", { exact: true }).fill("练习 30 秒自我介绍");
    await page.getByRole("button", { name: "添加", exact: true }).click();
    await page.getByRole("checkbox", { name: "练习 30 秒自我介绍" }).check();
    await expect(page.getByRole("status")).toHaveText("更新待办成功");
    await page.reload();
    await expect(page.getByRole("checkbox", { name: "练习 30 秒自我介绍" })).toBeChecked();

    const tasksApi = `**/api/applications/${first}/preparation/tasks`;
    await page.route(tasksApi, (route) => route.fulfill({ status: 503, json: { error: "待办保存失败，请重试" } }));
    await page.getByRole("checkbox", { name: "练习 30 秒自我介绍" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "待办保存失败，请重试" })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "练习 30 秒自我介绍" })).toBeChecked();
    await page.unroute(tasksApi);
    await page.reload();
    await expect(page.getByRole("checkbox", { name: "练习 30 秒自我介绍" })).toBeChecked();

    await page.getByRole("button", { name: "生成简历诊断", exact: true }).click();
    await expect(page.getByRole("region", { name: "简历诊断", exact: true })).toContainText("突出岗位相关成果");
    await page.getByRole("button", { name: "生成自我介绍", exact: true }).click();
    await expect(page.getByRole("region", { name: "自我介绍", exact: true })).toContainText("我擅长 React 和可访问性。");
    await page.getByRole("button", { name: "生成JD 考点画像", exact: true }).click();
    await expect(page.getByRole("region", { name: "JD 考点画像", exact: true })).toContainText("React 前端开发与工程化");
    await page.getByRole("region", { name: "自我介绍", exact: true }).getByRole("link", { name: "查看记录" }).click();
    await expect(page.getByText("我擅长 React 和可访问性。", { exact: true })).toBeVisible();
    await page.getByRole("link", { name: "返回投递准备" }).click();

    await page.getByRole("button", { name: "查看简历诊断", exact: true }).click();
    await page.getByRole("link", { name: "到简历中采纳建议" }).click();
    const diagnostic = page.getByRole("dialog", { name: "对 JD 体检诊断简历" });
    await expect(diagnostic.getByText("突出岗位相关成果", { exact: true })).toBeVisible();
    await diagnostic.getByRole("button", { name: "按所选发布版本再次诊断", exact: true }).click();
    await expect(diagnostic.getByText("岗位匹配度：7 → 7（持平）", { exact: true })).toBeVisible();
    await diagnostic.getByRole("button", { name: "完成并关闭", exact: true }).click();
    await page.getByRole("link", { name: "返回投递准备" }).click();
    await expect(page.getByRole("button", { name: "查看简历诊断", exact: true })).toHaveCount(2);

    await page.getByRole("button", { name: "记面试", exact: true }).click();
    await page.getByPlaceholder("可记录面试官重点关心的项目、遇到的难点提问、待补充资料等...").fill("准备分享组件库的架构取舍");
    await page.getByRole("button", { name: "确认添加", exact: true }).click();
    await expect(page.getByRole("region", { name: "真实面试记录" })).toContainText("准备分享组件库的架构取舍");

    await page.getByRole("region", { name: "真实面试记录" }).getByRole("button", { name: "逐题复盘" }).click();
    const review = page.getByRole("dialog", { name: "逐题复盘 · 一面" });
    await review.getByRole("button", { name: "添加题目" }).click();
    await review.getByRole("textbox", { name: "问了什么" }).fill("如何处理高并发？");
    await review.getByRole("textbox", { name: "怎么回答" }).fill("用了缓存");
    await review.getByRole("textbox", { name: "卡在哪里" }).fill("一致性没讲清");
    await review.getByRole("textbox", { name: "对方反馈" }).fill("继续解释");
    await review.getByRole("button", { name: "保存逐题记录" }).click();
    await expect(review.getByText("逐题记录已保存")).toBeVisible();
    await review.getByRole("button", { name: "确认并生成复盘" }).click();
    await expect(review.getByText("缓存击穿时如何保护数据库？")).toBeVisible();
    await expect(review.getByText("补充缓存优化的量化结果")).toBeVisible();
    await review.getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("region", { name: "真实面试记录" }).getByRole("button", { name: "逐题复盘" }).click();
    await expect(page.getByRole("dialog", { name: "逐题复盘 · 一面" }).getByText("缺少一致性策略")).toBeVisible();
    const realRound = (await (await request.get(`/api/applications/${first}/interviews`)).json())[0];
    const reviewRecord = await (await request.get(`/api/applications/${first}/interviews/${realRound.id}/review`)).json();
    expect(reviewRecord.latest).toMatchObject({ application_id: first, interview_id: realRound.id });
    await expect(review.getByRole("button", { name: "确认并生成复盘" })).toBeDisabled();
    await page.getByRole("dialog", { name: "逐题复盘 · 一面" }).getByRole("button", { name: "关闭", exact: true }).click();

    const changedJd = `${jd} 补充缓存一致性要求。`;
    expect((await request.patch(`/api/applications/${first}`, { data: { jd: changedJd } })).ok()).toBe(true);
    await page.reload();
    await page.getByRole("region", { name: "真实面试记录" }).getByRole("button", { name: "逐题复盘" }).click();
    await expect(review.getByRole("button", { name: "确认并生成复盘" })).toBeEnabled();
    await expect(review.getByText("缺少一致性策略")).toBeVisible();
    await review.getByRole("button", { name: "确认并生成复盘" }).click();
    await expect(review.getByText("复盘结果已保存")).toBeVisible();
    await expect(review.getByRole("button", { name: "确认并生成复盘" })).toBeDisabled();
    const regenerated = await (await request.get(`/api/applications/${first}/interviews/${realRound.id}/review`)).json();
    expect(regenerated.latest.id).not.toBe(reviewRecord.latest.id);
    expect(regenerated.history).toHaveLength(2);
    expect(reviewPayloads).toHaveLength(2);
    expect(reviewPayloads[1]).toContain(changedJd);
    for (const payload of reviewPayloads) {
      expect(payload).toContain("我有前端开发经验");
      for (const marker of privateMarkers) expect(payload).not.toContain(marker);
    }
    await review.getByRole("button", { name: "关闭", exact: true }).click();
    expect((await request.patch(`/api/applications/${first}`, { data: { jd } })).ok()).toBe(true);
    await page.reload();

    await page.getByRole("link", { name: "发起模拟面试" }).click();
    await expect(page.getByRole("combobox", { name: "关联简历", exact: true })).toHaveValue(String(resumeId));
    await expect(page.getByRole("combobox", { name: "关联简历", exact: true })).toBeDisabled();
    await expect(page.getByRole("combobox", { name: "已发布版本", exact: true })).toHaveValue(String(version.id));
    await expect(page.getByRole("combobox", { name: "已发布版本", exact: true })).toBeDisabled();
    await expect(page.getByRole("textbox", { name: "目标岗位要求（JD / 职位描述）" })).toHaveValue(jd);
    await page.getByRole("button", { name: "立即开启模拟实战", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/interviews/\\d+\\?applicationId=${first}$`));
    const interviewId = Number(new URL(page.url()).pathname.split("/").at(-1));
    const interview = await (await request.get(`/api/interviews/${interviewId}`)).json();
    expect(interview.resume_version_id).toBe(version.id);
    expect((await request.post("/api/notebook", { data: { source: "interview", source_id: interview.turns[0].id } })).status()).toBe(201);
    await page.getByRole("link", { name: "返回投递准备" }).click();
    await page.getByRole("button", { name: "查看错题", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "错题回顾" })).toContainText("如何设计一个可访问的 React 表单？");
    await page.getByRole("dialog", { name: "错题回顾" }).getByRole("button", { name: "关闭", exact: true }).click();

    const prepared = await (await request.get(`/api/applications/${first}/preparation`)).json();
    expect(prepared.resources.diagnosis.total).toBe(2);
    expect(prepared.resources.intro.total).toBe(1);
    expect(prepared.resources.portrait.total).toBe(1);
    expect(prepared.resources.interview.total).toBe(1);
    expect(prepared.resources.notebook.total).toBe(1);
    const unrelated = await (await request.get(`/api/applications/${second}/preparation`)).json();
    expect(unrelated.resources.intro.total).toBe(0);
    expect(unrelated.tasks).toHaveLength(0);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await page.screenshot({ path: testInfo.outputPath("preparation-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("preparation-mobile.png"), fullPage: true });

    await page.goto(`/applications/${second}/prepare`);
    await page.getByRole("button", { name: "关联已有自我介绍", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "关联已有自我介绍" });
    await picker.getByRole("button", { name: "关联", exact: true }).first().click();
    await expect(picker).not.toBeVisible();
    await expect(page.getByRole("region", { name: "自我介绍", exact: true })).toContainText("我擅长 React 和可访问性。");
    await page.getByRole("region", { name: "自我介绍", exact: true }).getByRole("button", { name: "取消关联" }).click();
    await expect(page.getByRole("region", { name: "自我介绍", exact: true })).toContainText("暂无自我介绍");
  } finally {
    const restored = await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes);
    expect(restored.status()).toBe(200);
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  }
});

test("进阶面试总览、轮次切换及推进始终保留投递准备入口", async ({ page }) => {
  await mockApi(page);
  const candidate = { depth: 7, structure: 7, authenticity: 7, completeness: 7, jd_match: 7, overall: 7, strengths: "项目经验", weaknesses: "补充证据", suggestions: "继续练习" };
  const rounds = [
    { id: 9101, round_no: 1, style: "deep", status: "finished", report: candidate, overall: 7 },
    { id: 9102, round_no: 2, style: "manager", status: "ongoing", report: null, overall: null },
  ];
  const advances: string[] = [];
  await page.route("**/api/interviews/series/9100**", async (route) => {
    if (route.request().method() === "POST") {
      advances.push(new URL(route.request().url()).pathname);
      return route.fulfill({ json: { id: 9102 } });
    }
    return route.fulfill({ json: {
      id: 9100, resume_title: "合成简历", resume_version_id: 90001, resume_version: 1, resume_version_name: "测试发布版本", jd: "合成岗位", rounds: 1, rounds_total: 3,
      status: "ongoing", created_at: "2026-09-27T00:00:00Z", finished_at: "", final_report: null,
      entries: [{ ...rounds[0], interview_id: 9101, rounds: 1, answered: 1 }],
    } });
  });
  await page.route(/\/api\/interviews\/910[12]$/, async (route) => {
    const current = rounds.find((round) => round.id === Number(new URL(route.request().url()).pathname.split("/").at(-1)))!;
    return route.fulfill({ json: {
      ...current, resume_title: "合成简历", resume_version_id: 90001, resume_version: 1, resume_version_name: "测试发布版本", jd: "合成岗位", rounds: 1, series_id: 9100,
      series_status: "ongoing", series_rounds: current.round_no === 1 ? [rounds[0]] : rounds,
      evaluator_report: null, reverse_interview: null, created_at: "2026-09-27T00:00:00Z",
      finished_at: current.round_no === 1 ? "2026-09-27T00:01:00Z" : "", turns: [],
    } });
  });
  await page.goto("/interviews/series/9100?applicationId=9200");
  await page.getByRole("link", { name: /ROUND 01/ }).click();
  await expect(page).toHaveURL(/\/interviews\/9101\?applicationId=9200$/);
  await expect(page.getByRole("link", { name: "返回投递准备" })).toHaveAttribute("href", "/applications/9200/prepare");
  await page.getByRole("button", { name: "进入 二面 · 主管面", exact: true }).click();
  await expect(page).toHaveURL(/\/interviews\/9102\?applicationId=9200$/);
  await page.getByRole("link", { name: "一面 · 技术面 (7分)", exact: true }).click();
  await expect(page).toHaveURL(/\/interviews\/9101\?applicationId=9200$/);
  await page.getByRole("link", { name: "连环面总览" }).click();
  await expect(page).toHaveURL(/\/interviews\/series\/9100\?applicationId=9200$/);
  await page.getByRole("button", { name: "进入 二面 · 主管面 →", exact: true }).click();
  await expect(page).toHaveURL(/\/interviews\/9102\?applicationId=9200$/);
  await expect(page.getByRole("link", { name: "返回投递准备" })).toHaveAttribute("href", "/applications/9200/prepare");
  expect(advances).toEqual(["/api/interviews/series/9100/advance", "/api/interviews/series/9100/advance"]);
});
