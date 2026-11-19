import { expect, test, type APIRequestContext } from "@playwright/test";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import type { BankEntry } from "../../src/lib/bank";

const root = "/api/bank";
async function add(request: APIRequestContext, direction: string, kind: "tech" | "behavior", questions: string[]) {
  const response = await request.post(root, { data: { direction, kind, text: questions.join("\n") } });
  expect(response.status(), await response.text()).toBe(201); expect(await response.json()).toEqual({ count: questions.length });
}
async function all(request: APIRequestContext) {
  const response = await request.get(`${root}?limit=100`); expect(response.status()).toBe(200);
  const page = await response.json(); expect(page.nextCursor).toBeNull(); return page.items as BankEntry[];
}

for (const width of [390, 1280]) {
  test(`题库目录 ${width}px：坏首页与串方向、题型、关键词逐次拒绝，原稿和存档不变`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000);
    const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
    let initial = true; let filtered = 0; let writes = 0;
    try {
      const marker = `E2E目录${width}`; const direction = `${marker}:` + "LongDirection_".repeat(12);
      const question = `${marker} C++  <T> &amp; 100%_path\\file？`;
      await add(request, direction, "tech", [`${marker} 技术原题`]);
      await add(request, direction, "behavior", [question]); await add(request, `${marker}:另一方向`, "behavior", [`${marker} 另一方向 C++`]);
      const before = await all(request); const tech = before.find(item => item.kind === "tech")!;
      const other = before.find(item => item.direction !== direction)!;
      const keyword = "c++  <T> &AMP; 100%_path\\file";
      await page.route(`**${root}**`, async route => {
        const url = new URL(route.request().url());
        if (route.request().method() !== "GET") writes++;
        if (url.pathname !== root || route.request().method() !== "GET") return route.continue();
        if (initial) { initial = false; return route.fulfill({ json: { items: [tech, null], nextCursor: null } }); }
        if (url.searchParams.get("q") === keyword && url.searchParams.get("kind") === "behavior" && url.searchParams.get("direction") === direction) {
          filtered++;
          if (filtered === 1) return route.fulfill({ json: { items: [tech], nextCursor: null } });
          if (filtered === 2) return route.fulfill({ json: { items: [other], nextCursor: null } });
          if (filtered === 3) return route.fulfill({ json: { items: [{ ...tech, kind: "behavior", question: "串了关键词的合成题" }], nextCursor: null } });
        }
        return route.continue();
      });
      await page.setViewportSize({ width, height: 900 }); await page.goto("/bank");
      const draft = "未提交原稿 <T> &amp;\n内部  空格"; const input = page.getByRole("textbox", { name: "导入考题", exact: true }); await input.fill(draft);
      const error = page.getByRole("alert").filter({ hasText: "题库读取响应" }); await expect(error).toBeVisible();
      const directory = page.locator("main ul"); await expect(directory.getByRole("listitem")).toHaveCount(0);
      await page.getByRole("button", { name: "重试加载", exact: true }).click(); await expect(page.getByText(tech.question, { exact: true })).toBeVisible();
      await page.getByRole("button", { name: `${direction} (2)`, exact: true }).click();
      await expect(page.getByRole("button", { name: `${direction} (2)`, exact: true })).toHaveAttribute("aria-pressed", "true");
      await page.getByRole("combobox", { name: "按题型过滤", exact: true }).selectOption("behavior");
      await page.getByRole("searchbox", { name: "搜索题库", exact: true }).fill(keyword);
      await expect(error).toBeVisible(); await expect(page.getByText(tech.question, { exact: true })).toHaveCount(0);
      for (let attempt = 2; attempt <= 3; attempt++) {
        await page.getByRole("button", { name: "重试加载", exact: true }).click(); await expect(error).toBeVisible();
        expect(filtered).toBe(attempt); await expect(directory.getByRole("listitem")).toHaveCount(0);
      }
      await error.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath(`bank-list-invalid-${width}.png`), animations: "disabled" });
      await page.getByRole("button", { name: "重试加载", exact: true }).click();
      const text = page.getByText(question, { exact: true }); await expect(text).toBeVisible(); await expect(directory.getByRole("listitem")).toHaveCount(1);
      expect(await text.evaluate(element => getComputedStyle(element).whiteSpace)).toBe("pre-wrap"); expect(await text.textContent()).toBe(question);
      await expect(input).toHaveValue(draft); expect(filtered).toBe(4); expect(writes).toBe(0); expect(await all(request)).toEqual(before);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await text.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath(`bank-list-literal-${width}.png`), animations: "disabled" });
    } finally { expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });

  test(`题库目录 ${width}px：重复 ID 与坏游标整页拒绝，原游标重试只追加真实后五题`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000);
    const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
    const cursors: string[] = []; let writes = 0;
    try {
      const direction = `E2E目录续页${width}`; const questions = Array.from({ length: 55 }, (_, index) => `${direction} C++ <T> &amp; ${index + 1}`);
      await add(request, direction, "tech", questions); const before = await all(request); const boundary = before[49]!;
      await page.route(`**${root}**`, async route => {
        const url = new URL(route.request().url()); if (route.request().method() !== "GET") writes++;
        if (url.pathname !== root || !url.searchParams.has("cursor")) return route.continue();
        cursors.push(url.searchParams.get("cursor")!); const response = await route.fetch(); expect(response.ok()).toBe(true); const data = await response.json();
        if (cursors.length === 1) return route.fulfill({ json: { ...data, items: [boundary, ...data.items] } });
        if (cursors.length === 2) return route.fulfill({ json: { ...data, nextCursor: String(boundary.id - 1) } });
        return route.fulfill({ response });
      });
      await page.setViewportSize({ width, height: 900 }); await page.goto("/bank");
      const rows = page.locator("main ul").getByRole("listitem"); await expect(rows).toHaveCount(50);
      const input = page.getByRole("textbox", { name: "导入考题", exact: true }); const draft = "续页失败也保留原稿 <T> &amp;"; await input.fill(draft);
      await page.getByRole("button", { name: "加载更多", exact: true }).click(); const error = page.getByRole("alert").filter({ hasText: "题库读取响应" });
      await expect(error).toBeVisible(); await expect(rows).toHaveCount(50); await expect(page.getByText(before[50]!.question, { exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "重试加载更多", exact: true }).click(); await expect(error).toBeVisible(); await expect(rows).toHaveCount(50);
      await error.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath(`bank-list-cursor-error-${width}.png`), animations: "disabled" });
      await page.getByRole("button", { name: "重试加载更多", exact: true }).click(); await expect(rows).toHaveCount(55);
      for (const item of before) await expect(page.getByText(item.question, { exact: true })).toHaveCount(1);
      expect(cursors).toEqual([String(boundary.id), String(boundary.id), String(boundary.id)]); expect(writes).toBe(0);
      await expect(input).toHaveValue(draft); expect(await all(request)).toEqual(before); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });

  test(`题库目录 ${width}px：最后一个方向消失后仍可清除筛选并看到无方向题目`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000);
    const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
    try {
      const direction = `E2E方向消失${width}:` + "LongDirection_".repeat(12); const question = `E2E方向题${width}`; const otherQuestion = `E2E无方向题${width}`;
      await add(request, direction, "tech", [question]); await add(request, "", "behavior", [otherQuestion]);
      const before = await all(request); const other = before.find(item => item.question === otherQuestion)!; const target = before.find(item => item.question === question)!;
      await page.setViewportSize({ width, height: 900 }); await page.goto("/bank");
      await page.getByRole("button", { name: `${direction} (1)`, exact: true }).click(); await expect(page.getByText(otherQuestion, { exact: true })).toHaveCount(0);
      const input = page.getByRole("textbox", { name: "导入考题", exact: true }); const draft = "删除筛选方向时保留原稿 <T> &amp;"; await input.fill(draft);
      await page.getByRole("listitem").filter({ has: page.getByText(question, { exact: true }) }).getByRole("button", { name: "删除", exact: true }).click();
      await page.getByRole("dialog", { name: "删除题目", exact: true }).getByRole("button", { name: "删除", exact: true }).click();
      await expect(page.getByText(`当前方向：${direction}`, { exact: true })).toBeVisible();
      await expect(page.getByText("没有匹配的考题，试试切换或清除筛选条件。", { exact: true })).toBeVisible();
      const clear = page.getByRole("button", { name: "全部方向", exact: true }); await expect(clear).toHaveAttribute("aria-pressed", "false");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await clear.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath(`bank-list-missing-direction-${width}.png`), animations: "disabled" });
      await clear.click(); await expect(page.getByText(otherQuestion, { exact: true })).toBeVisible(); await expect(page.getByText(question, { exact: true })).toHaveCount(0);
      await expect(input).toHaveValue(draft); expect((await request.get(`${root}/${target.id}`)).status()).toBe(404); expect(await all(request)).toEqual([other]);
    } finally { expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });
}
