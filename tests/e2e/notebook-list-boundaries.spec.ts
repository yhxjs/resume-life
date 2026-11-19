import { expect, test, type APIRequestContext } from "@playwright/test";
import { exportEncryptedBackup, postEncryptedBackup, rewriteEncryptedBackup } from "./backup-helpers";
import type { NotebookEntry } from "../../src/lib/notebook-records";

const root = "/api/notebook";
type SeedEntry = Pick<NotebookEntry, "question"> & Partial<Pick<NotebookEntry, "source" | "answer" | "comment" | "reference">> & { category?: "first" | "second" | null };
async function seed(request: APIRequestContext, bytes: Buffer, entries: SeedEntry[]) {
  let categoryId = 0; const category = "目录分类 <T> &amp; " + "LongCategory_".repeat(12);
  const timestamp = "2026-10-29T00:00:00.000Z";
  const rewritten = await rewriteEncryptedBackup(bytes, records => {
    const nextId = (table: string) => Math.max(0, ...records.flatMap(row => row.kind === "row" && row.table === table ? [Number(row.data.id)] : [])) + 1;
    categoryId = nextId("notebook_categories"); const entryId = nextId("notebook_entries");
    const add = (table: string, data: Record<string, unknown>) => records.splice(records.findIndex(row => row.kind === "end"), 0, { kind: "row", table, data });
    add("notebook_categories", { id: categoryId, name: category, created_at: timestamp });
    add("notebook_categories", { id: categoryId + 1, name: "另一分类", created_at: timestamp });
    for (const [index, entry] of entries.entries()) {
      add("notebook_entries", {
        id: entryId + index, category_id: entry.category === null ? null : categoryId + (entry.category === "second" ? 1 : 0),
        source: entry.source ?? "drill", source_id: entryId + index, source_label: "独立收藏快照 <T> &amp; " + "LongSource_".repeat(12),
        question: entry.question, answer: entry.answer ?? "原答：只参与参数校验，尚未上线。", comment: entry.comment ?? "原始点评",
        reference: entry.reference ?? "仅参考中出现 <T> &amp;", scores: "", created_at: timestamp, updated_at: timestamp,
      });
    }
    const manifest = records.find(row => row.kind === "manifest"); const end = records.find(row => row.kind === "end");
    if (manifest?.kind !== "manifest" || end?.kind !== "end") throw new Error("Missing backup envelope");
    end.stats = Object.fromEntries(manifest.tables.map(table => [table, records.filter(row => row.kind === "row" && row.table === table).length]));
    end.totalRecords = Object.values(end.stats).reduce((sum, count) => sum + count, 0);
    manifest.sequences = { ...manifest.sequences, notebook_entries: entryId + entries.length - 1, notebook_categories: categoryId + 1 };
  });
  const restored = await postEncryptedBackup(request, "/api/backup/restore", rewritten); expect(restored.status(), await restored.text()).toBe(200);
  return { categoryId, category };
}
async function all(request: APIRequestContext): Promise<NotebookEntry[]> {
  const response = await request.get(`${root}?limit=100`); expect(response.status()).toBe(200);
  const data = await response.json(); expect(data.nextCursor).toBeNull(); return data.items;
}

for (const width of [390, 1280]) {
  test(`错题目录 ${width}px：坏首页及串分类、来源、关键词整页拒绝，重读保留原文`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000); const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
    let initial = true; let filtered = 0; let writes = 0;
    try {
      const question = "完整原题 <T> &amp;\n内部  空格 " + "LongQuestion_".repeat(15);
      const answer = "原答 C++ <T> &amp; 100%_path\\file\n内部  空格"; const keyword = "c++ <t> &AMP; 100%_path\\file";
      const data = await seed(request, baseline.bytes, [
        { question, answer, source: "interview" }, { question: "另一来源原题", answer }, { question: "另一分类原题", answer, source: "interview", category: "second" },
      ]);
      const before = await all(request); const target = before.find(item => item.question === question)!;
      const wrongSource = before.find(item => item.source === "drill")!; const wrongCategory = before.find(item => item.category_id !== data.categoryId)!;
      await page.route(`**${root}**`, async route => {
        const url = new URL(route.request().url()); if (route.request().method() !== "GET") writes++;
        if (url.pathname !== root || route.request().method() !== "GET") return route.continue();
        if (initial) { initial = false; return route.fulfill({ json: { items: [target, null], nextCursor: null } }); }
        if (url.searchParams.get("category_id") === String(data.categoryId) && url.searchParams.get("source") === "interview" && url.searchParams.get("q") === keyword) {
          filtered++;
          if (filtered <= 3) return route.fulfill({ json: { items: [filtered === 1 ? wrongSource : filtered === 2 ? wrongCategory : { ...target, question: "串关键词的合成题", answer: "", comment: "", reference: keyword }], nextCursor: null } });
        }
        return route.continue();
      });
      await page.setViewportSize({ width, height: 900 }); await page.goto("/notebook");
      const error = page.getByRole("alert").filter({ hasText: "错题读取响应" }); await expect(error).toBeVisible(); await expect(page.getByRole("article")).toHaveCount(0);
      const source = page.getByRole("combobox", { name: "按来源过滤", exact: true }); const search = page.getByRole("searchbox", { name: "搜索错题", exact: true });
      await expect(source).toBeVisible(); await expect(search).toBeVisible();
      await error.getByRole("button", { name: "重试加载", exact: true }).click(); await expect(page.getByRole("article")).toHaveCount(3);
      await page.getByRole("button", { name: `${data.category}(2)`, exact: true }).click(); await source.selectOption("interview"); await search.fill(keyword);
      await expect(error).toBeVisible(); await expect(page.getByRole("article")).toHaveCount(0);
      for (let attempt = 2; attempt <= 3; attempt++) {
        await error.getByRole("button", { name: "重试加载", exact: true }).click(); await expect(error).toBeVisible(); expect(filtered).toBe(attempt); await expect(page.getByRole("article")).toHaveCount(0);
      }
      await error.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath(`notebook-list-invalid-${width}.png`), animations: "disabled" });
      await error.getByRole("button", { name: "重试加载", exact: true }).click(); await expect(page.getByRole("article")).toHaveCount(1);
      const row = page.getByRole("article", { name: `错题 #${target.id}`, exact: true }); const title = row.getByRole("heading", { level: 3 }).getByRole("button");
      expect(await title.textContent()).toBe(question); expect(await title.evaluate(element => getComputedStyle(element).whiteSpace)).toBe("pre-wrap");
      await title.focus(); await page.keyboard.press("Enter"); const review = row.getByRole("region"); await expect(review).toBeVisible();
      expect(await review.getByText(answer, { exact: true }).textContent()).toBe(answer);
      await source.scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: testInfo.outputPath(`notebook-list-literal-${width}.png`), fullPage: true, animations: "disabled" });
      await search.fill(target.reference); await expect(page.getByText("没有匹配的错题，试试调整分类、来源或关键词。", { exact: true })).toBeVisible(); await expect(page.getByRole("article")).toHaveCount(0);
      await expect(source).toHaveValue("interview"); await expect(search).toHaveValue(target.reference); expect(filtered).toBe(4); expect(writes).toBe(0); expect(await all(request)).toEqual(before);
    } finally { expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });

  test(`错题目录 ${width}px：跨回边界和坏尾游标整页拒绝，原游标重试仅追加后五题`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000); const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
    const cursors: string[] = []; let writes = 0;
    try {
      await seed(request, baseline.bytes, Array.from({ length: 55 }, (_, index) => ({ question: `目录续页 C++ <T> &amp; ${index + 1}` })));
      const before = await all(request); const boundary = before[49]!;
      await page.route(`**${root}**`, async route => {
        const url = new URL(route.request().url()); if (route.request().method() !== "GET") writes++;
        if (url.pathname !== root || !url.searchParams.has("cursor")) return route.continue();
        cursors.push(url.searchParams.get("cursor")!); const response = await route.fetch(); expect(response.ok()).toBe(true); const data = await response.json();
        if (cursors.length === 1) return route.fulfill({ json: { ...data, items: [boundary, ...data.items] } });
        if (cursors.length === 2) return route.fulfill({ json: { ...data, nextCursor: String(boundary.id - 1) } });
        return route.fulfill({ response });
      });
      await page.setViewportSize({ width, height: 900 }); await page.goto("/notebook"); const rows = page.getByRole("article"); await expect(rows).toHaveCount(50);
      await page.getByRole("button", { name: "加载更多", exact: true }).click(); const error = page.getByRole("alert").filter({ hasText: "错题读取响应" });
      await expect(error).toBeVisible(); await expect(rows).toHaveCount(50); await expect(page.getByRole("article", { name: `错题 #${before[50]!.id}`, exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "重试加载更多", exact: true }).click(); await expect(error).toBeVisible(); await expect(rows).toHaveCount(50);
      await error.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath(`notebook-list-cursor-error-${width}.png`), animations: "disabled" });
      await page.getByRole("button", { name: "重试加载更多", exact: true }).click(); await expect(rows).toHaveCount(55);
      for (const item of before) await expect(page.getByRole("article", { name: `错题 #${item.id}`, exact: true })).toHaveCount(1);
      expect(cursors).toEqual([String(boundary.id), String(boundary.id), String(boundary.id)]); expect(writes).toBe(0); expect(await all(request)).toEqual(before);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });

  test(`错题目录 ${width}px：删除当前分类后说明仍在筛选，可退出并查看未分类快照`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000); const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
    try {
      const data = await seed(request, baseline.bytes, [{ question: "分类删除后仍保留的收藏" }, { question: "另一分类收藏", category: "second" }]);
      const before = await all(request); const target = before.find(item => item.category_id === data.categoryId)!;
      await page.setViewportSize({ width, height: 900 }); await page.goto("/notebook");
      await page.getByRole("button", { name: `${data.category}(1)`, exact: true }).click(); await expect(page.getByRole("article")).toHaveCount(1);
      await page.getByRole("button", { name: "管理错题分类", exact: true }).click(); const manage = page.getByRole("dialog", { name: "管理分类", exact: true });
      await manage.getByRole("listitem").filter({ has: page.getByText(data.category, { exact: true }) }).getByRole("button", { name: "删除", exact: true }).click();
      const confirm = page.getByRole("dialog", { name: "删除分类", exact: true }); await confirm.getByRole("button", { name: "删除", exact: true }).click();
      await expect(manage.getByText(data.category, { exact: true })).toHaveCount(0); await manage.getByRole("button", { name: "完成", exact: true }).click();
      await expect(page.getByText(`当前分类：${data.category}`, { exact: false })).toBeVisible(); await expect(page.getByText("没有匹配的错题，试试调整分类、来源或关键词。", { exact: true })).toBeVisible();
      const clear = page.getByRole("button", { name: "全部错题", exact: true }); await expect(clear).toHaveAttribute("aria-pressed", "false");
      await clear.scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`notebook-list-missing-category-${width}.png`), animations: "disabled" });
      await clear.click(); await expect(page.getByRole("article")).toHaveCount(2); await page.getByRole("button", { name: "未分类", exact: true }).click();
      const row = page.getByRole("article", { name: `错题 #${target.id}`, exact: true }); await expect(row).toBeVisible(); await expect(page.getByRole("article")).toHaveCount(1);
      const after = await all(request); expect(after).toEqual(before.map(item => item.id === target.id ? { ...item, category_id: null, category_name: null } : item));
    } finally { expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });

  test(`错题目录 ${width}px：初始空目录和读取失败均保留来源与搜索入口`, async ({ page, request }, testInfo) => {
    const before = await all(request); expect(before).toEqual([]); let first = true; const queries: string[] = [];
    await page.route(`**${root}**`, async route => {
      const url = new URL(route.request().url()); if (url.pathname !== root) return route.continue(); queries.push(url.search);
      if (first) { first = false; return route.fulfill({ status: 503, json: { error: "合成空目录读取失败" } }); }
      return route.continue();
    });
    await page.setViewportSize({ width, height: 900 }); await page.goto("/notebook");
    await expect(page.getByRole("alert").filter({ hasText: "合成空目录读取失败" })).toBeVisible();
    const source = page.getByRole("combobox", { name: "按来源过滤", exact: true }); const search = page.getByRole("searchbox", { name: "搜索错题", exact: true });
    await expect(source).toBeVisible(); await expect(search).toBeVisible();
    await page.getByRole("button", { name: "重试加载", exact: true }).click(); await expect(page.getByText(/还没有收藏任何错题/)).toBeVisible();
    await source.selectOption("application_interview"); await search.fill("原答 <T> &amp;");
    await expect(page.getByText("没有匹配的错题，试试调整分类、来源或关键词。", { exact: true })).toBeVisible(); await expect(search).toHaveValue("原答 <T> &amp;");
    expect(queries.some(query => { const params = new URLSearchParams(query); return params.get("source") === "application_interview" && params.get("q") === "原答 <T> &amp;"; })).toBe(true);
    expect(await all(request)).toEqual(before); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`notebook-list-empty-filters-${width}.png`), animations: "disabled" });
  });
}
