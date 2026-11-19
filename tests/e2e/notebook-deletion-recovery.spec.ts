import { expect, test, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { exportEncryptedBackup, postEncryptedBackup, rewriteEncryptedBackup } from "./backup-helpers";

const root = "/api/notebook";
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
async function seed(request: APIRequestContext, bytes: Buffer) {
  let targetId = 0; let otherId = 0; let drillId = 0; let categoryId = 0; let cardId = 0;
  const question = "完整原题 <T> &amp;\n内部  空格 " + "LongQuestion_".repeat(24); const timestamp = "2026-10-29T00:00:00.000Z";
  const rewritten = await rewriteEncryptedBackup(bytes, records => {
    const nextId = (table: string) => Math.max(0, ...records.flatMap(row => row.kind === "row" && row.table === table ? [Number(row.data.id)] : [])) + 1;
    otherId = nextId("notebook_entries"); targetId = otherId + 1; drillId = nextId("drills"); const questionId = nextId("drill_questions"); categoryId = nextId("notebook_categories"); cardId = nextId("review_cards");
    const add = (table: string, data: Record<string, unknown>) => records.splice(records.findIndex(row => row.kind === "end"), 0, { kind: "row", table, data });
    add("notebook_categories", { id: categoryId, name: "边界分类 <T> &amp;", created_at: timestamp });
    add("drills", { id: drillId, source: "bank", project_id: null, direction: "错题删除边界", jd: "", interview_id: null, focus: "", created_at: timestamp });
    const snapshot = { question, answer: "只参与校验 <T> &amp;\n未上线，收益未知。", comment: "原始点评", reference: "只保留真实分工。", scores: "" };
    add("drill_questions", { id: questionId, drill_id: drillId, idx: 1, ...snapshot, answered_at: timestamp, kind: "tech" });
    add("notebook_entries", { id: otherId, category_id: categoryId, source: "interview", source_id: questionId, source_label: "必须保留的另一份收藏", ...snapshot, question: "另一道错题必须保留", created_at: timestamp, updated_at: timestamp });
    add("notebook_entries", { id: targetId, category_id: categoryId, source: "drill", source_id: questionId, source_label: "独立收藏快照", ...snapshot, created_at: timestamp, updated_at: timestamp });
    const schedule = { interval_days: 0, ease_factor: 250, repetitions: 0, review_count: 0, lapses: 0, next_review_date: "2026-10-29", last_reviewed_at: "", created_at: timestamp };
    add("review_cards", { id: cardId, notebook_id: targetId, drill_question_id: null, ...schedule });
    add("review_cards", { id: cardId + 1, notebook_id: otherId, drill_question_id: null, ...schedule });
    const manifest = records.find(row => row.kind === "manifest"); const end = records.find(row => row.kind === "end");
    if (manifest?.kind !== "manifest" || end?.kind !== "end") throw new Error("Missing backup envelope");
    end.stats = Object.fromEntries(manifest.tables.map(table => [table, records.filter(row => row.kind === "row" && row.table === table).length]));
    end.totalRecords = Object.values(end.stats).reduce((sum, count) => sum + count, 0);
    manifest.sequences = { ...manifest.sequences, notebook_entries: targetId, notebook_categories: categoryId, drills: drillId, drill_questions: questionId, review_cards: cardId + 1 };
  });
  const restored = await postEncryptedBackup(request, "/api/backup/restore", rewritten); expect(restored.status(), await restored.text()).toBe(200);
  for (const id of [cardId, cardId + 1]) expect((await request.post(`/api/reviews/${id}`, { data: { answer: `本次复习 ${id}`, grade: "good", expected_review_count: 0, request_id: randomUUID() } })).status()).toBe(200);
  const applicationResponse = await request.post("/api/applications", { data: { company: "删除边界公司", role: "接口工程师", stage: "interested" } }); expect(applicationResponse.status()).toBe(201);
  const applicationId = (await applicationResponse.json()).id as number;
  expect((await request.post(`/api/applications/${applicationId}/preparation/resources`, { data: { kind: "notebook", id: targetId } })).status()).toBe(200);
  return { targetId, otherId, drillId, categoryId, cardId, applicationId, question };
}

for (const width of [390, 1280]) {
  test(`错题移出 ${width}px：唯一副本警示、坏响应只读恢复、旧列表不复活及真实级联清理`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000); const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
    let deletes = 0; let reads = 0; let failLists = false; let staleLists = false; const pending = gate(); const reading = gate();
    try {
      const data = await seed(request, baseline.bytes); const endpoint = `${root}/${data.targetId}`;
      expect((await request.delete(`/api/drills/${data.drillId}`)).status()).toBe(200); expect((await request.get(`/api/drills/${data.drillId}`)).status()).toBe(404);
      const other = await (await request.get(`${root}/${data.otherId}`)).json(); const otherReview = await (await request.get(`/api/reviews/${data.cardId + 1}`)).json(); const oldList = await (await request.get(root)).json();
      expect((await (await request.get(`/api/reviews/${data.cardId}`)).json()).attempts).toHaveLength(1);
      await page.route(`**${root}**`, async route => {
        const url = new URL(route.request().url()); const method = route.request().method();
        if (url.pathname === endpoint && method === "DELETE") { deletes++; const response = await route.fetch(); expect(response.status()).toBe(200); return route.fulfill({ json: { ok: "true" } }); }
        if (url.pathname === endpoint && method === "GET") {
          reads++; if (reads === 1) return route.fulfill({ status: 503, json: { error: "合成错题核对失败" } });
          if (reads === 2) return route.fulfill({ json: other }); reading.release(); await pending.promise;
        }
        if (method === "GET" && (url.pathname === root || url.pathname === `${root}/categories`)) {
          if (failLists) return route.fulfill({ status: 503, json: { error: url.pathname === root ? "合成目录刷新失败" : "合成分类刷新失败" } });
          if (staleLists && url.pathname === root) return route.fulfill({ json: oldList });
        }
        return route.continue();
      });
      await page.setViewportSize({ width, height: 900 }); await page.goto("/notebook");
      const row = page.getByRole("article", { name: `错题 #${data.targetId}`, exact: true }); const otherRow = page.getByRole("article", { name: `错题 #${data.otherId}`, exact: true });
      const remove = row.getByRole("button", { name: "移出", exact: true }); await remove.click(); const dialog = page.getByRole("dialog", { name: "移出错题本", exact: true });
      for (const literal of [`#${data.targetId}`, data.question, "复习历史", "求职准备关联", "可能是唯一副本"]) await expect(dialog).toContainText(literal);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: testInfo.outputPath(`notebook-remove-confirm-${width}.png`), animations: "disabled" });
      await dialog.getByRole("button", { name: "取消", exact: true }).click(); expect(deletes).toBe(0); expect(reads).toBe(0);
      await remove.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); }); await dialog.getByRole("button", { name: "移出", exact: true }).click();
      const error = page.getByRole("alert").filter({ hasText: "删除结果尚未确认" }); await expect(error).toContainText("合成错题核对失败");
      await expect(page.getByRole("button", { name: "管理错题分类", exact: true })).toBeDisabled(); await expect(otherRow.getByRole("button", { name: "分类", exact: true })).toBeDisabled(); await expect(otherRow.getByRole("button", { name: "移出", exact: true })).toBeDisabled();
      const retry = page.getByRole("button", { name: "重新读取删除状态", exact: true }); await retry.click(); await expect(error).toContainText("记录不符");
      await retry.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath(`notebook-remove-unknown-${width}.png`), animations: "disabled" }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await retry.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); }); await reading.promise; expect(deletes).toBe(1); expect(reads).toBe(3);
      failLists = true; pending.release(); await expect(page.getByRole("status").filter({ hasText: `已确认错题 #${data.targetId} 不存在` })).toBeVisible();
      await expect(page.getByRole("alert").filter({ hasText: "合成目录刷新失败" })).toBeVisible(); await expect(page.getByRole("alert").filter({ hasText: "合成分类刷新失败" })).toBeVisible(); await expect(row).toHaveCount(0);
      failLists = false; staleLists = true;
      await page.getByRole("alert").filter({ hasText: "合成分类刷新失败" }).getByRole("button", { name: "重试加载", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: "合成目录刷新失败" }).getByRole("button", { name: "重试加载", exact: true }).click();
      await expect(page.getByRole("alert").filter({ hasText: /合成分类刷新失败|合成目录刷新失败/ })).toHaveCount(0);
      await expect(otherRow).toBeVisible(); await expect(row).toHaveCount(0); await expect(page.getByRole("heading", { name: "错题列表（已显示 1 题）", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: /边界分类/ })).toContainText("(1)");
      expect((await request.get(endpoint)).status()).toBe(404); expect((await request.get(`/api/reviews/${data.cardId}`)).status()).toBe(404);
      expect(await (await request.get(`${root}/${data.otherId}`)).json()).toEqual(other); expect(await (await request.get(`/api/reviews/${data.cardId + 1}`)).json()).toEqual(otherReview);
      const resources = await (await request.get(`/api/applications/${data.applicationId}/preparation/resources?kind=notebook`)).json(); expect(resources.items).toEqual([]); expect((await request.get(`/api/applications/${data.applicationId}`)).status()).toBe(200);
      expect(deletes).toBe(1); expect(reads).toBe(3);
    } finally { pending.release(); expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });

  test(`错题移出 ${width}px：未执行的坏响应保留快照，键盘温习与分类互斥后显式再确认`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000); const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true); let deletes = 0; let reads = 0;
    try {
      const data = await seed(request, baseline.bytes); const endpoint = `${root}/${data.targetId}`; const before = await (await request.get(endpoint)).json();
      await page.route(`**${endpoint}`, async route => { if (route.request().method() === "DELETE") { deletes++; if (deletes === 1) return route.fulfill({ json: {} }); } else if (route.request().method() === "GET") reads++; return route.continue(); });
      await page.setViewportSize({ width, height: 900 }); await page.goto("/notebook");
      const row = page.getByRole("article", { name: `错题 #${data.targetId}`, exact: true }); const title = row.getByRole("button", { name: data.question, exact: true }); await title.focus(); await title.press("Enter");
      await expect(title).toHaveAttribute("aria-expanded", "true"); await expect(page.getByRole("region", { name: `错题 #${data.targetId} 温习内容`, exact: true })).toContainText(before.answer);
      await title.press("Space"); await expect(title).toHaveAttribute("aria-expanded", "false");
      await row.getByRole("button", { name: "分类", exact: true }).evaluate(button => {
        (button as HTMLButtonElement).click();
        const remove = [...button.closest("article")!.querySelectorAll("button")].find(candidate => candidate.textContent?.trim() === "移出"); remove?.click();
      });
      const move = page.getByRole("dialog", { name: "移动到分类", exact: true }); await expect(move).toBeVisible();
      await row.getByRole("button", { name: "移出", exact: true }).evaluate(button => (button as HTMLButtonElement).click()); await expect(page.getByRole("dialog", { name: "移出错题本", exact: true })).toHaveCount(0); expect(deletes).toBe(0);
      await move.getByRole("button", { name: "取消", exact: true }).click();
      await row.getByRole("button", { name: "移出", exact: true }).click(); const dialog = page.getByRole("dialog", { name: "移出错题本", exact: true }); await dialog.getByRole("button", { name: "移出", exact: true }).click();
      const error = page.getByRole("alert").filter({ hasText: `错题 #${data.targetId} 目前仍存在` }); await expect(error).toBeVisible(); expect(deletes).toBe(1); expect(reads).toBe(1); expect(await (await request.get(endpoint)).json()).toEqual(before);
      await error.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath(`notebook-remove-existing-${width}.png`), animations: "disabled" });
      await row.getByRole("button", { name: "移出", exact: true }).click(); await dialog.getByRole("button", { name: "取消", exact: true }).click(); expect(deletes).toBe(1);
      await row.getByRole("button", { name: "移出", exact: true }).click(); await dialog.getByRole("button", { name: "移出", exact: true }).click(); await expect(row).toHaveCount(0); expect(deletes).toBe(2); expect(reads).toBe(1);
    } finally { expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });

  test(`错题移出 ${width}px：旧首页只剩已移出项时继续加载更早收藏`, async ({ page, request }) => {
    test.setTimeout(90_000); const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
    try {
      const data = await seed(request, baseline.bytes); const list = await (await request.get(root)).json(); const target = list.items.find((item: { id: number }) => item.id === data.targetId); let more = 0;
      await page.route(`**${root}**`, async route => { const url = new URL(route.request().url()); if (url.pathname === root && route.request().method() === "GET") { if (!url.searchParams.has("cursor")) return route.fulfill({ json: { items: [target], nextCursor: String(data.targetId) } }); expect(url.searchParams.get("cursor")).toBe(String(data.targetId)); more++; } return route.continue(); });
      await page.setViewportSize({ width, height: 900 }); await page.goto("/notebook"); const row = page.getByRole("article", { name: `错题 #${data.targetId}`, exact: true });
      await row.getByRole("button", { name: "移出", exact: true }).click(); await page.getByRole("dialog", { name: "移出错题本", exact: true }).getByRole("button", { name: "移出", exact: true }).click();
      await expect(page.getByText("本页错题已移除，可以继续加载更早的收藏。", { exact: true })).toBeVisible(); await expect(page.getByText(/还没有收藏任何错题/)).toHaveCount(0);
      await page.getByRole("button", { name: "加载更多", exact: true }).click(); await expect(page.getByRole("article", { name: `错题 #${data.otherId}`, exact: true })).toBeVisible(); await expect(row).toHaveCount(0); expect(more).toBe(1);
    } finally { expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });

  test(`取消收藏 ${width}px：确认范围、未知结果只读恢复，原题保留且复习关联只在核对后清除`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000); const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true); const pending = gate(); const reading = gate(); let deletes = 0; let reads = 0;
    try {
      const data = await seed(request, baseline.bytes); const endpoint = `${root}/${data.targetId}`; const sourceBefore = await (await request.get(`/api/drills/${data.drillId}`)).json();
      await page.route(`**${endpoint}`, async route => { if (route.request().method() === "DELETE") { deletes++; const response = await route.fetch(); expect(response.status()).toBe(200); return route.fulfill({ json: {} }); } reads++; if (reads === 1) return route.fulfill({ status: 503, json: { error: "合成星标核对失败" } }); reading.release(); await pending.promise; return route.continue(); });
      await page.setViewportSize({ width, height: 900 }); await page.goto(`/drills/${data.drillId}`);
      const star = page.getByRole("button", { name: "取消收藏", exact: true }); const review = page.getByRole("link", { name: "开始间隔复习", exact: true }); await expect(review).toBeVisible();
      await star.click(); const dialog = page.getByRole("dialog", { name: "移出错题本", exact: true }); await expect(dialog).toContainText("复习历史"); await dialog.getByRole("button", { name: "取消", exact: true }).click(); expect(deletes).toBe(0);
      await star.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); }); await dialog.getByRole("button", { name: "移出", exact: true }).click();
      await expect(page.getByRole("alert").filter({ hasText: "合成星标核对失败" })).toBeVisible(); await expect(star).toBeDisabled(); await expect(review).toBeVisible();
      const retry = page.getByRole("button", { name: "重新读取删除状态", exact: true }); await retry.scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const feedback = page.getByRole("region", { name: "错题移出状态", exact: true });
      const box = await feedback.boundingBox(); expect(box).not.toBeNull();
      const header = await feedback.evaluate(element => { const parent = element.parentElement!; const style = getComputedStyle(parent); return { width: parent.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight), rowTop: parent.querySelector("button")!.getBoundingClientRect().bottom }; });
      expect(box!.width).toBeGreaterThanOrEqual(header.width - 2); expect(box!.y).toBeGreaterThanOrEqual(header.rowTop);
      await page.screenshot({ path: testInfo.outputPath(`notebook-star-unknown-${width}.png`), animations: "disabled" });
      await retry.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); }); await reading.promise; expect(reads).toBe(2); expect(deletes).toBe(1); await expect(review).toBeVisible(); pending.release();
      await expect(page.getByRole("button", { name: "收藏到错题本", exact: true })).toBeEnabled(); await expect(review).toHaveCount(0); expect((await request.get(`/api/reviews/${data.cardId}`)).status()).toBe(404);
      const after = await (await request.get(`/api/drills/${data.drillId}`)).json(); expect(after.questions[0]).toMatchObject({ question: sourceBefore.questions[0].question, answer: sourceBefore.questions[0].answer, comment: sourceBefore.questions[0].comment, reference: sourceBefore.questions[0].reference, notebook_id: null, review_card_id: null }); expect(deletes).toBe(1);
    } finally { pending.release(); expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });
}
