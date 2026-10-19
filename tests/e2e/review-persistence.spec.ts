import { expect, test } from "@playwright/test";
import { exportEncryptedBackup, postEncryptedBackup, rewriteEncryptedBackup } from "./backup-helpers";
import type { ReviewDetail, ReviewList } from "../../src/lib/spaced-repetition-card-types";

test.use({ timezoneId: "America/Los_Angeles" });

test("真实复习闭环：今日提醒、遮答、保存、刷新重答、历史及移动端", async ({ page, request }, testInfo) => {
  test.setTimeout(90_000);
  const baseline = await exportEncryptedBackup(request);
  expect(baseline.response.ok()).toBe(true);
  const timestamp = new Date().toISOString();
  const question = "复习验证：为什么事务需要隔离？";
  const remedial = "追练验证：如何避免数据库死锁？";
  let notebookId = 0;
  const seeded = await rewriteEncryptedBackup(baseline.bytes, records => {
    // 测试服务已有独立临时数据库；用合法备份种子，不绕过实际 HTTP 持久化层。
    for (let i = records.length - 1; i >= 0; i--) {
      const row = records[i]!;
      if (row.kind === "row" && (row.table === "review_cards" || row.table === "review_attempts")) records.splice(i, 1);
    }
    const nextId = (table: string) => Math.max(0, ...records.flatMap(row => row.kind === "row" && row.table === table ? [Number(row.data.id)] : [])) + 1;
    notebookId = nextId("notebook_entries");
    const drillId = nextId("drills");
    const questionId = nextId("drill_questions");
    const sourceId = Math.max(0, ...records.flatMap(row => row.kind === "row" && row.table === "notebook_entries" ? [Number(row.data.source_id)] : [])) + 1;
    const add = (table: string, data: Record<string, unknown>) => records.splice(records.findIndex(row => row.kind === "end"), 0, { kind: "row", table, data });
    add("notebook_entries", { id: notebookId, category_id: null, source: "interview", source_id: sourceId, source_label: "复习验证", question, answer: "原始现场回答秘密", comment: "需要补充并发场景", reference: "事务隔离参考秘密", scores: "", created_at: timestamp, updated_at: timestamp });
    add("drills", { id: drillId, source: "interview", project_id: null, direction: "后端", jd: "", interview_id: null, focus: "并发控制", created_at: timestamp });
    add("drill_questions", { id: questionId, drill_id: drillId, idx: 1, question: remedial, answer: "追练原回答", comment: "补充死锁检测", reference: "固定加锁顺序", scores: "", answered_at: timestamp, kind: "tech" });
    const schedule = { interval_days: 0, ease_factor: 250, repetitions: 0, review_count: 0, lapses: 0, next_review_date: timestamp.slice(0, 10), last_reviewed_at: "", created_at: timestamp };
    add("review_cards", { id: 1, notebook_id: notebookId, drill_question_id: null, ...schedule });
    add("review_cards", { id: 2, notebook_id: null, drill_question_id: questionId, ...schedule });
    const manifest = records.find(row => row.kind === "manifest")!;
    const end = records.find(row => row.kind === "end")!;
    if (manifest.kind !== "manifest" || end.kind !== "end") throw new Error("Missing backup envelope");
    end.stats = Object.fromEntries(manifest.tables.map(table => [table, records.filter(row => row.kind === "row" && row.table === table).length]));
    end.totalRecords = Object.values(end.stats).reduce((sum, count) => sum + count, 0);
    manifest.sequences = { ...manifest.sequences, notebook_entries: notebookId, drills: drillId, drill_questions: questionId, review_cards: Math.max(manifest.sequences?.review_cards ?? 0, 2) };
  });
  try {
    const restored = await postEncryptedBackup(request, "/api/backup/restore", seeded);
    expect(restored.status(), await restored.text()).toBe(200);
    await page.goto("/");
    const today = page.getByRole("region", { name: "今日待复习" });
    await expect(today).toContainText("待复习 2 题");
    await expect(today).toContainText("错题 1");
    await expect(today).toContainText("追练 1");
    await today.getByRole("link").filter({ hasText: question }).click();
    await expect(page.getByLabel("本次回答", { exact: true })).toHaveValue("");
    await expect(page.getByText("原始现场回答秘密", { exact: true })).toHaveCount(0);
    await expect(page.getByText("事务隔离参考秘密", { exact: true })).toHaveCount(0);
    await page.getByLabel("本次回答", { exact: true }).fill("第一次独立回忆：避免读到并发中间状态。");
    await page.getByRole("button", { name: "查看参考并自评" }).click();
    await expect(page.getByText("事务隔离参考秘密", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /基本掌握/ }).click();
    await page.getByRole("button", { name: "保存本次复习" }).click();
    await expect(page.getByText("本次复习已保存", { exact: true })).toBeVisible();
    let saved = await (await request.get("/api/reviews/1")).json() as ReviewDetail;
    expect(saved.review_count).toBe(1);
    expect(saved.attempts).toHaveLength(1);
    expect(saved.next_review_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await page.reload();
    await expect(page.getByLabel("本次回答", { exact: true })).toHaveValue("");
    await expect(page.getByText("事务隔离参考秘密", { exact: true })).toHaveCount(0);
    await page.getByLabel("本次回答", { exact: true }).fill("第二次回忆：忘了幻读的细节。");
    await page.getByRole("button", { name: "查看参考并自评" }).click();
    await page.getByRole("button", { name: /忘记了/ }).click();
    await page.getByRole("button", { name: "保存本次复习" }).click();
    await expect(page.getByText("本次复习已保存", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "查看复习历史", exact: true }).click();
    const history = page.getByRole("region", { name: "复习历史记录" });
    await expect(history).toContainText("第一次独立回忆");
    await expect(history).toContainText("第二次回忆");
    saved = await (await request.get("/api/reviews/1")).json() as ReviewDetail;
    expect(saved).toMatchObject({ review_count: 2, interval_days: 1, mastery: "relearning" });
    expect(saved.attempts).toHaveLength(2);
    const original = await (await request.get(`/api/notebook/${notebookId}`)).json();
    expect(original.answer).toBe("原始现场回答秘密");
    await page.goto("/");
    await expect(page.getByRole("region", { name: "今日待复习" })).toContainText("待复习 1 题");
    await page.screenshot({ path: testInfo.outputPath("today-reviews-desktop.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/reviews");
    await expect(page.getByText(remedial, { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("reviews-mobile.png"), fullPage: true });
  } finally {
    expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
  }
});

test("首页停留跨日自动刷新当地待复习队列", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-09-27T23:59:30-07:00") });
  let loads = 0;
  await page.route("**/api/reviews?**", route => {
    loads++;
    expect(new URL(route.request().url()).searchParams.get("time_zone")).toBe("America/Los_Angeles");
    const nextDay = loads > 1;
    const result: ReviewList = { items: nextDay ? [{ id: 91, source: "notebook", source_id: 1, source_label: "跨日验证", question: "跨日后到期的复习题", mastery: "learning", interval_days: 1, ease_factor: 250, repetitions: 1, review_count: 1, lapses: 0, next_review_date: "2026-09-28", last_reviewed_at: "2026-09-27T08:00:00Z" }] : [], nextCursor: null, summary: { date: nextDay ? "2026-09-28" : "2026-09-27", total: 1, due: nextDay ? 1 : 0, notebook: nextDay ? 1 : 0, remedial: 0, overdue: 0, completed_today: 0 } };
    return route.fulfill({ json: result });
  });
  await page.goto("/");
  await expect(page.getByRole("region", { name: "今日待复习" })).toContainText("今日复习已完成");
  await page.clock.fastForward(61_000);
  await expect(page.getByRole("region", { name: "今日待复习" })).toContainText("跨日后到期的复习题");
});
