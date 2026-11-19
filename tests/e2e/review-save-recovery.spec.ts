import { randomUUID } from "node:crypto";
import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { exportEncryptedBackup, postEncryptedBackup, rewriteEncryptedBackup } from "./backup-helpers";
import type { ReviewDetail } from "../../src/lib/spaced-repetition-card-types";

async function seed(request: APIRequestContext) {
  const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
  const timestamp = new Date().toISOString(); let notebookId = 0;
  const bytes = await rewriteEncryptedBackup(baseline.bytes, records => {
    for (let index = records.length - 1; index >= 0; index--) {
      const row = records[index]!;
      if (row.kind === "row" && (row.table === "review_cards" || row.table === "review_attempts")) records.splice(index, 1);
    }
    const nextId = (table: string) => Math.max(0, ...records.flatMap(row => row.kind === "row" && row.table === table ? [Number(row.data.id)] : [])) + 1;
    notebookId = nextId("notebook_entries");
    const sourceId = Math.max(0, ...records.flatMap(row => row.kind === "row" && row.table === "notebook_entries" ? [Number(row.data.source_id)] : [])) + 1;
    const add = (table: string, data: Record<string, unknown>) => records.splice(records.findIndex(row => row.kind === "end"), 0, { kind: "row", table, data });
    for (let index = 0; index < 2; index++) {
      add("notebook_entries", { id: notebookId + index, category_id: null, source: "interview", source_id: sourceId + index,
        source_label: "SourceToken".repeat(12), question: index === 0 ? `恢复复习原题 <T> &amp;\n内部  空格 ${"长原题".repeat(25)}` : "另一道复习原题",
        answer: " 原始现场回答 <T> &amp;\n内部  空格 ", comment: "原点评全文", reference: "原参考全文", scores: "", created_at: timestamp, updated_at: timestamp });
      add("review_cards", { id: index + 1, notebook_id: notebookId + index, drill_question_id: null, interval_days: 0, ease_factor: 250, repetitions: 0,
        review_count: 0, lapses: 0, next_review_date: timestamp.slice(0, 10), last_reviewed_at: "", created_at: timestamp });
    }
    const manifest = records.find(row => row.kind === "manifest")!; const end = records.find(row => row.kind === "end")!;
    if (manifest.kind !== "manifest" || end.kind !== "end") throw new Error("Missing backup envelope");
    end.stats = Object.fromEntries(manifest.tables.map(table => [table, records.filter(row => row.kind === "row" && row.table === table).length]));
    end.totalRecords = Object.values(end.stats).reduce((sum, count) => sum + count, 0);
    manifest.sequences = { ...manifest.sequences, notebook_entries: notebookId + 1, review_cards: Math.max(manifest.sequences?.review_cards ?? 0, 2) };
  });
  const response = await postEncryptedBackup(request, "/api/backup/restore", bytes); expect(response.status(), await response.text()).toBe(200);
  return { notebookId, restore: async () => { expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); } };
}
const getDetail = async (request: APIRequestContext, id = 1): Promise<ReviewDetail> => {
  const response = await request.get(`/api/reviews/${id}`); expect(response.ok()).toBe(true); return response.json();
};
const draft = "  本次独立回忆 <T> &amp;\n内部  空格  ";
async function prepare(page: Page) {
  await expect(page.getByRole("heading", { name: /恢复复习原题/ })).toBeVisible();
  await expect(page.getByText("原参考全文", { exact: true })).toHaveCount(0);
  await page.getByRole("textbox", { name: "本次回答" }).fill(draft);
  await page.getByRole("button", { name: "查看参考并自评" }).click(); await page.getByRole("button", { name: /基本掌握/ }).click();
}
async function capture(page: Page, testInfo: TestInfo, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath(name), fullPage: true });
}

for (const width of [390, 1280]) test.describe(`复习提交恢复 ${width}px`, () => {
  test.use({ viewport: { width, height: 900 }, timezoneId: "Asia/Tokyo" });

  test("串题详情拒绝，实际保存后坏确认、503及串编号只能只读恢复", async ({ page, request }, testInfo) => {
    test.setTimeout(90_000); const seeded = await seed(request);
    try {
      const original = await (await request.get(`/api/notebook/${seeded.notebookId}`)).json(); const other = await getDetail(request, 2);
      let initialReads = 0; let receiptReads = 0; let posts = 0;
      await page.route("**/api/reviews/**", async route => {
        const path = new URL(route.request().url()).pathname;
        if (route.request().method() === "POST" && path === "/api/reviews/1") {
          posts++; const response = await route.fetch(); expect(response.status()).toBe(200); const result = await response.json();
          return route.fulfill({ status: 200, json: { ...result, card: { ...result.card, id: 999 } } });
        }
        if (path.includes("/requests/")) {
          receiptReads++; if (receiptReads === 1) return route.fulfill({ status: 503, json: { error: "合成只读核对失败" } });
          const response = await route.fetch(); const result = await response.json();
          return route.fulfill({ response, json: receiptReads === 2 ? { ...result, request_id: randomUUID() } : result });
        }
        if (path === "/api/reviews/1" && ++initialReads === 1) return route.fulfill({ json: other });
        return route.continue();
      });
      await page.goto("/reviews?card=1"); await expect(page.getByRole("region", { name: "独立回忆复习" }).getByRole("alert")).toContainText("题目不符");
      await expect(page.getByText("另一道复习原题", { exact: true })).toHaveCount(0); await expect(page.getByRole("textbox")).toHaveCount(0);
      await page.getByRole("button", { name: "重试加载" }).click(); await prepare(page);
      await page.getByRole("button", { name: "保存本次复习" }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
      await expect(page.getByRole("button", { name: "重新读取保存状态" })).toBeVisible(); expect(posts).toBe(1);
      await expect(page.getByRole("textbox", { name: "本次回答" })).toHaveValue(draft); await expect(page.getByRole("textbox", { name: "本次回答" })).toBeDisabled();
      await capture(page, testInfo, `review-unknown-${width}.png`);
      await page.getByRole("button", { name: "重新读取保存状态" }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
      await expect(page.getByRole("region", { name: "独立回忆复习" }).getByRole("alert")).toContainText("提交不符"); expect(receiptReads).toBe(2); expect(posts).toBe(1);
      await page.getByRole("button", { name: "重新读取保存状态" }).click(); await expect(page.getByText("本次复习已保存", { exact: true })).toBeVisible();
      const saved = await getDetail(request); expect(saved.review_count).toBe(1); expect(saved.attempts).toHaveLength(1); expect(saved.attempts[0]).toMatchObject({ answer: draft.trim(), grade: "good" });
      expect(await (await request.get(`/api/notebook/${seeded.notebookId}`)).json()).toEqual(original); expect(await getDetail(request, 2)).toEqual(other); expect(posts).toBe(1);
    } finally { await seeded.restore(); }
  });

  test("404 后原提交稍后完成，显式同编号重试仍只计一次", async ({ page, request }, testInfo) => {
    test.setTimeout(90_000); const seeded = await seed(request);
    try {
      const bodies: Record<string, unknown>[] = [];
      await page.route("**/api/reviews/1", async route => {
        if (route.request().method() !== "POST") return route.continue(); bodies.push(route.request().postDataJSON());
        if (bodies.length === 1) return route.fulfill({ status: 503, json: { error: "合成未到达写入" } });
        return route.fulfill({ response: await route.fetch() });
      });
      await page.goto("/reviews?card=1"); await prepare(page); await page.getByRole("button", { name: "保存本次复习" }).click();
      await expect(page.getByRole("button", { name: "重试同一提交" })).toBeVisible(); expect((await getDetail(request)).review_count).toBe(0);
      await expect(page.getByRole("textbox", { name: "本次回答" })).toHaveValue(draft); await capture(page, testInfo, `review-missing-${width}.png`);
      // 模拟原在途提交在404读取之后到达，随后仍重放相同编号与正文。
      const delayed = await request.post("/api/reviews/1", { data: bodies[0] }); expect(delayed.status()).toBe(200);
      await page.getByRole("button", { name: "重试同一提交" }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
      await expect(page.getByText("本次复习已保存", { exact: true })).toBeVisible(); expect(bodies).toHaveLength(2); expect(bodies[1]).toEqual(bodies[0]);
      const saved = await getDetail(request); expect(saved.review_count).toBe(1); expect(saved.attempts).toHaveLength(1); expect(saved.attempts[0]!.answer).toBe(draft.trim());
    } finally { await seeded.restore(); }
  });

  test("25条历史的坏续页恢复，真实409保留原稿，重载后显式保存并读取完整新历史", async ({ page, request }, testInfo) => {
    test.setTimeout(90_000); const seeded = await seed(request);
    try {
      for (let index = 0; index < 25; index++) {
        const response = await request.post("/api/reviews/1", { data: { answer: `历史原答 #${index + 1} <T> &amp;\n内部  空格`, grade: "good", expected_review_count: index, request_id: randomUUID(), time_zone: "Asia/Tokyo" } }); expect(response.status()).toBe(200);
      }
      const original = await (await request.get(`/api/notebook/${seeded.notebookId}`)).json();
      const cursors: string[] = []; let brokenPage = true; let failReload = false; const bodies: Record<string, unknown>[] = [];
      await page.route("**/api/reviews/1**", async route => {
        const url = new URL(route.request().url());
        if (route.request().method() === "POST") { bodies.push(route.request().postDataJSON()); return route.continue(); }
        if (url.pathname !== "/api/reviews/1") return route.continue();
        const cursor = url.searchParams.get("cursor");
        if (cursor) {
          cursors.push(cursor); const response = await route.fetch(); const result = await response.json();
          if (brokenPage) { brokenPage = false; return route.fulfill({ response, json: { ...result, nextCursor: "99999" } }); }
          return route.fulfill({ response });
        }
        if (failReload) { failReload = false; return route.fulfill({ status: 503, json: { error: "合成最新进度读取失败" } }); }
        return route.continue();
      });
      await page.goto("/reviews?card=1"); await prepare(page); await page.getByRole("button", { name: "查看复习历史", exact: true }).click();
      const history = page.getByRole("region", { name: "复习历史记录" }); await expect(history.getByRole("listitem")).toHaveCount(20);
      await history.getByRole("button", { name: "加载更多历史" }).click(); await expect(history.getByRole("alert")).toContainText("不完整"); await expect(history.getByRole("listitem")).toHaveCount(20);
      await history.getByRole("button", { name: "重试加载历史" }).click(); await expect(history.getByRole("listitem")).toHaveCount(25); expect(cursors[0]).toBe(cursors[1]);
      const elsewhere = await request.post("/api/reviews/1", { data: { answer: "另一页面的新复习", grade: "easy", expected_review_count: 25, request_id: randomUUID(), time_zone: "Asia/Tokyo" } }); expect(elsewhere.status()).toBe(200);
      await page.getByRole("button", { name: "保存本次复习" }).click(); await expect(page.getByRole("button", { name: "重新加载最新进度" })).toBeVisible();
      failReload = true; await page.getByRole("button", { name: "重新加载最新进度" }).click(); await expect(page.getByText("合成最新进度读取失败", { exact: true })).toBeVisible();
      await expect(page.getByRole("textbox", { name: "本次回答" })).toHaveValue(draft); await capture(page, testInfo, `review-conflict-${width}.png`);
      await page.getByRole("button", { name: "重试加载", exact: true }).click(); await expect(page.getByRole("button", { name: "保存本次复习" })).toBeEnabled();
      await expect(page.getByText(/复习进度已变更，本次提交尚未找到/)).toHaveCount(0);
      await page.getByRole("button", { name: "保存本次复习" }).click(); await expect(page.getByText("本次复习已保存", { exact: true })).toBeVisible();
      await expect(history.getByRole("listitem")).toHaveCount(20); await history.getByRole("button", { name: "加载更多历史" }).click(); await expect(history.getByRole("listitem")).toHaveCount(27);
      expect(bodies).toHaveLength(2); expect(bodies[0]!.expected_review_count).toBe(25); expect(bodies[1]!.expected_review_count).toBe(26); expect(bodies[0]!.request_id).not.toBe(bodies[1]!.request_id);
      const saved = await getDetail(request); expect(saved.review_count).toBe(27); expect(saved.attempts[0]!.answer).toBe(draft.trim());
      expect(await (await request.get(`/api/notebook/${seeded.notebookId}`)).json()).toEqual(original);
    } finally { await seeded.restore(); }
  });
});
