import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { exportEncryptedBackup, postEncryptedBackup, rewriteEncryptedBackup } from "./backup-helpers";

const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
async function get(request: APIRequestContext, url: string) { const response = await request.get(url); expect(response.status(), await response.text()).toBe(200); return response.json(); }
async function seed(request: APIRequestContext, bytes: Buffer) {
  const columns = {
    resumes: ["id", "title", "template", "style_overrides", "created_at", "updated_at", "base_version_id"],
    interviews: ["id", "resume_id", "jd", "rounds", "style", "series_id", "round_no", "status", "report", "reverse_interview", "evaluator_report", "created_at", "finished_at", "resume_version_id"],
    interview_turns: ["id", "interview_id", "idx", "kind", "question", "answer", "comment", "scores", "reference", "retries", "answered_at"],
    drills: ["id", "source", "project_id", "direction", "jd", "interview_id", "focus", "created_at"],
    drill_questions: ["id", "drill_id", "idx", "question", "answer", "comment", "reference", "scores", "answered_at", "kind"],
    review_cards: ["id", "notebook_id", "drill_question_id", "interval_days", "ease_factor", "repetitions", "review_count", "lapses", "next_review_date", "last_reviewed_at", "created_at"],
    notebook_categories: ["id", "name", "created_at"],
  };
  type SeedTable = keyof typeof columns;
  const tables = Object.keys(columns) as SeedTable[];
  const ids = Object.fromEntries(tables.map(table => [table, 0])) as Record<SeedTable, number>; const timestamp = "2026-10-29T00:00:00.000Z";
  const category = "历史分类 <T> &amp; " + "LongCategory_".repeat(8); const question = "收藏原题 <T> &amp;\n内部  空格 " + "LongQuestion_".repeat(15);
  const snapshot = { question, answer: "原答 <T> &amp;\n只参与参数校验，尚未上线。", comment: "原点评", reference: "原参考", scores: "" };
  const rewritten = await rewriteEncryptedBackup(bytes, records => {
    for (const table of tables) ids[table] = Math.max(0, ...records.flatMap(row => row.kind === "row" && row.table === table ? [Number(row.data.id)] : [])) + 1;
    const add = (table: SeedTable, data: Record<string, unknown>) => {
      expect(Object.keys(data).every(key => columns[table].includes(key))).toBe(true);
      records.splice(records.findIndex(row => row.kind === "end"), 0, { kind: "row", table, data: Object.fromEntries(columns[table].filter(key => key in data).map(key => [key, data[key]])) });
    };
    add("notebook_categories", { id: ids.notebook_categories, name: category, created_at: timestamp }); add("notebook_categories", { id: ids.notebook_categories + 1, name: "目标分类", created_at: timestamp });
    add("resumes", { id: ids.resumes, title: "收藏恢复验证简历", template: "classic", style_overrides: "{}", base_version_id: null, created_at: timestamp, updated_at: timestamp });
    add("interviews", { id: ids.interviews, resume_id: ids.resumes, resume_version_id: null, jd: "收藏恢复接口验证", rounds: 3, style: "deep", series_id: null, round_no: 1, status: "finished", report: "", evaluator_report: "", reverse_interview: "", created_at: timestamp, finished_at: timestamp });
    add("interview_turns", { id: ids.interview_turns, interview_id: ids.interviews, idx: 1, kind: "question", ...snapshot, retries: "[]", answered_at: timestamp });
    add("drills", { id: ids.drills, source: "interview", project_id: null, direction: "收藏恢复验证", jd: "", interview_id: ids.interviews, focus: "", created_at: timestamp });
    add("drill_questions", { id: ids.drill_questions, drill_id: ids.drills, idx: 1, kind: "tech", ...snapshot, answered_at: timestamp });
    add("review_cards", { id: ids.review_cards, notebook_id: null, drill_question_id: ids.drill_questions, interval_days: 0, ease_factor: 250, repetitions: 0, review_count: 0, lapses: 0, next_review_date: "2026-10-29", last_reviewed_at: "", created_at: timestamp });
    const manifest = records.find(row => row.kind === "manifest"); const end = records.find(row => row.kind === "end"); if (manifest?.kind !== "manifest" || end?.kind !== "end") throw new Error("Missing backup envelope");
    end.stats = Object.fromEntries(manifest.tables.map(table => [table, records.filter(row => row.kind === "row" && row.table === table).length])); end.totalRecords = Object.values(end.stats).reduce((sum, count) => sum + count, 0);
    manifest.sequences = { ...manifest.sequences, ...ids, notebook_categories: ids.notebook_categories + 1 };
  });
  const restored = await postEncryptedBackup(request, "/api/backup/restore", rewritten); expect(restored.status(), await restored.text()).toBe(200);
  const reviewed = await request.post(`/api/reviews/${ids.review_cards}`, { data: { answer: "已完成的原题复习 <T> &amp;", grade: "good", expected_review_count: 0, request_id: randomUUID() } }); expect(reviewed.status(), await reviewed.text()).toBe(200);
  return { ids, category, question, snapshot };
}
async function open(page: Page) { await page.getByRole("button", { name: "收藏到错题本", exact: true }).click(); return page.getByRole("dialog", { name: "收藏到错题本", exact: true }); }
const overflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

for (const width of [390, 1280]) {
  test(`收藏恢复 ${width}px：真实收藏后坏回包、503和串来源只读恢复，原复习卡及历史完整转接`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000); const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
    let posts = 0; let reads = 0; const reading = gate(); const pending = gate();
    try {
      const data = await seed(request, baseline.bytes); const source = await get(request, `/api/drills/${data.ids.drills}`); const review = await get(request, `/api/reviews/${data.ids.review_cards}`);
      const lookup = `/api/notebook/lookup?source=drill&source_id=${data.ids.drill_questions}`;
      await page.route("**/api/notebook**", async route => {
        const url = new URL(route.request().url());
        if (url.pathname === "/api/notebook" && route.request().method() === "POST") { posts++; const response = await route.fetch(); expect(response.status()).toBe(201); return route.fulfill({ json: { id: "坏确认", review: null } }); }
        if (url.pathname === "/api/notebook/lookup") {
          reads++; if (reads === 1) return route.fulfill({ status: 503, json: { error: "合成只读失败" } });
          if (reads === 2) { const actual = await get(request, lookup); return route.fulfill({ json: { ...actual, source: "interview" } }); }
          if (reads === 3) { reading.release(); await pending.promise; }
        }
        return route.continue();
      });
      await page.setViewportSize({ width, height: 900 }); await page.goto(`/drills/${data.ids.drills}`); const dialog = await open(page);
      await dialog.getByRole("button", { name: data.category, exact: true }).click(); await dialog.getByRole("button", { name: "收藏", exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
      await expect(dialog.getByRole("alert")).toContainText("合成只读失败"); expect(posts).toBe(1); await expect(dialog.getByRole("button", { name: "取消", exact: true })).toBeDisabled();
      const reread = dialog.getByRole("button", { name: "重新读取收藏状态", exact: true }); await reread.click(); await expect(dialog.getByRole("alert")).toContainText("来源不符");
      await expect(dialog.getByRole("button", { name: data.category, exact: true })).toHaveAttribute("aria-pressed", "true"); await page.screenshot({ path: testInfo.outputPath(`favorite-unknown-${width}.png`), animations: "disabled" }); await overflow(page);
      await reread.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); }); await reading.promise; expect(reads).toBe(3); pending.release();
      await expect(dialog).toHaveCount(0); await expect(page.getByRole("button", { name: "取消收藏", exact: true })).toBeVisible(); expect(posts).toBe(1); expect(reads).toBe(3);
      const saved = await get(request, lookup); expect(saved).toMatchObject({ source: "drill", source_id: data.ids.drill_questions, category_id: data.ids.notebook_categories, question: data.question, answer: data.snapshot.answer, comment: data.snapshot.comment, reference: data.snapshot.reference, review: { review_card_id: data.ids.review_cards } });
      await expect(page.getByRole("link", { name: "开始间隔复习", exact: true })).toHaveAttribute("href", `/reviews?card=${data.ids.review_cards}`);
      const after = await get(request, `/api/reviews/${data.ids.review_cards}`); for (const key of ["attempts", "interval_days", "ease_factor", "repetitions", "review_count", "next_review_date", "last_reviewed_at", "answer", "reference", "comment"]) expect(after[key]).toEqual(review[key]);
      const updated = await get(request, `/api/drills/${data.ids.drills}`); for (const key of ["question", "answer", "comment", "reference", "scores", "answered_at"]) expect(updated.questions[0][key]).toEqual(source.questions[0][key]);
      expect((await get(request, "/api/notebook")).items.filter((entry: { id: number }) => entry.id === saved.id)).toHaveLength(1);
    } finally { pending.release(); expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });

  test(`收藏恢复 ${width}px：另一页面已收藏的面试题返回409，分类不同先核对现有快照再显式采用`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000); const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true); let posts = 0;
    try {
      const data = await seed(request, baseline.bytes); await page.setViewportSize({ width, height: 900 }); await page.goto(`/interviews/${data.ids.interviews}`); const dialog = await open(page); await dialog.getByRole("button", { name: "目标分类", exact: true }).click();
      const created = await request.post("/api/notebook", { data: { source: "interview", source_id: data.ids.interview_turns, category_id: data.ids.notebook_categories } }); expect(created.status()).toBe(201); const entry = await created.json();
      const lookup = `/api/notebook/lookup?source=interview&source_id=${data.ids.interview_turns}`; const before = await get(request, lookup); const original = await get(request, `/api/interviews/${data.ids.interviews}`); const review = await get(request, `/api/reviews/${entry.review.review_card_id}`);
      const application = await request.post("/api/applications", { data: { company: "现有收藏核对", role: "接口工程师", stage: "interested" } }); expect(application.status()).toBe(201); const applicationId = (await application.json()).id;
      expect((await request.post(`/api/applications/${applicationId}/preparation/resources`, { data: { kind: "notebook", id: entry.id } })).status()).toBe(200); const resources = await get(request, `/api/applications/${applicationId}/preparation/resources?kind=notebook`);
      await page.route("**/api/notebook", async route => { if (route.request().method() === "POST") { posts++; const response = await route.fetch(); expect(response.status()).toBe(409); return route.fulfill({ response }); } return route.continue(); });
      await dialog.getByRole("button", { name: "收藏", exact: true }).click(); await expect(dialog.getByRole("alert")).toContainText("与本次选择不同"); await expect(dialog.getByRole("button", { name: "目标分类", exact: true })).toHaveAttribute("aria-pressed", "true");
      await dialog.getByText(`查看现有收藏快照 #${entry.id}`, { exact: true }).click(); await expect(dialog.getByText(data.snapshot.answer, { exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`favorite-existing-${width}.png`), animations: "disabled" }); await overflow(page); expect(await get(request, lookup)).toEqual(before); expect(posts).toBe(1);
      await dialog.getByRole("button", { name: "使用现有收藏", exact: true }).click(); await expect(dialog).toHaveCount(0); await expect(page.getByRole("button", { name: "取消收藏", exact: true })).toBeVisible();
      expect(await get(request, lookup)).toEqual(before); expect(await get(request, `/api/reviews/${entry.review.review_card_id}`)).toEqual(review); expect(await get(request, `/api/interviews/${data.ids.interviews}`)).toEqual(original);
      expect(await get(request, `/api/applications/${applicationId}/preparation/resources?kind=notebook`)).toEqual(resources); expect(posts).toBe(1);
    } finally { expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });

  test(`收藏恢复 ${width}px：未执行的写入只读404后显式允许重试，错误回包ID不冒领其他收藏`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000); const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true); let posts = 0; let reads = 0;
    try {
      const data = await seed(request, baseline.bytes);
      const other = await request.post("/api/notebook", { data: { source: "interview", source_id: data.ids.interview_turns, category_id: null } }); expect(other.status()).toBe(201); const otherId = (await other.json()).id as number; const before = await get(request, `/api/notebook/${otherId}`);
      await page.route("**/api/notebook**", async route => {
        const url = new URL(route.request().url()); if (url.pathname === "/api/notebook/lookup") reads++;
        if (url.pathname === "/api/notebook" && route.request().method() === "POST") {
          posts++; if (posts === 1) return route.fulfill({ status: 503, json: { error: "合成未执行写入" } });
          const response = await route.fetch(); expect(response.status()).toBe(201); const actual = await response.json(); return route.fulfill({ json: { ...actual, id: otherId } });
        }
        return route.continue();
      });
      await page.setViewportSize({ width, height: 900 }); await page.goto(`/drills/${data.ids.drills}`); const dialog = await open(page); await dialog.getByRole("button", { name: "目标分类", exact: true }).click();
      await dialog.getByRole("button", { name: "收藏", exact: true }).click(); await expect(dialog.getByRole("alert")).toContainText("仍可能稍后完成"); await expect(dialog.getByRole("button", { name: "收藏", exact: true })).toBeDisabled(); expect(posts).toBe(1); expect(reads).toBe(1);
      await page.screenshot({ path: testInfo.outputPath(`favorite-missing-${width}.png`), animations: "disabled" }); await overflow(page);
      await dialog.getByRole("button", { name: "保留选择并允许重试", exact: true }).click(); expect(posts).toBe(1); await expect(dialog.getByRole("button", { name: "目标分类", exact: true })).toHaveAttribute("aria-pressed", "true");
      await dialog.getByRole("button", { name: "收藏", exact: true }).click(); await expect(dialog.getByRole("alert")).toContainText("当前来源记录不符"); expect(posts).toBe(2); expect(reads).toBe(2);
      await dialog.getByRole("button", { name: "重新读取收藏状态", exact: true }).click(); await expect(dialog).toHaveCount(0); expect(posts).toBe(2); expect(reads).toBe(3);
      const saved = await get(request, `/api/notebook/lookup?source=drill&source_id=${data.ids.drill_questions}`); expect(saved.id).not.toBe(otherId); expect(saved.category_id).toBe(data.ids.notebook_categories + 1); expect(await get(request, `/api/notebook/${otherId}`)).toEqual(before);
    } finally { expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });
}
