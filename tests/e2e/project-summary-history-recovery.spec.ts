import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { emptySummary } from "../../src/lib/summary";
import type { ProjectSummaryHistoryPage } from "../../src/lib/project-summary-history-records";
import { gate } from "./synthetic-api";

const original = ` 历史原文 <T> &amp;\n内部  空格 ${"HistoryToken".repeat(30)}`;
async function seed(request: APIRequestContext) {
  const created: number[] = [];
  const cleanup = async () => { for (const id of created) expect((await request.delete(`/api/projects/${id}`)).status()).toBe(200); };
  try {
    for (const name of ["历史恢复项目甲", "历史恢复项目乙"]) {
      const response = await request.post("/api/projects", { data: { name } }); expect(response.status()).toBe(201);
      created.push((await response.json()).id);
    }
    let lastId = 0;
    for (let index = 1; index <= 12; index++) {
      const response = await request.patch(`/api/projects/${created[0]}`, { data: { summary: { ...emptySummary(), overview: `${original} ${index}`, achievements: ["", " 原成果\n内部  空格 "] }, expectedRevisionId: lastId } });
      expect(response.status(), await response.text()).toBe(200); lastId = (await response.json()).revisionId;
    }
    const saved = await request.patch(`/api/projects/${created[1]}`, { data: { summary: { ...emptySummary(), overview: "乙项目独立历史", architecture: "乙项目架构" }, expectedRevisionId: 0 } });
    expect(saved.status()).toBe(200);
    return { firstId: created[0]!, secondId: created[1]!, firstRevision: lastId, secondRevision: (await saved.json()).revisionId as number, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
async function capture(page: Page, testInfo: TestInfo, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(name) });
}

for (const width of [390, 1280]) test.describe(`项目总结历史恢复 ${width}px`, () => {
  test.use({ viewport: { width, height: 900 } });
  test("真实历史首页失败、串项目和坏续页重读，保留编辑草稿及完整存档", async ({ page, request }, testInfo) => {
    test.setTimeout(60_000);
    const seeded = await seed(request);
    try {
      const before = await (await request.get(`/api/projects/${seeded.firstId}`)).json();
      const savedHistory = await (await request.get(`/api/projects/${seeded.firstId}/summary-history?limit=10`)).json() as ProjectSummaryHistoryPage;
      let headLoads = 0; const cursors: string[] = []; let writes = 0;
      page.on("request", req => { if (/\/api\/projects(?:\/|$)/.test(new URL(req.url()).pathname) && req.method() !== "GET") writes++; });
      await page.route(`**/api/projects/${seeded.firstId}/summary-history?**`, async route => {
        const boundary = new URL(route.request().url()).searchParams.get("cursor");
        if (!boundary && ++headLoads === 1) return route.fulfill({ status: 503, json: { error: "历史暂时不可读" } });
        const response = await route.fetch(); const body = await response.json() as ProjectSummaryHistoryPage;
        if (!boundary && headLoads === 2) body.projectId = seeded.secondId;
        if (boundary) {
          cursors.push(boundary);
          if (cursors.length === 1) return route.fulfill({ json: { ...body, items: [{ ...body.items[0], summary: null }] } });
          if (cursors.length === 2) body.items = [savedHistory.items.at(-1)!];
        }
        return route.fulfill({ json: body });
      });
      await page.goto(`/knowledge/${seeded.firstId}`);
      const region = page.getByRole("region", { name: "总结历史", exact: true });
      const editor = page.locator("#project-summary-overview");
      await expect(editor).toHaveValue(`${original} 12`); await editor.fill("编辑中未保存的项目草稿 <T>\n内部  空格");
      await expect(region.getByRole("alert")).toContainText("历史暂时不可读");
      await region.getByRole("button", { name: "重试加载", exact: true }).click();
      await expect(region.getByRole("alert")).toContainText("总结历史响应不完整"); await expect(region.locator("details")).toHaveCount(0);
      await region.getByRole("button", { name: "重试加载", exact: true }).click();
      await expect(region.locator("details")).toHaveCount(10);
      await region.locator("summary").first().click();
      expect(await region.locator("details").first().locator("p").first().textContent()).toBe(`${original} 12`);
      await region.getByRole("button", { name: "加载更早的总结", exact: true }).click();
      await expect(region.getByRole("alert")).toContainText("总结历史响应不完整"); await expect(region.locator("details")).toHaveCount(10);
      await region.getByRole("button", { name: "重试加载更早的总结", exact: true }).click();
      await expect.poll(() => cursors.length).toBe(2); await expect(region.getByRole("alert")).toContainText("总结历史响应不完整");
      await region.getByRole("alert").scrollIntoViewIfNeeded(); await capture(page, testInfo, "history-invalid-page.png");
      await region.getByRole("button", { name: "重试加载更早的总结", exact: true }).click();
      await expect(region.locator("details")).toHaveCount(12); expect(cursors).toEqual([savedHistory.nextCursor, savedHistory.nextCursor, savedHistory.nextCursor]);
      await expect(region.getByRole("alert")).toHaveCount(0); await expect(region.getByRole("button", { name: /加载更早/ })).toHaveCount(0);
      await expect(editor).toHaveValue("编辑中未保存的项目草稿 <T>\n内部  空格");
      await region.locator("summary").last().click();
      expect(await region.locator("details").last().locator("p").first().textContent()).toBe(`${original} 1`);
      await region.locator("details").last().scrollIntoViewIfNeeded(); await capture(page, testInfo, "history-recovered.png");
      expect(await (await request.get(`/api/projects/${seeded.firstId}`)).json()).toEqual(before); expect(writes).toBe(0);
    } finally { await seeded.cleanup(); }
  });

  test("续页等待时切换项目，迟到历史不写入新项目或覆盖新草稿", async ({ page, request }, testInfo) => {
    test.setTimeout(60_000);
    const seeded = await seed(request); const waiting = gate(); let entered = false; let released = false;
    try {
      await page.route(`**/api/projects/${seeded.firstId}/summary-history?**`, async route => {
        if (!new URL(route.request().url()).searchParams.has("cursor")) return route.continue();
        const response = await route.fetch(); const body = await response.json(); entered = true;
        await waiting.promise; await route.fulfill({ json: body }); released = true;
      });
      await page.goto(`/knowledge/${seeded.firstId}`);
      const region = page.getByRole("region", { name: "总结历史", exact: true });
      await expect(region.locator("details")).toHaveCount(10);
      await region.getByRole("button", { name: "加载更早的总结", exact: true }).click(); await expect.poll(() => entered).toBe(true);
      await page.goto(`/knowledge/${seeded.secondId}`); await expect(page.getByRole("heading", { name: "历史恢复项目乙", exact: true })).toBeVisible();
      await expect(region.locator("details")).toHaveCount(1); await expect(region.getByText(`#${seeded.secondRevision}`, { exact: true })).toBeVisible();
      await page.locator("#project-summary-overview").fill("乙项目未保存草稿");
      waiting.release(); await expect.poll(() => released).toBe(true);
      await expect(region.locator("details")).toHaveCount(1); await expect(region.getByText(`#${seeded.firstRevision}`, { exact: true })).toHaveCount(0);
      await expect(page.locator("#project-summary-overview")).toHaveValue("乙项目未保存草稿");
      await region.locator("summary").click(); await expect(region).toContainText("乙项目独立历史");
      await region.scrollIntoViewIfNeeded(); await capture(page, testInfo, "history-project-switched.png");
    } finally { waiting.release(); await seeded.cleanup(); }
  });
});
