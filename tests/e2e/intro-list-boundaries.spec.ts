import { expect, test, type Page, type TestInfo } from "@playwright/test";
import type { IntroListItem } from "../../src/lib/intro-history";
import { mockApi } from "./synthetic-api";

const legacyTime = `旧时间 <T> &amp; ${"TimeToken".repeat(10)}`;
const row = (id: number): IntroListItem => ({ id, jd: `岗位 ${id}`, resume_title: "原发布简历", created_at: "2026-10-29", resume_version_id: 90001, resume_version: 1, resume_version_name: "原发布版" });
const draft = "  尚未提交 <T> &amp;\n内部  空格  ";
async function setup(page: Page) {
  await mockApi(page);
  await page.route("**/api/resumes", route => route.fulfill({ json: [
    { id: 9001, title: "参考简历甲", versions: [{ id: 90001, version: 1, name: "甲发布版" }] },
    { id: 9002, title: "参考简历乙", versions: [{ id: 90021, version: 1, name: "乙旧版" }, { id: 90022, version: 2, name: "乙新版" }] },
  ] }));
  const writes: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/intros") && request.method() !== "GET") writes.push(request.method()); });
  return writes;
}
async function configure(page: Page) {
  const resume = page.getByRole("combobox", { name: "选择参考简历", exact: true });
  await resume.selectOption("9002");
  const version = page.getByRole("combobox", { name: "已发布版本", exact: true });
  await version.selectOption("90021");
  const input = page.getByRole("textbox", { name: "目标岗位要求（JD / 职位描述）", exact: true });
  await input.fill(draft);
  return { input, resume, version };
}
async function capture(page: Page, info: TestInfo, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(name), animations: "disabled" });
}

for (const width of [390, 1280]) test.describe(`自我介绍列表 ${width}px`, () => {
  test.use({ viewport: { width, height: 900 }, timezoneId: "America/Los_Angeles" });
  test("503 和损坏发布版整页拒绝，重读保留 JD 与简历选择，并显示旧日期原文", async ({ page }, info) => {
    const writes = await setup(page); let attempts = 0;
    const original = { ...row(60), jd: `历史 JD <T> &amp;\n内部  空格 ${"HistoryToken".repeat(100)}`, created_at: legacyTime, resume_title: `原发布简历 ${"TitleToken".repeat(20)}` };
    await page.route("**/api/intros?**", async route => {
      attempts++;
      if (attempts === 1) return route.fulfill({ status: 503, json: { error: "历史读取暂时失败" } });
      if (attempts === 2) return route.fulfill({ json: { items: [original, { ...row(59), resume_version: null }], nextCursor: null } });
      return route.fulfill({ json: { items: [original, { ...row(59), jd: "", resume_version_id: null, resume_version: null, resume_version_name: null }], nextCursor: null, total: 2 } });
    });
    await page.goto("/intros"); const config = await configure(page);
    const error = page.getByRole("alert").filter({ hasText: "自我介绍历史加载失败" });
    await expect(error).toContainText("历史读取暂时失败");
    await expect(page.getByText("尚无自我介绍历史，生成后会显示在这里。", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "重试加载", exact: true }).click();
    await expect(error).toContainText("自我介绍历史响应"); await expect(page.getByRole("region", { name: "自我介绍历史", exact: true })).toHaveCount(0);
    await error.scrollIntoViewIfNeeded(); await capture(page, info, "intro-list-invalid-head.png");
    await page.getByRole("button", { name: "重试加载", exact: true }).click();
    const history = page.getByRole("region", { name: "自我介绍历史", exact: true });
    await expect(history.getByRole("link", { name: "查看演练", exact: true })).toHaveCount(2);
    await expect(error).toHaveCount(0); expect(await history.locator("time").first().textContent()).toBe(legacyTime);
    expect(await history.locator("p").first().textContent()).toBe(original.jd);
    await expect(page.getByText("Invalid Date", { exact: true })).toHaveCount(0);
    await expect(config.input).toHaveValue(draft); await expect(config.resume).toHaveValue("9002"); await expect(config.version).toHaveValue("90021");
    await history.locator("time").first().scrollIntoViewIfNeeded(); await capture(page, info, "intro-list-recovered-head.png");
    expect(attempts).toBe(3); expect(writes).toEqual([]);
  });

  test("重复边界和短页假游标均不追加，原游标重试后读全 52 条", async ({ page }, info) => {
    const writes = await setup(page); const cursors: string[] = [];
    await page.route("**/api/intros?**", async route => {
      const cursor = new URL(route.request().url()).searchParams.get("cursor");
      if (!cursor) return route.fulfill({ json: { items: Array.from({ length: 50 }, (_, index) => row(52 - index)), nextCursor: "3", total: 52 } });
      cursors.push(cursor);
      if (cursors.length === 1) return route.fulfill({ json: { items: [row(3), row(2)], nextCursor: null, total: 52 } });
      return route.fulfill({ json: { items: [row(2), row(1)], nextCursor: cursors.length === 2 ? "1" : null, total: 52 } });
    });
    await page.goto("/intros"); const config = await configure(page);
    const history = page.getByRole("region", { name: "自我介绍历史", exact: true });
    await expect(history.getByRole("link", { name: "查看演练", exact: true })).toHaveCount(50);
    await expect(history.locator("time").first()).toHaveText("2026-10-29");
    await history.getByRole("button", { name: "加载更多", exact: true }).click();
    const error = page.getByRole("alert").filter({ hasText: "自我介绍历史响应" });
    await expect(error).toBeVisible(); await expect(history.getByRole("link", { name: "岗位 2", exact: true })).toHaveCount(0);
    const retry = history.getByRole("button", { name: "重试加载更多", exact: true });
    await retry.click(); await expect(retry).toBeEnabled(); expect(cursors).toEqual(["3", "3"]);
    await expect(history.getByRole("link", { name: "查看演练", exact: true })).toHaveCount(50);
    await retry.click(); await expect(history.getByRole("link", { name: "查看演练", exact: true })).toHaveCount(52);
    await expect(error).toHaveCount(0); await expect(history.getByRole("button", { name: /加载更多/ })).toHaveCount(0);
    expect(cursors).toEqual(["3", "3", "3"]); expect(writes).toEqual([]);
    await expect(config.input).toHaveValue(draft); await expect(config.resume).toHaveValue("9002"); await expect(config.version).toHaveValue("90021");
    await history.getByRole("link", { name: "岗位 1", exact: true }).scrollIntoViewIfNeeded(); await capture(page, info, "intro-list-recovered-tail.png");
  });
});
