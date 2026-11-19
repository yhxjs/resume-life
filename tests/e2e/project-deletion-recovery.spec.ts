import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { emptySummary } from "../../src/lib/summary";
import { exportEncryptedBackup, postEncryptedBackup, rewriteEncryptedBackup } from "./backup-helpers";
import { gate } from "./synthetic-api";

async function get(request: APIRequestContext, url: string) { const response = await request.get(url); expect(response.status(), await response.text()).toBe(200); return response.json(); }
async function create(request: APIRequestContext, name = "项目删除 <T> &amp; " + "完整名称_".repeat(40)) {
  const response = await request.post("/api/projects", { data: { name } }); expect(response.status()).toBe(201); return (await response.json()).id as number;
}
const card = (page: Page, id: number) => page.locator("div.group").filter({ has: page.locator(`a[href="/knowledge/${id}"]`).first() });
async function seedCascade(request: APIRequestContext) {
  const id = await create(request); const otherId = await create(request, "另一份项目必须保留");
  for (const title of ["架构设计", "故障复盘"]) expect((await request.post(`/api/projects/${id}/materials`, { data: { title, content: "原始材料 <T> &amp;\n内部  空格" } })).status()).toBe(201);
  expect((await request.patch(`/api/projects/${id}`, { data: { summary: { ...emptySummary(), overview: "真实项目原文 <T> &amp;", achievements: ["未统计收益"] }, expectedRevisionId: 0 } })).status()).toBe(200);
  const resumeResponse = await request.post("/api/resumes", { data: { title: "已摘取项目的简历", modules: { summary: { text: "已摘取的项目成果 <T> &amp;\n内部  空格" } } } }); expect(resumeResponse.status()).toBe(201); const resumeId = (await resumeResponse.json()).id as number;
  const backup = await exportEncryptedBackup(request); expect(backup.response.ok()).toBe(true);
  const ids: Record<string, number> = {}; const timestamp = "2026-11-03T00:00:00.000Z";
  const rewritten = await rewriteEncryptedBackup(backup.bytes, records => {
    const tables = ["drills", "drill_questions", "notebook_entries", "review_cards"] as const;
    for (const table of tables) ids[table] = Math.max(0, ...records.flatMap(row => row.kind === "row" && row.table === table ? [Number(row.data.id)] : [])) + 1;
    const add = (table: string, data: Record<string, unknown>) => records.splice(records.findIndex(row => row.kind === "end"), 0, { kind: "row", table, data });
    add("drills", { id: ids.drills, source: "project", project_id: id, direction: "", jd: "", interview_id: null, focus: "", created_at: timestamp });
    for (let offset = 0; offset < 2; offset++) add("drill_questions", { id: ids.drill_questions! + offset, drill_id: ids.drills, idx: offset + 1, question: `原项目题 ${offset}`, answer: "原回答 <T> &amp;", comment: "原点评", reference: "参考", scores: "", answered_at: timestamp, kind: "" });
    add("notebook_entries", { id: ids.notebook_entries, category_id: null, source: "drill", source_id: ids.drill_questions! + 1, source_label: "独立项目收藏", question: "原项目题 1", answer: "原回答 <T> &amp;", comment: "原点评", reference: "参考", scores: "", created_at: timestamp, updated_at: timestamp });
    for (let offset = 0; offset < 2; offset++) add("review_cards", { id: ids.review_cards! + offset, notebook_id: offset ? ids.notebook_entries : null, drill_question_id: offset ? null : ids.drill_questions, interval_days: 0, ease_factor: 250, repetitions: 0, review_count: 0, lapses: 0, next_review_date: "2026-11-03", last_reviewed_at: "", created_at: timestamp });
    const manifest = records.find(row => row.kind === "manifest"); const end = records.find(row => row.kind === "end"); if (manifest?.kind !== "manifest" || end?.kind !== "end") throw new Error("Missing backup envelope");
    const rows = records.filter(row => row.kind === "row").sort((a, b) => manifest.tables.indexOf(a.table) - manifest.tables.indexOf(b.table) || Number(a.data.id ?? 0) - Number(b.data.id ?? 0));
    const files = records.filter(row => row.kind === "file"); records.splice(0, records.length, manifest, ...rows, ...files, end);
    end.stats = Object.fromEntries(manifest.tables.map(table => [table, rows.filter(row => row.table === table).length])); end.totalRecords = rows.length;
    for (const table of tables) manifest.sequences[table] = ids[table]! + (["drill_questions", "review_cards"].includes(table) ? 1 : 0);
  });
  const restored = await postEncryptedBackup(request, "/api/backup/restore", rewritten); expect(restored.status(), await restored.text()).toBe(200);
  for (const cardId of [ids.review_cards!, ids.review_cards! + 1]) expect((await request.post(`/api/reviews/${cardId}`, { data: { answer: "复习原答 <T> &amp;", grade: "good", expected_review_count: 0, request_id: randomUUID() } })).status()).toBe(200);
  return { id, otherId, resumeId, ids };
}

for (const width of [390, 1280]) {
  test(`项目删除 ${width}px：离页关闭确认，取消与Escape归还焦点，零写入`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000); const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true); let deletes = 0;
    try {
      const id = await create(request); const before = await get(request, `/api/projects/${id}`);
      await page.route(`**/api/projects/${id}`, route => { if (route.request().method() === "DELETE") deletes++; return route.continue(); });
      await page.setViewportSize({ width, height: 900 }); await page.goto("/knowledge"); await expect(card(page, id)).toBeVisible();
      await page.locator('a[href="/"]').first().click(); await expect(page).toHaveURL(/\/$/); await page.goBack();
      await card(page, id).getByRole("button", { name: "删除档案", exact: true }).click(); await expect(page.getByRole("dialog", { name: "删除项目", exact: true })).toBeVisible();
      await page.goForward(); await expect(page).toHaveURL(/\/$/); await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.goBack(); const button = card(page, id).getByRole("button", { name: "删除档案", exact: true }); await button.click();
      const dialog = page.getByRole("dialog", { name: "删除项目", exact: true }); await expect(dialog).toContainText(`#${id}`); await expect(dialog).toContainText(before.name); await expect(dialog).toContainText("总结历史");
      await page.screenshot({ path: testInfo.outputPath(`project-delete-confirm-${width}.png`), animations: "disabled" }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await dialog.getByRole("button", { name: "取消", exact: true }).click(); await expect(button).toBeFocused();
      await button.evaluate(node => { (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click(); }); await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0); await expect(button).toBeFocused();
      expect(deletes).toBe(0); expect(await get(request, `/api/projects/${id}`)).toEqual(before);
    } finally { await page.goto("/"); expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });

  test(`项目删除 ${width}px：异常只读核对后重确认，真实级联且独立收藏简历保留`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000); const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true); let deletes = 0; let reads = 0;
    try {
      const data = await seedCascade(request); const endpoint = `/api/projects/${data.id}`; const before = await get(request, endpoint); const other = await get(request, `/api/projects/${data.otherId}`); const resume = await get(request, `/api/resumes/${data.resumeId}`);
      const notebook = await get(request, `/api/notebook/${data.ids.notebook_entries}`); const review = await get(request, `/api/reviews/${data.ids.review_cards! + 1}`);
      expect(before.materials).toHaveLength(2); expect((await get(request, `${endpoint}/summary-history`)).items).toHaveLength(1);
      await page.route(`**${endpoint}`, async route => {
        if (route.request().method() === "DELETE") { deletes++; if (deletes === 1) return route.fulfill({ json: {} }); const response = await route.fetch(); expect(response.status()).toBe(200); return route.fulfill({ json: { ok: "true" } }); }
        reads++; if (reads === 1) return route.fulfill({ status: 503, json: { error: "合成删除核对失败" } }); if (reads === 2) return route.fulfill({ json: { ...before, id: data.otherId } }); return route.continue();
      });
      await page.setViewportSize({ width, height: 900 }); await page.goto("/knowledge"); const row = card(page, data.id); const remove = row.getByRole("button", { name: "删除档案", exact: true }); const name = page.getByRole("textbox", { name: "项目名称", exact: true }); await name.fill("保留的新建名称");
      await remove.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
      const dialog = page.getByRole("dialog", { name: "删除项目", exact: true }); for (const text of ["2 份材料", "总结历史", "练习", "复习", "收藏", "简历"]) await expect(dialog).toContainText(text);
      await dialog.getByRole("button", { name: "删除", exact: true }).click(); const error = page.getByRole("alert").filter({ hasText: "删除结果尚未确认" }); await expect(error).toContainText("合成删除核对失败"); await expect(remove).toBeDisabled(); await expect(name).toBeDisabled();
      const reread = page.getByRole("button", { name: "重新读取删除状态", exact: true }); await reread.click(); await expect(error).toContainText("不属于当前项目"); expect(deletes).toBe(1);
      await reread.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath(`project-delete-unknown-${width}.png`), animations: "disabled" }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await reread.click(); await expect(page.getByRole("alert").filter({ hasText: "目前仍存在" })).toBeVisible(); await expect(remove).toBeEnabled(); expect(await get(request, endpoint)).toEqual(before);
      await remove.click(); await dialog.getByRole("button", { name: "删除", exact: true }).click(); await expect(row).toHaveCount(0); expect(deletes).toBe(2); expect(reads).toBe(4); await expect(name).toHaveValue("保留的新建名称");
      for (const url of [endpoint, `/api/drills/${data.ids.drills}`, `/api/reviews/${data.ids.review_cards}`]) expect((await request.get(url)).status(), url).toBe(404);
      const after = await exportEncryptedBackup(request); expect(after.response.ok()).toBe(true);
      await rewriteEncryptedBackup(after.bytes, records => {
        for (const table of ["project_materials", "project_summary_history", "drills"]) expect(records.filter(row => row.kind === "row" && row.table === table && row.data.project_id === data.id), table).toHaveLength(0);
        expect(records.filter(row => row.kind === "row" && row.table === "drill_questions" && row.data.drill_id === data.ids.drills)).toHaveLength(0);
        expect(records.filter(row => row.kind === "row" && row.table === "review_attempts" && row.data.card_id === data.ids.review_cards)).toHaveLength(0);
        expect(records.filter(row => row.kind === "row" && row.table === "review_attempts" && row.data.card_id === data.ids.review_cards! + 1)).toHaveLength(1);
      });
      expect(await get(request, `/api/notebook/${data.ids.notebook_entries}`)).toEqual(notebook); expect(await get(request, `/api/reviews/${data.ids.review_cards! + 1}`)).toEqual(review); expect(await get(request, `/api/resumes/${data.resumeId}`)).toEqual(resume); expect(await get(request, `/api/projects/${data.otherId}`)).toEqual(other);
    } finally { await page.goto("/"); expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });

  test(`项目目录 ${width}px：新建同事件互斥，离页后真实写入迟到回复不导航`, async ({ page, request }) => {
    test.setTimeout(90_000); const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true); const pending = gate(); const saved = gate(); const delivered = gate(); let posts = 0; let deletes = 0;
    try {
      const id = await create(request, "原项目必须保留");
      await page.route("**/api/projects", async route => { if (route.request().method() !== "POST") return route.continue(); posts++; const response = await route.fetch(); expect(response.status()).toBe(201); saved.release(); await pending.promise; try { await route.fulfill({ response }); } catch { /* 离页取消本地等待。 */ } finally { delivered.release(); } });
      await page.route(`**/api/projects/${id}`, route => { if (route.request().method() === "DELETE") deletes++; return route.continue(); });
      await page.setViewportSize({ width, height: 900 }); await page.goto("/knowledge"); await expect(card(page, id)).toBeVisible(); await page.getByRole("textbox", { name: "项目名称", exact: true }).fill("新建项目原稿");
      await page.getByRole("button", { name: "立即创建", exact: true }).evaluate(node => { (node as HTMLButtonElement).click(); document.querySelectorAll<HTMLButtonElement>("button").forEach(button => { if (button.textContent?.trim() === "删除档案") button.click(); }); (node as HTMLButtonElement).click(); });
      await saved.promise; expect(posts).toBe(1); expect(deletes).toBe(0); await expect(page.getByRole("dialog")).toHaveCount(0); await expect(card(page, id).getByRole("button", { name: "删除档案", exact: true })).toBeDisabled();
      await page.locator('a[href="/"]').first().click(); await expect(page).toHaveURL(/\/$/); pending.release(); await delivered.promise; await page.getByRole("heading", { level: 1 }).waitFor(); await expect(page).toHaveURL(/\/$/);
      expect((await get(request, "/api/projects")).filter((row: { name: string }) => row.name === "新建项目原稿")).toHaveLength(1); expect(posts).toBe(1); expect(deletes).toBe(0);
    } finally { pending.release(); await page.goto("/"); expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });
}
