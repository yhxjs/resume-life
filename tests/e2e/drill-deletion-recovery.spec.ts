import { expect, test, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { exportEncryptedBackup, postEncryptedBackup, rewriteEncryptedBackup } from "./backup-helpers";

const root = "/api/drills";
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
async function seed(request: APIRequestContext, bytes: Buffer, width: number) {
  let targetId = 0; let otherId = 0; let notebookId = 0; let directCard = 0; let notebookCard = 0;
  const timestamp = "2026-10-29T00:00:00.000Z";
  const jd = `只参与参数校验 <T> &amp;\n内部  空格 ${width}`;
  const direction = "方向_" + "LongDirection_".repeat(20);
  const rewritten = await rewriteEncryptedBackup(bytes, records => {
    const nextId = (table: string) => Math.max(0, ...records.flatMap(row => row.kind === "row" && row.table === table ? [Number(row.data.id)] : [])) + 1;
    otherId = nextId("drills"); targetId = otherId + 1; const questionId = nextId("drill_questions");
    notebookId = nextId("notebook_entries"); notebookCard = nextId("review_cards"); directCard = notebookCard + 1;
    const add = (table: string, data: Record<string, unknown>) => records.splice(records.findIndex(row => row.kind === "end"), 0, { kind: "row", table, data });
    add("drills", { id: otherId, source: "bank", project_id: null, direction: "另一场练习必须保留", jd: "", interview_id: null, focus: "", created_at: timestamp });
    add("drills", { id: targetId, source: "interview", project_id: null, direction, jd, interview_id: null, focus: "删除恢复边界", created_at: timestamp });
    const question = { question: "原始问题 <T> &amp;\n内部  空格", answer: "只做参数校验，尚未上线。", comment: "原始点评", reference: "只描述已提供的分工。", scores: "", answered_at: timestamp, kind: "tech" };
    add("drill_questions", { id: questionId, drill_id: targetId, idx: 0, ...question });
    add("drill_questions", { id: questionId + 1, drill_id: targetId, idx: 1, ...question, question: "尚未收藏的追练题" });
    const { answered_at: _answeredAt, kind: _kind, ...snapshot } = question;
    void _answeredAt; void _kind;
    add("notebook_entries", { id: notebookId, category_id: null, source: "drill", source_id: questionId, source_label: "已收藏练习快照", ...snapshot, created_at: timestamp, updated_at: timestamp });
    const schedule = { interval_days: 0, ease_factor: 250, repetitions: 0, review_count: 0, lapses: 0, next_review_date: "2026-10-29", last_reviewed_at: "", created_at: timestamp };
    add("review_cards", { id: notebookCard, notebook_id: notebookId, drill_question_id: null, ...schedule });
    add("review_cards", { id: directCard, notebook_id: null, drill_question_id: questionId + 1, ...schedule });
    const manifest = records.find(row => row.kind === "manifest"); const end = records.find(row => row.kind === "end");
    if (manifest?.kind !== "manifest" || end?.kind !== "end") throw new Error("Missing backup envelope");
    end.stats = Object.fromEntries(manifest.tables.map(table => [table, records.filter(row => row.kind === "row" && row.table === table).length]));
    end.totalRecords = Object.values(end.stats).reduce((sum, count) => sum + count, 0);
    manifest.sequences = { ...manifest.sequences, drills: targetId, drill_questions: questionId + 1, notebook_entries: notebookId, review_cards: directCard };
  });
  const restored = await postEncryptedBackup(request, "/api/backup/restore", rewritten); expect(restored.status(), await restored.text()).toBe(200);
  for (const id of [notebookCard, directCard]) {
    const saved = await request.post(`/api/reviews/${id}`, { data: { answer: `本次回忆 ${id}`, grade: "good", expected_review_count: 0, request_id: randomUUID() } }); expect(saved.status(), await saved.text()).toBe(200);
  }
  return { targetId, otherId, notebookId, directCard, notebookCard, jd, direction };
}

for (const width of [390, 1280]) {
  test(`练习删除 ${width}px：取消零写入，实际删除后只读恢复，旧列表不复活且保留收藏与复习历史`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000); const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
    const reading = gate(); const readGate = gate(); let deletes = 0; let reads = 0; let posts = 0; let failList = false; let staleList = false;
    try {
      const data = await seed(request, baseline.bytes, width); const endpoint = `${root}/${data.targetId}`;
      const other = await (await request.get(`${root}/${data.otherId}`)).json(); const oldList = await (await request.get(root)).json();
      const notebook = await (await request.get(`/api/notebook/${data.notebookId}`)).json(); const review = await (await request.get(`/api/reviews/${data.notebookCard}`)).json();
      expect(review.attempts).toHaveLength(1);
      await page.route(`**${root}**`, async route => {
        const url = new URL(route.request().url()); const method = route.request().method();
        if (method === "POST") posts++;
        if (url.pathname === endpoint && method === "DELETE") { deletes++; const response = await route.fetch(); expect(response.status()).toBe(200); return route.fulfill({ json: { ok: "true" } }); }
        if (url.pathname === endpoint && method === "GET") {
          reads++;
          if (reads === 1) return route.fulfill({ status: 503, json: { error: "合成核对失败" } });
          if (reads === 2) return route.fulfill({ json: other });
          reading.release(); await readGate.promise;
        }
        if (url.pathname === root && method === "GET") {
          if (failList) return route.fulfill({ status: 503, json: { error: "合成练习目录刷新失败" } });
          if (staleList) return route.fulfill({ json: oldList });
        }
        return route.continue();
      });
      await page.setViewportSize({ width, height: 900 }); await page.goto("/drills");
      const row = page.getByRole("article", { name: `练习 #${data.targetId}`, exact: true }); const otherRow = page.getByRole("article", { name: `练习 #${data.otherId}`, exact: true });
      await expect(row).toBeVisible(); await page.getByRole("tab", { name: "岗位通用题库" }).click();
      const jd = page.getByRole("textbox", { name: /岗位任职要求/ }); const draft = "配置原稿 <T> &amp;\n只做接口校验。"; await jd.fill(draft);
      const remove = row.getByRole("button", { name: "删除", exact: true }); await remove.click();
      const dialog = page.getByRole("dialog", { name: "删除练习", exact: true });
      for (const literal of [`#${data.targetId}`, data.jd, data.direction, "直接关联的复习记录", "已收藏到错题本的快照及其复习记录仍保留"]) await expect(dialog).toContainText(literal);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`drill-delete-confirm-${width}.png`), animations: "disabled" });
      await dialog.getByRole("button", { name: "取消", exact: true }).click(); expect(deletes).toBe(0); expect(reads).toBe(0); await expect(jd).toHaveValue(draft);
      await remove.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
      await dialog.getByRole("button", { name: "删除", exact: true }).click();
      const error = page.getByRole("alert").filter({ hasText: "删除结果尚未确认" }); await expect(error).toContainText("合成核对失败");
      await expect(jd).toBeDisabled(); await expect(otherRow.getByRole("button", { name: "删除", exact: true })).toBeDisabled(); await expect(page.getByRole("button", { name: "开始通用练习", exact: true })).toBeDisabled();
      const retry = page.getByRole("button", { name: "重新读取删除状态", exact: true }); await retry.click(); await expect(error).toContainText("记录不符");
      await retry.scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`drill-delete-unknown-${width}.png`), animations: "disabled" });
      await retry.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
      await reading.promise; await expect(page.getByRole("status").filter({ hasText: "正在核对删除状态" })).toBeVisible(); expect(reads).toBe(3); expect(deletes).toBe(1);
      failList = true; readGate.release();
      const notice = page.getByRole("status").filter({ hasText: `已确认练习 #${data.targetId} 不存在` }); await expect(notice).toContainText("已请求刷新练习列表");
      await expect(page.getByRole("alert").filter({ hasText: "合成练习目录刷新失败" })).toBeVisible(); await expect(row).toHaveCount(0);
      failList = false; staleList = true; await page.getByRole("button", { name: "重试加载", exact: true }).click();
      await expect(otherRow).toBeVisible(); await expect(row).toHaveCount(0); await expect(jd).toBeEnabled(); await expect(jd).toHaveValue(draft);
      expect(await (await request.get(`${root}/${data.otherId}`)).json()).toEqual(other); expect((await request.get(endpoint)).status()).toBe(404);
      expect(await (await request.get(`/api/notebook/${data.notebookId}`)).json()).toEqual(notebook);
      expect(await (await request.get(`/api/reviews/${data.notebookCard}`)).json()).toEqual(review); expect((await request.get(`/api/reviews/${data.directCard}`)).status()).toBe(404);
      expect(deletes).toBe(1); expect(reads).toBe(3); expect(posts).toBe(0);
    } finally { readGate.release(); expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });

  test(`练习删除 ${width}px：未写入的坏响应保留原练习，显式重新确认才删除`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000); const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true); let deletes = 0; let reads = 0;
    try {
      const data = await seed(request, baseline.bytes, width); const endpoint = `${root}/${data.targetId}`;
      const before = await (await request.get(endpoint)).json(); const other = await (await request.get(`${root}/${data.otherId}`)).json();
      await page.route(`**${endpoint}`, async route => {
        if (route.request().method() === "DELETE") { deletes++; if (deletes === 1) return route.fulfill({ json: {} }); }
        else reads++;
        return route.continue();
      });
      await page.setViewportSize({ width, height: 900 }); await page.goto("/drills");
      const row = page.getByRole("article", { name: `练习 #${data.targetId}`, exact: true }); const dialog = page.getByRole("dialog", { name: "删除练习", exact: true });
      await row.getByRole("button", { name: "删除", exact: true }).click(); await dialog.getByRole("button", { name: "删除", exact: true }).click();
      const error = page.getByRole("alert").filter({ hasText: `练习 #${data.targetId} 目前仍存在` }); await expect(error).toBeVisible();
      expect(deletes).toBe(1); expect(reads).toBe(1); expect(await (await request.get(endpoint)).json()).toEqual(before);
      await error.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath(`drill-delete-existing-${width}.png`), animations: "disabled" });
      await row.getByRole("button", { name: "删除", exact: true }).click(); await dialog.getByRole("button", { name: "取消", exact: true }).click(); expect(deletes).toBe(1);
      await row.getByRole("button", { name: "删除", exact: true }).click(); await dialog.getByRole("button", { name: "删除", exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: `已确认练习 #${data.targetId} 不存在` })).toBeVisible(); await expect(row).toHaveCount(0);
      expect(deletes).toBe(2); expect(reads).toBe(1); expect(await (await request.get(`${root}/${data.otherId}`)).json()).toEqual(other);
    } finally { expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });

  test(`练习删除 ${width}px：已删练习填满旧首页时仍可继续加载更早记录`, async ({ page, request }) => {
    test.setTimeout(90_000); const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
    try {
      const data = await seed(request, baseline.bytes, width); const initial = await (await request.get(root)).json(); const target = initial.items.find((item: { id: number }) => item.id === data.targetId); let more = 0;
      await page.route(`**${root}**`, async route => {
        const url = new URL(route.request().url());
        if (url.pathname === root && route.request().method() === "GET") {
          if (!url.searchParams.has("cursor")) return route.fulfill({ json: { items: [target], nextCursor: String(data.targetId) } });
          expect(url.searchParams.get("cursor")).toBe(String(data.targetId)); more++;
        }
        return route.continue();
      });
      await page.setViewportSize({ width, height: 900 }); await page.goto("/drills");
      const row = page.getByRole("article", { name: `练习 #${data.targetId}`, exact: true });
      await row.getByRole("button", { name: "删除", exact: true }).click(); await page.getByRole("dialog", { name: "删除练习", exact: true }).getByRole("button", { name: "删除", exact: true }).click();
      await expect(page.getByText("本页记录已移除，可以继续加载更早的练习。", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "加载更多", exact: true }).click(); await expect(page.getByRole("article", { name: `练习 #${data.otherId}`, exact: true })).toBeVisible();
      await expect(row).toHaveCount(0); expect(more).toBe(1);
    } finally { expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });

  test(`练习删除 ${width}px：创建等待阻止排队删除和重复提交，失败后配置保留可取消确认`, async ({ page, request }) => {
    test.setTimeout(90_000); const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true); const pending = gate(); const posting = gate(); let posts = 0; let deletes = 0;
    try {
      const data = await seed(request, baseline.bytes, width); const before = await (await request.get(root)).json();
      await page.route(`**${root}**`, async route => {
        if (route.request().method() === "POST") { posts++; posting.release(); await pending.promise; return route.fulfill({ status: 503, json: { error: "合成创建失败" } }); }
        if (route.request().method() === "DELETE") deletes++;
        return route.continue();
      });
      await page.setViewportSize({ width, height: 900 }); await page.goto("/drills");
      const row = page.getByRole("article", { name: `练习 #${data.targetId}`, exact: true }); await expect(row).toBeVisible();
      await page.getByRole("tab", { name: "岗位通用题库" }).click(); const jd = page.getByRole("textbox", { name: /岗位任职要求/ }); const draft = "配置原稿 <T> &amp;\n不能丢失"; await jd.fill(draft);
      await page.getByRole("button", { name: "开始通用练习", exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); }); await posting.promise;
      const remove = row.getByRole("button", { name: "删除", exact: true }); await expect(remove).toBeDisabled(); await remove.evaluate(button => (button as HTMLButtonElement).click()); await expect(page.getByRole("dialog")).toHaveCount(0);
      pending.release(); await expect(page.getByText("合成创建失败", { exact: true })).toBeVisible(); await expect(jd).toHaveValue(draft);
      await remove.click(); await page.getByRole("dialog", { name: "删除练习", exact: true }).getByRole("button", { name: "取消", exact: true }).click();
      expect(posts).toBe(1); expect(deletes).toBe(0); expect(await (await request.get(root)).json()).toEqual(before);
    } finally { pending.release(); expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });
}
