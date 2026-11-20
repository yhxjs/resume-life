import { createServer } from "node:http";
import { expect, test } from "@playwright/test";
import { listenForFetch } from "../support/http-server";
import { publishResume } from "./resume-version-helpers";

test("上场计划检查缺项、逐项生成与练习，刷新后保留独立岗位进度", async ({ page, request }, testInfo) => {
  test.setTimeout(90_000);
  const modelInputs: string[] = [];
  const provider = createServer(async (incoming, outgoing) => {
    let raw = "";
    for await (const chunk of incoming) raw += chunk;
    modelInputs.push(raw);
    const portrait = { role: "前端工程师", must_skills: [{ name: "React", weight: 9, why: "JD 明确要求 React" }], followups: [{ topic: "组件状态", questions: ["组件状态应放在哪里？"] }], company_style: { style: "未明确", signals: [] } };
    outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
    outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(portrait) } }] })}\n\ndata: [DONE]\n\n`);
  });
  await listenForFetch(provider);
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("Missing provider address");
  try {
    expect((await request.put("/api/settings", { data: { base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-plan-key", api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic" } })).ok()).toBe(true);
    const resume = await request.post("/api/resumes", { data: { title: "计划简历", modules: { summary: { text: "前端工程经验" } } } });
    expect(resume.status()).toBe(201);
    const resumeId = (await resume.json()).id;
    const version = await publishResume(request, resumeId);
    const jd = "本岗位负责 React 组件开发，要求 TypeScript 经验。";
    const create = async (company: string) => {
      const response = await request.post("/api/applications", { data: { company, role: "前端工程师", jd, resume_id: resumeId, resume_version_id: version.id } });
      expect(response.status()).toBe(201);
      return (await response.json()).id as number;
    };
    const first = await create("上场甲公司");
    const second = await create("上场乙公司");
    await page.goto("/tools");
    await page.getByRole("link", { name: /上场计划/ }).click();
    await page.getByRole("link", { name: /上场甲公司/ }).click();
    await expect(page.getByRole("heading", { name: "上场甲公司 · 前端工程师" })).toBeVisible();
    await page.getByRole("button", { name: /生成本岗位准备清单/ }).click();
    await expect(page.getByRole("region", { name: "准备进度" })).toContainText("待补资料3 项");
    expect(modelInputs).toHaveLength(0);
    const portrait = page.getByRole("listitem", { name: "梳理岗位考点" });
    await portrait.getByRole("button", { name: "立即生成" }).click();
    await expect(page.getByRole("status")).toHaveText("生成考点画像完成");
    await expect(portrait).toHaveCount(0);
    expect(modelInputs).toHaveLength(1);
    expect(modelInputs[0]).toContain(jd);
    const focus = page.getByRole("listitem", { name: "练习岗位重点问题" });
    await focus.getByRole("button", { name: "开始练习" }).click();
    await expect(focus).toContainText("组件状态应放在哪里？");
    await focus.getByRole("button", { name: "我已完成本项训练" }).click();
    await expect(focus.getByRole("button", { name: "已完成本项" })).toBeDisabled();
    await page.reload();
    await expect(focus.getByRole("button", { name: "恢复待练" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("preparation-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("region", { name: "准备进度" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("preparation-mobile.png"), fullPage: true });

    await page.route(`**/api/tools/preparation-plans/${first}`, route => route.request().method() === "PATCH" ? route.fulfill({ status: 503, json: { error: "训练保存失败" } }) : route.continue());
    await focus.getByRole("button", { name: "恢复待练" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "训练保存失败" })).toBeVisible();
    await expect(focus.getByRole("button", { name: "恢复待练" })).toBeDisabled();
    await page.unroute(`**/api/tools/preparation-plans/${first}`);
    await page.getByRole("button", { name: "刷新清单", exact: true }).click();
    await expect(focus.getByRole("button", { name: "恢复待练" })).toBeEnabled();

    const interview = page.getByRole("listitem", { name: "完成一场岗位模拟面试" });
    await interview.getByRole("link", { name: /开始模拟面试/ }).click();
    await expect(page).toHaveURL(new RegExp(`/interviews\\?applicationId=${first}$`));
    await expect(page.getByText("上场甲公司 · 前端工程师", { exact: false })).toBeVisible();
    await page.goto(`/tools/preparation?applicationId=${second}`);
    await page.getByRole("button", { name: /生成本岗位准备清单/ }).click();
    await expect(focus.getByRole("button", { name: "开始练习" })).toBeVisible();
    await expect(page.getByRole("listitem", { name: "梳理岗位考点" })).toBeVisible();
    await page.goto(`/applications/${first}/prepare`);
    await page.getByRole("link", { name: "上场计划 · 准备清单" }).click();
    await expect(focus.getByRole("button", { name: "恢复待练" })).toBeVisible();
  } finally {
    provider.closeAllConnections();
    await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
  }
});

test("空岗位也能安排清单，错误编号给出恢复入口", async ({ page, request }) => {
  const response = await request.post("/api/applications", { data: { company: "起步公司", role: "产品经理" } });
  const id = (await response.json()).id;
  await page.goto(`/tools/preparation?applicationId=${id}`);
  await page.getByRole("button", { name: /生成本岗位准备清单/ }).click();
  await expect(page.getByRole("region", { name: "待补资料", exact: true }).getByRole("listitem")).toHaveCount(5);
  const jd = page.getByRole("listitem", { name: "补齐岗位 JD" });
  await jd.getByRole("button", { name: "去补充" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.goto("/tools/preparation?applicationId=01");
  await expect(page.getByRole("alert").filter({ hasText: "岗位编号无效" })).toBeVisible();
  await page.getByRole("link", { name: "选择岗位", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "查找投递岗位" })).toBeVisible();
});
