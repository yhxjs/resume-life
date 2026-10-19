import { expect, test } from "@playwright/test";
import type { Application } from "../../src/lib/applications-types";
import { mockApi } from "./synthetic-api";

test("真实投递：批次筛选、终止表单、履历与重开口径一致", async ({ page, request }) => {
  const ids: number[] = [];
  try {
    const first = await request.post("/api/applications", { data: {
      company: "履历测试公司", role: "测试工程师", stage: "applied", batch_name: "履历春招",
    } });
    expect(first.status()).toBe(201);
    const app = await first.json();
    ids.push(app.id);
    const second = await request.post("/api/applications", { data: {
      company: "批次隔离公司", role: "测试工程师", stage: "offer", batch_name: "履历秋招",
    } });
    expect(second.status()).toBe(201);
    ids.push((await second.json()).id);

    await page.goto("/applications?view=funnel");
    await page.getByLabel("投递批次", { exact: true }).selectOption(JSON.stringify("履历春招"));
    const results = page.locator("section").filter({ has: page.getByRole("heading", { name: "招聘环节结果", exact: true }) });
    const screening = results.getByRole("row").filter({ hasText: "简历筛选" });
    await expect(screening.getByRole("cell")).toHaveText(["1", "0", "0", "— 未结算"]);

    await page.goto("/applications");
    const card = page.locator("[draggable=true]").filter({ hasText: "履历测试公司" });
    await card.getByLabel("流转阶段").selectOption("rejected");
    const dialog = page.getByRole("dialog", { name: "编辑求职投递卡片", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("终止原因 *", { exact: true })).toHaveAttribute("required", "");
    expect((await (await request.get(`/api/applications/${app.id}`)).json()).stage).toBe("applied");
    await dialog.getByLabel("终止阶段 *", { exact: true }).selectOption("resume_screening");
    await dialog.getByLabel("终止原因 *", { exact: true }).fill("简历与岗位不匹配");
    await dialog.getByRole("button", { name: "更新卡片", exact: true }).click();
    await expect(dialog).toBeHidden();

    const saved = await (await request.get(`/api/applications/${app.id}`)).json();
    expect(saved).toMatchObject({ flow_status: "terminated", terminal_stage: "resume_screening", terminal_reason: "简历与岗位不匹配" });
    expect(saved.stage_history).toHaveLength(2);
    expect(saved.stage_history[1].changed_at).toBeTruthy();
    await page.getByRole("button", { name: "流程终止 / 不合适" }).click();
    await card.getByTitle("编辑卡片", { exact: true }).click();
    await expect(dialog.getByLabel("当前阶段", { exact: true })).toHaveValue("rejected");
    await dialog.getByText("阶段履历（2 条）", { exact: true }).click();
    await expect(dialog.getByRole("list").getByText("简历与岗位不匹配", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "取消", exact: true }).click();

    await page.goto("/applications?view=funnel");
    await page.getByLabel("投递批次", { exact: true }).selectOption(JSON.stringify("履历春招"));
    await expect(screening.getByRole("cell")).toHaveText(["0", "0", "1", "0%"]);
    await expect(page.getByText("简历筛选 · 简历与岗位不匹配", { exact: true })).toBeVisible();

    const reopen = await request.patch(`/api/applications/${app.id}`, { data: { stage: "applied" } });
    expect(reopen.status()).toBe(200);
    expect(await reopen.json()).toMatchObject({ flow_status: "active", terminal_stage: null, terminal_reason: "" });
    await page.reload();
    await page.getByLabel("投递批次", { exact: true }).selectOption(JSON.stringify("履历春招"));
    await expect(screening.getByRole("cell")).toHaveText(["1", "0", "0", "— 未结算"]);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByLabel("投递批次", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  } finally {
    // 超时会关闭 request；临时数据库仍由测试服务器清理，不遮蔽原始失败。
    await Promise.allSettled(ids.map(id => request.delete(`/api/applications/${id}`)));
  }
});

test("已终止记录编辑批次和备注时保留当前归因", async ({ page }) => {
  const terminated: Application = {
    id: 9001, company: "历史投递", role: "工程师", stage: "rejected", flow_status: "terminated",
    batch_name: "", hiring_stage: "hr_interview", stage_changed_at: "2026-09-01T00:00:00.000Z", terminal_stage: "hr_interview", terminal_reason: "岗位关闭", terminal_at: "2026-09-01T00:00:00.000Z",
    salary_range: "", resume_id: null, jd: "", interview_id: null, interview_series_id: null,
    next_interview_at: "", notes: "", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
  };
  const api = await mockApi(page, [terminated]);
  await page.goto("/applications");
  await page.getByRole("button", { name: "流程终止 / 不合适" }).click();
  await page.getByTitle("编辑卡片", { exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "编辑求职投递卡片", exact: true });
  await expect(dialog.getByLabel("终止原因", { exact: false })).toHaveAttribute("required", "");
  await dialog.getByLabel("投递批次", { exact: true }).fill("历史春招");
  await dialog.getByLabel("投递备注 / 面试要点手记", { exact: true }).fill("保持终止归因");
  await dialog.getByRole("button", { name: "更新卡片", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(api.applicationWrites).toHaveLength(1);
  expect(api.applicationWrites[0]).toMatchObject({ batch_name: "历史春招", notes: "保持终止归因" });
  expect(api.applicationWrites[0]).toMatchObject({ terminal_stage: "hr_interview", terminal_reason: "岗位关闭" });
  expect(api.applications()[0]).toMatchObject({ terminal_stage: "hr_interview", terminal_reason: "岗位关闭", stage_changed_at: "2026-09-01T00:00:00.000Z" });
});
