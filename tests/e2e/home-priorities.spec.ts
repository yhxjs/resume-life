import { expect, test } from "@playwright/test";
import type { HomePriorities } from "../../src/lib/home-priorities-contract";
import { exportEncryptedBackup, postEncryptedBackup, rewriteEncryptedBackup } from "./backup-helpers";

const priorities: HomePriorities = { date: "2026-11-20", items: [
  { id: "application-1", kind: "interview", title: "云杉科技 · 前端工程师", reason: "11/20 18:30 面试。还缺自我介绍、JD 考点画像，建议面试前补齐。", badge: "今天面试", urgent: true, href: "/applications/1/prepare", action: "进入面试准备" },
  { id: "reviews", kind: "review", title: "复习 8 道到期题目", reason: "其中 3 题已逾期。错题 5 题、追练 3 题，先凭记忆作答，再对照参考。", badge: "3 题已逾期", urgent: true, href: "/reviews", action: "开始今日复习" },
  { id: "application-2", kind: "materials", title: "远山实验室 · 全栈工程师", reason: "还缺已发布的简历版本、岗位 JD、自我介绍。先补齐简历版本和 JD，即可开始针对岗位的准备。", badge: "基础资料待补", urgent: false, href: "/applications/2/prepare", action: "补齐准备资料" },
] };

for (const width of [390, 1280]) test(`今日三件事首屏、排序、恢复与布局 ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  let mode: "ready" | "error" | "empty" = "ready";
  await page.route("**/api/home/priorities?**", route => route.fulfill(mode === "error"
    ? { status: 503, json: { error: "服务暂不可用" } }
    : { json: mode === "empty" ? { ...priorities, items: [] } : priorities }));
  await page.goto("/");
  const section = page.getByRole("region", { name: "今天最重要的三件事" });
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("今天最重要的三件事");
  await expect(section.getByRole("heading", { level: 2 })).toHaveText(priorities.items.map(item => item.title));
  await expect(section.getByRole("listitem")).toHaveCount(3);
  expect((await section.boundingBox())!.y).toBeLessThan(250);
  for (const item of priorities.items) await expect(section.getByRole("link", { name: `${item.action}：${item.title}` })).toHaveAttribute("href", item.href);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(`home-priorities-${width}.png`), fullPage: true, animations: "disabled" });
  if (width === 1280) {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: testInfo.outputPath("home-priorities-dark.png"), fullPage: true, animations: "disabled" });
  }

  mode = "error";
  await page.evaluate(() => window.dispatchEvent(new Event("reviews-updated")));
  await expect(section.getByRole("alert")).toContainText("暂时无法读取");
  await expect(section.getByRole("list")).toHaveCount(0);
  mode = "empty";
  await section.getByRole("button", { name: "重试读取今日重点" }).click();
  await expect(section).toContainText("今天暂时没有需要优先处理的事项");
  await expect(section.getByRole("listitem")).toHaveCount(0);
});

test("真实投递按临近程度排序，进入准备页且返回后更新", async ({ page, request }) => {
  const ids: number[] = [];
  try {
    for (const [company, hours] of [["今日重点稍晚场", 24], ["今日重点最近场", 2]] as const) {
      const response = await request.post("/api/applications", { data: {
        company, role: "研发工程师", stage: "interviewing", next_interview_at: new Date(Date.now() + hours * 3_600_000).toISOString(),
      } });
      expect(response.status()).toBe(201);
      ids.push((await response.json()).id);
    }
    await page.goto("/");
    const section = page.getByRole("region", { name: "今天最重要的三件事" });
    await expect(section.getByRole("heading", { level: 2 }).first()).toHaveText("今日重点最近场 · 研发工程师");
    await expect(section.getByRole("heading", { level: 2 })).toHaveCount(2);
    await section.getByRole("link", { name: "进入面试准备：今日重点最近场 · 研发工程师" }).click();
    await expect(page).toHaveURL(new RegExp(`/applications/${ids[1]}/prepare$`));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("今日重点最近场 · 研发工程师");
    const updated = await request.patch(`/api/applications/${ids[1]}`, { data: {
      stage: "rejected", terminal_stage: "technical_interview", terminal_reason: "测试流程结束",
    } });
    expect(updated.ok(), await updated.text()).toBe(true);
    await page.goBack();
    await expect(section.getByRole("heading", { level: 2 })).toHaveText("今日重点稍晚场 · 研发工程师");
  } finally {
    for (const id of ids) expect((await request.delete(`/api/applications/${id}`)).ok()).toBe(true);
  }
});

test("已获 Offer 的真实待面试仍提醒，取消轮次后不再推荐补齐资料", async ({ page, request }) => {
  let id = 0;
  try {
    const created = await request.post("/api/applications", { data: { company: "Offer 后续面谈", role: "研发工程师", stage: "offer" } });
    expect(created.status()).toBe(201);
    id = (await created.json()).id;
    const round = await request.post(`/api/applications/${id}/interviews`, { data: {
      round_name: "HR 面谈", interview_time: new Date(Date.now() + 3_600_000).toISOString(),
    } });
    expect(round.status()).toBe(201);
    const roundId = (await round.json()).id;
    await page.goto("/");
    const section = page.getByRole("region", { name: "今天最重要的三件事" });
    await section.getByRole("link", { name: "进入面试准备：Offer 后续面谈 · 研发工程师" }).click();
    await expect(page).toHaveURL(new RegExp(`/applications/${id}/prepare$`));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Offer 后续面谈 · 研发工程师");
    const cancelled = await request.patch(`/api/applications/${id}/interviews/${roundId}`, { data: { status: "cancelled" } });
    expect(cancelled.ok()).toBe(true);
    await page.goBack();
    await expect(section).toContainText("随日程与复习进度更新");
    await expect(section.getByRole("heading", { level: 2, name: "Offer 后续面谈 · 研发工程师" })).toHaveCount(0);
  } finally {
    if (id) expect((await request.delete(`/api/applications/${id}`)).ok()).toBe(true);
  }
});

test("从备份恢复的零和负 ID 提醒均能进入投递看板", async ({ page, request }) => {
  const baseline = await exportEncryptedBackup(request);
  expect(baseline.response.ok()).toBe(true);
  const legacyIds = new Map<number, number>();
  const names = ["历史零号投递", "历史负号投递"];
  try {
    for (const [index, company] of names.entries()) {
      const response = await request.post("/api/applications", { data: {
        company, role: "研发工程师", stage: "applied",
        next_interview_at: index === 1 ? new Date(Date.now() + 3_600_000).toISOString() : "",
      } });
      expect(response.status()).toBe(201);
      legacyIds.set((await response.json()).id, -index);
    }
    const exported = await exportEncryptedBackup(request);
    expect(exported.response.ok()).toBe(true);
    const legacy = await rewriteEncryptedBackup(exported.bytes, records => {
      for (const record of records) {
        if (record.kind !== "row") continue;
        const key = record.table === "applications" ? "id" : record.table === "application_stage_history" ? "application_id" : null;
        if (key && legacyIds.has(record.data[key] as number)) record.data[key] = legacyIds.get(record.data[key] as number)!;
      }
    });
    const restored = await postEncryptedBackup(request, "/api/backup/restore", legacy);
    expect(restored.ok(), await restored.text()).toBe(true);
    const invalidReads: string[] = [];
    page.on("request", req => {
      if (/\/api\/applications\/(0|-1)\/preparation/.test(new URL(req.url()).pathname)) invalidReads.push(req.url());
    });
    await page.goto("/");
    const section = page.getByRole("region", { name: "今天最重要的三件事" });
    for (const company of names) {
      const link = section.getByRole("link", { name: `查看投递看板：${company} · 研发工程师` });
      await expect(link).toHaveAttribute("href", "/applications");
      await link.click();
      await expect(page).toHaveURL(/\/applications$/);
      await expect(page.locator("[draggable=true]").filter({ hasText: company })).toBeVisible();
      await page.goBack();
    }
    expect(invalidReads).toEqual([]);
  } finally {
    expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
  }
});
