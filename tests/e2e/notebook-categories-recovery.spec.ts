import { expect, test, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { exportEncryptedBackup, postEncryptedBackup, rewriteEncryptedBackup } from "./backup-helpers";

const root = "/api/notebook/categories";
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
async function get(request: APIRequestContext, url: string) {
  const response = await request.get(url); expect(response.status(), await response.text()).toBe(200); return response.json();
}
async function seed(request: APIRequestContext, bytes: Buffer) {
  let categoryId = 0; let entryId = 0; let drillId = 0; let cardId = 0; let questionId = 0;
  const category = "历史分类 <T> &amp; " + "LongCategory_".repeat(10); const question = "原题 <T> &amp;\n内部  空格 " + "LongQuestion_".repeat(15); const timestamp = "2026-10-29T00:00:00.000Z";
  const rewritten = await rewriteEncryptedBackup(bytes, records => {
    const next = (table: string) => Math.max(0, ...records.flatMap(row => row.kind === "row" && row.table === table ? [Number(row.data.id)] : [])) + 1;
    categoryId = next("notebook_categories"); entryId = next("notebook_entries"); drillId = next("drills"); cardId = next("review_cards"); questionId = next("drill_questions");
    const add = (table: string, data: Record<string, unknown>) => records.splice(records.findIndex(row => row.kind === "end"), 0, { kind: "row", table, data });
    add("notebook_categories", { id: categoryId, name: category, created_at: timestamp }); add("notebook_categories", { id: categoryId + 1, name: "目标分类", created_at: timestamp });
    add("drills", { id: drillId, source: "bank", project_id: null, direction: "分类恢复验证", jd: "", interview_id: null, focus: "", created_at: timestamp });
    const snapshot = { question, answer: "原答：只参与参数校验 <T> &amp;\n尚未上线。", comment: "原点评", reference: "原参考", scores: "" };
    add("drill_questions", { id: questionId, drill_id: drillId, idx: 1, ...snapshot, answered_at: timestamp, kind: "tech" });
    add("notebook_entries", { id: entryId, category_id: categoryId, source: "interview", source_id: questionId, source_label: "独立收藏快照", ...snapshot, created_at: timestamp, updated_at: timestamp });
    add("review_cards", { id: cardId, notebook_id: entryId, drill_question_id: null, interval_days: 0, ease_factor: 250, repetitions: 0, review_count: 0, lapses: 0, next_review_date: "2026-10-29", last_reviewed_at: "", created_at: timestamp });
    const manifest = records.find(row => row.kind === "manifest"); const end = records.find(row => row.kind === "end"); if (manifest?.kind !== "manifest" || end?.kind !== "end") throw new Error("Missing backup envelope");
    end.stats = Object.fromEntries(manifest.tables.map(table => [table, records.filter(row => row.kind === "row" && row.table === table).length])); end.totalRecords = Object.values(end.stats).reduce((sum, count) => sum + count, 0);
    manifest.sequences = { ...manifest.sequences, notebook_categories: categoryId + 1, notebook_entries: entryId, drills: drillId, drill_questions: questionId, review_cards: cardId };
  });
  const restored = await postEncryptedBackup(request, "/api/backup/restore", rewritten); expect(restored.status(), await restored.text()).toBe(200);
  expect((await request.post(`/api/reviews/${cardId}`, { data: { answer: "复习原答", grade: "good", expected_review_count: 0, request_id: randomUUID() } })).status()).toBe(200);
  const application = await request.post("/api/applications", { data: { company: "分类恢复公司", role: "接口工程师", stage: "interested" } }); expect(application.status()).toBe(201); const applicationId = (await application.json()).id as number;
  expect((await request.post(`/api/applications/${applicationId}/preparation/resources`, { data: { kind: "notebook", id: entryId } })).status()).toBe(200);
  return { categoryId, entryId, drillId, cardId, questionId, applicationId, category, question };
}

for (const width of [390, 1280]) {
  test(`错题分类 ${width}px：确认随离页取消，返回取消归还焦点且连续点击只删除一次`, async ({ page, request }) => {
    test.setTimeout(90_000); const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true); let deletes = 0;
    try {
      const data = await seed(request, baseline.bytes); const endpoint = `${root}/${data.categoryId}`;
      const before = await get(request, endpoint); const snapshot = await get(request, `/api/notebook/${data.entryId}`); const review = await get(request, `/api/reviews/${data.cardId}`);
      await page.route(`**${endpoint}`, route => { if (route.request().method() === "DELETE") deletes++; return route.continue(); });
      await page.setViewportSize({ width, height: 900 }); await page.goto("/notebook");
      await page.locator('a[href="/"]').first().click(); await expect(page).toHaveURL(/\/$/); await page.goBack();
      const open = async () => {
        await page.getByRole("button", { name: "管理错题分类", exact: true }).click();
        const manage = page.getByRole("dialog", { name: "管理分类", exact: true });
        const row = manage.getByRole("listitem").filter({ has: page.getByText(data.category, { exact: true }) });
        const remove = row.getByRole("button", { name: "删除", exact: true }); await remove.click(); return { manage, row, remove };
      };
      await open(); await expect(page.getByRole("dialog", { name: "删除分类", exact: true })).toBeVisible();
      await page.goForward(); await expect(page).toHaveURL(/\/$/); await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(deletes).toBe(0); expect(await get(request, endpoint)).toEqual(before);
      await page.goBack(); const { manage, row, remove } = await open();
      const confirmation = page.getByRole("dialog", { name: "删除分类", exact: true }); await expect(confirmation).toContainText(data.category);
      await confirmation.getByRole("button", { name: "取消", exact: true }).click(); await expect(remove).toBeFocused(); expect(deletes).toBe(0);
      await remove.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
      await page.keyboard.press("Escape"); await expect(confirmation).toHaveCount(0); await expect(remove).toBeFocused(); await expect(manage).toBeVisible();
      expect(deletes).toBe(0); expect(await get(request, endpoint)).toEqual(before);
      await remove.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
      await confirmation.getByRole("button", { name: "删除", exact: true }).click(); await expect(row).toHaveCount(0); await expect(confirmation).toHaveCount(0); expect(deletes).toBe(1);
      expect((await request.get(endpoint)).status()).toBe(404); expect(await get(request, `/api/notebook/${data.entryId}`)).toEqual({ ...snapshot, category_id: null });
      expect(await get(request, `/api/reviews/${data.cardId}`)).toEqual(review);
      await manage.getByRole("button", { name: "完成", exact: true }).click(); await expect(page.getByRole("dialog")).toHaveCount(0);
    } finally { await page.goto("/"); expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });

  test(`错题分类 ${width}px：坏读取可恢复，改名与删除未知结果只读核对且复习关联保留`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000); const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
    let badList = true; let patches = 0; let deletes = 0; let reads = 0; const pending = gate(); const reading = gate();
    try {
      const data = await seed(request, baseline.bytes); const endpoint = `${root}/${data.categoryId}`;
      const snapshot = await get(request, `/api/notebook/${data.entryId}`); const review = await get(request, `/api/reviews/${data.cardId}`);
      const resources = await get(request, `/api/applications/${data.applicationId}/preparation/resources?kind=notebook`); const source = await get(request, `/api/drills/${data.drillId}`);
      const desired = "  新分类 <T> &amp;  ";
      await page.route(`**${root}**`, async route => {
        const url = new URL(route.request().url()); const method = route.request().method();
        if (url.pathname === root && method === "GET" && badList) return route.fulfill({ json: [null] });
        if (url.pathname !== endpoint) return route.continue();
        if (method === "PATCH" || method === "DELETE") { if (method === "PATCH") patches++; else deletes++; const response = await route.fetch(); expect(response.status()).toBe(200); return route.fulfill({ json: { ok: "true" } }); }
        if (method === "GET") {
          reads++; if (reads === 1 || reads === 4) return route.fulfill({ status: 503, json: { error: "合成分类核对失败" } });
          if (reads === 2) return route.fulfill({ json: { id: data.categoryId + 1, name: desired.trim(), entry_count: 1 } });
          if (reads === 3) { reading.release(); await pending.promise; }
        }
        return route.continue();
      });
      await page.setViewportSize({ width, height: 900 }); await page.goto("/notebook"); await page.getByRole("button", { name: "管理错题分类", exact: true }).click();
      const manage = page.getByRole("dialog", { name: "管理分类", exact: true }); await expect(manage.getByRole("alert")).toContainText("分类响应不完整");
      badList = false; await manage.getByRole("button", { name: "重试加载分类", exact: true }).click();
      const categoryRow = manage.getByRole("listitem").filter({ has: page.getByText(data.category, { exact: true }) }); await categoryRow.getByRole("button", { name: "重命名", exact: true }).click();
      const input = manage.getByRole("textbox", { name: `重命名分类：${data.category}`, exact: true }); await input.fill(desired);
      await manage.getByRole("button", { name: "保存", exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
      await expect(manage.getByRole("alert")).toContainText("合成分类核对失败"); await expect(input).toHaveValue(desired); await expect(manage.getByRole("button", { name: "完成", exact: true })).toBeDisabled(); expect(patches).toBe(1);
      const reread = manage.getByRole("button", { name: "重新读取分类状态", exact: true }); await reread.click(); await expect(manage.getByRole("alert")).toContainText("记录不符");
      await page.screenshot({ path: testInfo.outputPath(`category-rename-unknown-${width}.png`), animations: "disabled" }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await reread.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); }); await reading.promise; expect(reads).toBe(3); pending.release();
      const renamed = manage.getByRole("listitem").filter({ has: page.getByText(desired.trim(), { exact: true }) }); await expect(renamed).toBeVisible(); expect(patches).toBe(1);
      await renamed.getByRole("button", { name: "删除", exact: true }).click(); const confirm = page.getByRole("dialog", { name: "删除分类", exact: true }); await expect(confirm).toContainText(`#${data.categoryId}`); await expect(confirm).toContainText("复习历史和求职准备关联继续保留");
      await confirm.getByRole("button", { name: "取消", exact: true }).click(); expect(deletes).toBe(0);
      await renamed.getByRole("button", { name: "删除", exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); }); await expect(confirm).toBeVisible(); await confirm.getByRole("button", { name: "删除", exact: true }).click();
      await expect(manage.getByRole("alert")).toContainText("合成分类核对失败"); await manage.getByRole("button", { name: "重新读取分类状态", exact: true }).click(); await expect(renamed).toHaveCount(0); expect(deletes).toBe(1); expect(reads).toBe(5);
      await manage.getByRole("button", { name: "完成", exact: true }).click(); await expect(page.getByRole("article", { name: `错题 #${data.entryId}`, exact: true })).toContainText("未分类");
      expect(await get(request, `/api/notebook/${data.entryId}`)).toEqual({ ...snapshot, category_id: null }); expect(await get(request, `/api/reviews/${data.cardId}`)).toEqual(review);
      expect(await get(request, `/api/applications/${data.applicationId}/preparation/resources?kind=notebook`)).toEqual(resources); expect(await get(request, `/api/drills/${data.drillId}`)).toEqual(source);
    } finally { pending.release(); expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });

  test(`错题分类 ${width}px：创建坏回包保留原稿，只读确认唯一名称后刷新，零重复创建`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000); const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true); let posts = 0; let recovering = false; let failRead = true;
    try {
      await seed(request, baseline.bytes); const name = "  新建分类 <T> &amp;  ";
      await page.route(`**${root}**`, async route => {
        const url = new URL(route.request().url()); if (url.pathname !== root) return route.continue();
        if (route.request().method() === "POST") { posts++; const response = await route.fetch(); expect(response.status()).toBe(201); recovering = true; return route.fulfill({ json: { id: "bad", name: name.trim() } }); }
        if (recovering && failRead) return route.fulfill({ json: [{ id: 0, name: name.trim(), entry_count: 0 }] });
        return route.continue();
      });
      await page.setViewportSize({ width, height: 900 }); await page.goto("/notebook"); await page.getByRole("button", { name: "管理错题分类", exact: true }).click(); const manage = page.getByRole("dialog", { name: "管理分类", exact: true });
      const input = manage.getByRole("textbox", { name: "新分类名称", exact: true }); await input.fill(name); await manage.getByRole("button", { name: "新建", exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
      await expect(manage.getByRole("alert")).toContainText("分类操作结果尚未确认"); await expect(input).toHaveValue(name); await expect(manage.getByRole("button", { name: "新建", exact: true })).toBeDisabled(); expect(posts).toBe(1);
      await page.screenshot({ path: testInfo.outputPath(`category-create-unknown-${width}.png`), animations: "disabled" }); failRead = false;
      await manage.getByRole("button", { name: "重新读取分类状态", exact: true }).click(); await expect(input).toHaveValue(""); await expect(manage.getByText(name.trim(), { exact: true })).toBeVisible();
      expect(posts).toBe(1); const categories = await get(request, root); expect(categories.filter((category: { name: string }) => category.name === name.trim())).toHaveLength(1); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });

  test(`错题分类 ${width}px：移动坏确认不清原选择，显式再保存后只读核对同一收藏`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000); const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true); let patches = 0; let reads = 0;
    try {
      const data = await seed(request, baseline.bytes); const endpoint = `/api/notebook/${data.entryId}`; const before = await get(request, endpoint); const review = await get(request, `/api/reviews/${data.cardId}`);
      await page.route(`**${endpoint}`, async route => {
        if (route.request().method() === "PATCH") { patches++; if (patches === 1) return route.fulfill({ json: {} }); const response = await route.fetch(); expect(response.status()).toBe(200); return route.fulfill({ json: {} }); }
        reads++; if (reads === 2) return route.fulfill({ json: { ...before, id: data.entryId + 1, category_id: data.categoryId + 1 } }); return route.continue();
      });
      await page.setViewportSize({ width, height: 900 }); await page.goto("/notebook"); await page.getByRole("article", { name: `错题 #${data.entryId}`, exact: true }).getByRole("button", { name: "分类", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "移动到分类", exact: true }); await expect(dialog).toContainText(data.question); const target = dialog.getByRole("button", { name: "目标分类", exact: true }); await target.click();
      await dialog.getByRole("button", { name: "保存", exact: true }).click(); await expect(dialog.getByRole("alert")).toContainText("尚未符合本次操作"); await expect(target).toHaveAttribute("aria-pressed", "true"); expect(patches).toBe(1);
      expect(await get(request, endpoint)).toEqual(before); await dialog.getByRole("button", { name: "保存", exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
      await expect(dialog.getByRole("alert")).toContainText("记录不符"); await expect(target).toBeDisabled(); await expect(dialog.getByRole("button", { name: "取消", exact: true })).toBeDisabled(); expect(patches).toBe(2);
      await page.screenshot({ path: testInfo.outputPath(`category-move-unknown-${width}.png`), animations: "disabled" });
      await dialog.getByRole("button", { name: "重新读取分类状态", exact: true }).click(); await expect(dialog).toHaveCount(0); expect(patches).toBe(2); expect(reads).toBe(3);
      expect(await get(request, endpoint)).toEqual({ ...before, category_id: data.categoryId + 1 }); expect(await get(request, `/api/reviews/${data.cardId}`)).toEqual(review); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });

  test(`错题分类 ${width}px：行内创建与收藏双向互斥，输入法确认不触发创建`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000); const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true); const creating = gate(); const favoriting = gate(); let categoryPosts = 0; let notebookPosts = 0;
    try {
      const data = await seed(request, baseline.bytes); const name = "行内分类 <T> &amp;";
      await page.route("**/api/notebook**", async route => {
        const url = new URL(route.request().url()); if (route.request().method() !== "POST") return route.continue();
        if (url.pathname === root) { categoryPosts++; await creating.promise; }
        if (url.pathname === "/api/notebook") { notebookPosts++; await favoriting.promise; }
        return route.continue();
      });
      await page.setViewportSize({ width, height: 900 }); await page.goto(`/drills/${data.drillId}`); await page.getByRole("button", { name: "收藏到错题本", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "收藏到错题本", exact: true }); await dialog.getByRole("button", { name: "+ 新建分类", exact: true }).click(); const input = dialog.getByRole("textbox", { name: "新分类名称", exact: true }); await input.fill(name);
      await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true }); expect(categoryPosts).toBe(0);
      await dialog.getByRole("button", { name: "创建", exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
      await expect.poll(() => categoryPosts).toBe(1); const favorite = dialog.getByRole("button", { name: "收藏", exact: true }); await expect(favorite).toBeDisabled(); await expect(dialog.getByRole("button", { name: "取消", exact: true })).toBeDisabled(); expect(notebookPosts).toBe(0);
      await page.screenshot({ path: testInfo.outputPath(`category-inline-wait-${width}.png`), animations: "disabled" }); creating.release();
      await expect(dialog.getByRole("button", { name, exact: true })).toHaveAttribute("aria-pressed", "true"); await favorite.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); }); await expect.poll(() => notebookPosts).toBe(1);
      await expect(dialog.getByRole("button", { name: "+ 新建分类", exact: true })).toBeDisabled(); await expect(dialog.getByRole("button", { name, exact: true })).toBeDisabled(); favoriting.release();
      await expect(dialog).toHaveCount(0); await expect(page.getByRole("button", { name: "取消收藏", exact: true })).toBeVisible(); expect(categoryPosts).toBe(1); expect(notebookPosts).toBe(1);
      const categories = await get(request, root); const category = categories.find((row: { name: string }) => row.name === name); const notebook = await get(request, "/api/notebook"); const entry = notebook.items.find((row: { source: string; question: string }) => row.source === "drill" && row.question === data.question);
      expect(entry.category_id).toBe(category.id); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally { creating.release(); favoriting.release(); expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });
}
