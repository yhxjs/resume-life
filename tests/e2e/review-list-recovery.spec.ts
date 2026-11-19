import { expect, test, type Page, type TestInfo } from "@playwright/test";
import type { ReviewList, ReviewListCard } from "../../src/lib/spaced-repetition-card-types";

const date = "2026-10-29";
const original = `完整原题 <T> &amp;\n内部  空格 ${"QuestionToken".repeat(22)}`;
const card = (id: number): ReviewListCard => ({ id, source: "notebook", source_id: id, source_label: "SourceToken".repeat(28), question: id === 1 ? original : `复习列表题目 ${id}`, mastery: "new", interval_days: 0, ease_factor: 250, repetitions: 0, review_count: 0, lapses: 0, next_review_date: date, sort_date: date, last_reviewed_at: "" });
const cursor = (id: number) => Buffer.from(JSON.stringify({ updatedAt: date, id })).toString("base64url");
const pageOf = (ids: number[], nextCursor: string | null = null): ReviewList => ({ items: ids.map(card), nextCursor, summary: { date, total: 52, due: 52, notebook: 52, remedial: 0, overdue: 0, completed_today: 0 } });
const ids = Array.from({ length: 50 }, (_, index) => index + 1);
async function capture(page: Page, testInfo: TestInfo, name: string, fullPage = true) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  if (fullPage) await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath(name), fullPage });
}

for (const width of [390, 1280]) test.describe(`复习列表恢复 ${width}px`, () => {
  test.use({ viewport: { width, height: 900 }, timezoneId: "Asia/Tokyo" });
  test.beforeEach(async ({ page }) => { await page.clock.install({ time: new Date("2026-10-29T10:00:00+09:00") }); });

  test("来源失败不串旧题，坏来源整页拒绝后显式重读恢复", async ({ page }, testInfo) => {
    let remedialLoads = 0;
    await page.route("**/api/reviews?**", route => {
      const source = new URL(route.request().url()).searchParams.get("source");
      if (source === "notebook") return route.fulfill({ status: 503, json: { error: "来源暂时不可读" } });
      const remedial = { ...card(2), source: "remedial" as const, source_label: "追练来源" };
      const data: ReviewList = { items: source === "remedial" ? (++remedialLoads === 1 ? [card(1)] : [remedial]) : [card(1), remedial], nextCursor: null, summary: { date, total: 2, due: 2, notebook: 1, remedial: 1, overdue: 0, completed_today: 0 } };
      return route.fulfill({ json: data });
    });
    await page.goto("/reviews");
    await expect(page.getByRole("heading", { level: 2 })).toHaveCount(2);
    expect(await page.getByRole("heading", { level: 2 }).first().textContent()).toBe(original);
    await capture(page, testInfo, "review-list-full-text.png");
    await page.getByRole("combobox", { name: "复习来源" }).selectOption("remedial");
    await expect(page.getByRole("main").getByRole("alert")).toContainText("复习列表响应不完整");
    await expect(page.getByRole("heading", { level: 2 })).toHaveCount(0);
    await expect(page.getByText(/今日待复习 2 题/)).toHaveCount(0);
    await page.getByRole("button", { name: "重试加载", exact: true }).click();
    await expect(page.getByRole("heading", { level: 2 })).toHaveText("复习列表题目 2");
    await page.getByRole("combobox", { name: "复习来源" }).selectOption("notebook");
    await expect(page.getByRole("main").getByRole("alert")).toContainText("来源暂时不可读");
    await expect(page.getByRole("heading", { level: 2 })).toHaveCount(0);
    await capture(page, testInfo, "review-list-filter-error.png");
  });

  test("重复边界整页拒绝，原游标重试后保留全部题目", async ({ page }, testInfo) => {
    const requested: string[] = []; let more = 0;
    await page.route("**/api/reviews?**", route => {
      const boundary = new URL(route.request().url()).searchParams.get("cursor");
      if (!boundary) return route.fulfill({ json: pageOf(ids, cursor(50)) });
      requested.push(boundary);
      return route.fulfill({ json: ++more === 1 ? pageOf([50]) : pageOf([51, 52]) });
    });
    await page.goto("/reviews"); await expect(page.getByRole("heading", { level: 2 })).toHaveCount(50);
    await page.getByRole("button", { name: "加载更多", exact: true }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("复习列表响应不完整");
    await expect(page.getByRole("heading", { level: 2 })).toHaveCount(50);
    await page.getByRole("button", { name: "重试加载更多", exact: true }).click();
    await expect(page.getByRole("heading", { level: 2 })).toHaveCount(52);
    expect(requested).toEqual([cursor(50), cursor(50)]);
    await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0); await expect(page.getByRole("button", { name: "加载更多", exact: true })).toHaveCount(0);
    await capture(page, testInfo, "review-list-pages-recovered.png", false);
  });

  test("全部范围刷新已加载两页，学习后移动的卡更新并移到末尾", async ({ page }) => {
    let refresh = false; let allLoads = 0;
    await page.route("**/api/reviews?**", route => {
      const params = new URL(route.request().url()).searchParams;
      if (params.get("scope") !== "all") return route.fulfill({ json: pageOf([2]) });
      allLoads++;
      const data = params.has("cursor") ? pageOf([51]) : pageOf(ids, cursor(50));
      data.summary = { ...data.summary, total: 51, due: refresh && params.has("cursor") ? 50 : 51, notebook: refresh && params.has("cursor") ? 50 : 51, completed_today: refresh && params.has("cursor") ? 1 : 0 };
      if (refresh && params.has("cursor")) data.items.push({ ...card(1), review_count: 1, repetitions: 1, mastery: "learning", next_review_date: "2026-10-30", sort_date: "2026-10-30" });
      return route.fulfill({ json: data });
    });
    await page.goto("/reviews"); await page.getByRole("button", { name: "全部题目", exact: true }).click();
    await expect(page.getByRole("heading", { level: 2 })).toHaveCount(50);
    await page.getByRole("button", { name: "加载更多", exact: true }).click(); await expect(page.getByRole("heading", { level: 2 })).toHaveCount(51);
    refresh = true; await page.evaluate(() => window.dispatchEvent(new Event("reviews-updated")));
    await expect.poll(() => allLoads).toBe(4);
    await expect(page.getByRole("heading", { level: 2 }).last()).toHaveText(original);
    await expect(page.getByRole("heading", { level: 2 })).toHaveCount(51);
    await expect(page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: original, exact: true }) })).toContainText("已复习 1 次");
  });

  test("跨日续页不拼接旧队列，显式重载从当地新日首页恢复", async ({ page }, testInfo) => {
    let nextDay = false;
    await page.route("**/api/reviews?**", route => {
      if (!nextDay) return route.fulfill({ json: pageOf(ids, cursor(50)) });
      const data = pageOf([51]);
      data.summary = { ...data.summary, date: "2026-10-30", total: 1, due: 1, notebook: 1 };
      data.items = data.items.map(item => ({ ...item, sort_date: "2026-10-30", next_review_date: "2026-10-30" }));
      return route.fulfill({ json: data });
    });
    await page.goto("/reviews"); await expect(page.getByRole("heading", { level: 2 })).toHaveCount(50);
    nextDay = true; await page.clock.setSystemTime(new Date("2026-10-30T00:00:30+09:00"));
    await page.getByRole("button", { name: "加载更多", exact: true }).click();
    await expect(page.getByRole("main").getByRole("alert")).toContainText("复习列表响应不完整");
    await expect(page.getByRole("heading", { level: 2 })).toHaveCount(50);
    await page.getByRole("button", { name: "重试加载", exact: true }).click();
    // 重载异步替换整页，旧 50 项仍在时按列表等待，避免单元素严格模式提前失败。
    await expect(page.getByRole("heading", { level: 2 })).toHaveText(["复习列表题目 51"]);
    await expect(page.getByText("2026-10-30", { exact: true })).toBeVisible();
    await capture(page, testInfo, "review-list-next-day.png");
  });
});
