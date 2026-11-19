import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { exportEncryptedBackup, postEncryptedBackup, rewriteEncryptedBackup } from "./backup-helpers";
import { publishResume } from "./resume-version-helpers";
import { gate } from "./synthetic-api";

async function get(request: APIRequestContext, url: string) { const response = await request.get(url); expect(response.status(), await response.text()).toBe(200); return response.json(); }
async function create(request: APIRequestContext, title = "简历删除 <T> &amp; " + "完整标题_".repeat(40)) {
  const response = await request.post("/api/resumes", { data: { title, modules: { summary: { text: "原始自我评价 内部  空格 <T> &amp;" } } } }); expect(response.status()).toBe(201); return (await response.json()).id as number;
}
const card = (page: Page, id: number) => page.locator("div.group").filter({ has: page.locator(`a[href="/resumes/${id}"]`).first() });
async function seedCascade(request: APIRequestContext) {
  const id = await create(request); const otherId = await create(request, "另一份简历必须保留"); const version = await publishResume(request, id);
  const backup = await exportEncryptedBackup(request); expect(backup.response.ok()).toBe(true);
  const ids: Record<string, number> = {}; const timestamp = "2026-11-03T00:00:00.000Z";
  const rewritten = await rewriteEncryptedBackup(backup.bytes, records => {
    const tables = ["interview_series", "interviews", "interview_turns", "intros", "intro_versions", "resume_diagnoses", "drills", "drill_questions", "notebook_entries", "review_cards", "resume_defenses"] as const;
    for (const table of tables) ids[table] = Math.max(0, ...records.flatMap(row => row.kind === "row" && row.table === table ? [Number(row.data.id)] : [])) + 1;
    const add = (table: string, data: Record<string, unknown>) => records.splice(records.findIndex(row => row.kind === "end"), 0, { kind: "row", table, data });
    add("interview_series", { id: ids.interview_series, resume_id: id, jd: "原岗位", rounds: 8, status: "ongoing", final_report: "", created_at: timestamp, finished_at: "", resume_version_id: version.id });
    add("interviews", { id: ids.interviews, resume_id: id, jd: "原岗位", rounds: 8, style: "gentle", series_id: ids.interview_series, round_no: 1, status: "ongoing", report: "", reverse_interview: "", evaluator_report: "", created_at: timestamp, finished_at: "", resume_version_id: version.id });
    add("interview_turns", { id: ids.interview_turns, interview_id: ids.interviews, idx: 1, kind: "question", question: "原始面试题", answer: "原答 <T> &amp;", comment: "原点评", scores: "", reference: "", retries: "[]", answered_at: timestamp });
    add("intros", { id: ids.intros, resume_id: id, jd: "原岗位", created_at: timestamp, resume_version_id: version.id });
    for (const [offset, kind] of ["30s", "2min"].entries()) add("intro_versions", { id: ids.intro_versions! + offset, intro_id: ids.intros, kind, sentences: JSON.stringify([{ text: "原始介绍", comment: "原点评" }]), updated_at: timestamp });
    add("resume_diagnoses", { id: ids.resume_diagnoses, resume_id: id, job_id: "deletion-job", job_title: "原岗位", jd: "原岗位", report: JSON.stringify({ match: 6, summary: "原诊断", modules: [] }), resume_snapshot: JSON.stringify({ title: "原始简历", modules: [] }), adoptions: "[]", created_at: timestamp, resume_version_id: version.id });
    add("drills", { id: ids.drills, source: "interview", project_id: null, direction: "原追练", jd: "原岗位", interview_id: ids.interviews, focus: "原追练重点", created_at: timestamp });
    add("drill_questions", { id: ids.drill_questions, drill_id: ids.drills, idx: 1, question: "原追练题", answer: "原追练回答", comment: "原点评", reference: "", scores: "", answered_at: timestamp, kind: "tech" });
    add("notebook_entries", { id: ids.notebook_entries, category_id: null, source: "interview", source_id: ids.interview_turns, source_label: "独立收藏", question: "原始面试题", answer: "原答 <T> &amp;", comment: "原点评", reference: "", scores: "", created_at: timestamp, updated_at: timestamp });
    add("review_cards", { id: ids.review_cards, notebook_id: ids.notebook_entries, drill_question_id: null, interval_days: 0, ease_factor: 250, repetitions: 0, review_count: 0, lapses: 0, next_review_date: "2026-11-03", last_reviewed_at: "", created_at: timestamp });
    add("resume_defenses", { id: ids.resume_defenses, resume_id: id, title: "原排雷", source_content: "原始履历快照", target_role: "原岗位", risk_level: "low", overall_roast: "原分析", scanned_items: "[]", created_at: timestamp, resume_version_id: version.id });
    const manifest = records.find(row => row.kind === "manifest"); const end = records.find(row => row.kind === "end"); if (manifest?.kind !== "manifest" || end?.kind !== "end") throw new Error("Missing backup envelope");
    end.stats = Object.fromEntries(manifest.tables.map(table => [table, records.filter(row => row.kind === "row" && row.table === table).length])); end.totalRecords = Object.values(end.stats).reduce((sum, count) => sum + count, 0);
    for (const table of tables) manifest.sequences[table] = ids[table]! + (table === "intro_versions" ? 1 : 0);
  });
  const restored = await postEncryptedBackup(request, "/api/backup/restore", rewritten); expect(restored.status(), await restored.text()).toBe(200);
  expect((await request.post(`/api/reviews/${ids.review_cards}`, { data: { answer: "复习原答 <T> &amp;", grade: "good", expected_review_count: 0, request_id: randomUUID() } })).status()).toBe(200);
  const application = await request.post("/api/applications", { data: { company: "级联验证公司", role: "工程师", stage: "applied", resume_id: id, resume_version_id: version.id } }); expect(application.status()).toBe(201);
  return { id, otherId, version, ids, applicationId: (await application.json()).id as number };
}
for (const width of [390, 1280]) {
  test(`简历删除 ${width}px：确认随离页取消，返回取消与Escape归还焦点，零写入`, async ({ page, request }) => {
    test.setTimeout(90_000); const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true); let deletes = 0;
    try {
      const id = await create(request); const version = await publishResume(request, id); const before = await get(request, `/api/resumes/${id}`);
      await page.route(`**/api/resumes/${id}`, route => { if (route.request().method() === "DELETE") deletes++; return route.continue(); });
      await page.setViewportSize({ width, height: 900 }); await page.goto("/resumes"); await expect(card(page, id)).toBeVisible();
      await page.locator('a[href="/"]').first().click(); await expect(page).toHaveURL(/\/$/); await page.goBack();
      await card(page, id).getByRole("button", { name: "删除", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "删除简历", exact: true })).toBeVisible();
      await page.goForward(); await expect(page).toHaveURL(/\/$/); await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.goBack(); const button = card(page, id).getByRole("button", { name: "删除", exact: true }); await button.click();
      const dialog = page.getByRole("dialog", { name: "删除简历", exact: true }); await expect(dialog).toContainText(`#${id}`); await expect(dialog).toContainText(before.resume.title); await expect(dialog).toContainText("1 个已发布版本");
      await dialog.getByRole("button", { name: "取消", exact: true }).click(); await expect(button).toBeFocused();
      await button.evaluate(node => { (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click(); });
      await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0); await expect(button).toBeFocused();
      expect(deletes).toBe(0); expect(await get(request, `/api/resumes/${id}`)).toEqual(before); expect((await get(request, `/api/resumes/${id}/versions`)).versions.map((row: { id: number }) => row.id)).toContain(version.id);
    } finally { await page.goto("/"); expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });

  test(`简历删除 ${width}px：坏响应只读核对后再确认，真实级联且投递收藏追练保留`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000); const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true); let deletes = 0; let reads = 0;
    try {
      const data = await seedCascade(request); const endpoint = `/api/resumes/${data.id}`; const before = await get(request, endpoint); const other = await get(request, `/api/resumes/${data.otherId}`);
      const notebook = await get(request, `/api/notebook/${data.ids.notebook_entries}`); const review = await get(request, `/api/reviews/${data.ids.review_cards}`); const drill = await get(request, `/api/drills/${data.ids.drills}`); const defense = await get(request, `/api/tools/resume-defenses/${data.ids.resume_defenses}`); const application = await get(request, `/api/applications/${data.applicationId}`);
      await page.route(`**${endpoint}`, async route => {
        if (route.request().method() === "DELETE") { deletes++; if (deletes === 1) return route.fulfill({ json: {} }); const response = await route.fetch(); expect(response.status()).toBe(200); return route.fulfill({ json: { ok: "true" } }); }
        reads++; if (reads === 1) return route.fulfill({ status: 503, json: { error: "合成删除核对失败" } }); if (reads === 2) return route.fulfill({ json: { ...before, resume: { ...before.resume, id: data.otherId } } }); return route.continue();
      });
      await page.setViewportSize({ width, height: 900 }); await page.goto("/resumes"); const row = card(page, data.id); const remove = row.getByRole("button", { name: "删除", exact: true });
      const title = page.getByRole("textbox", { name: "新简历标题", exact: true }); await title.fill("保留的新建标题");
      await remove.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
      const dialog = page.getByRole("dialog", { name: "删除简历", exact: true }); await expect(dialog).toContainText("诊断"); await expect(dialog).toContainText("自我介绍"); await expect(dialog).toContainText("投递");
      await dialog.getByRole("button", { name: "删除", exact: true }).click();
      const error = page.getByRole("alert").filter({ hasText: "删除结果尚未确认" }); await expect(error).toContainText("合成删除核对失败"); await expect(remove).toBeDisabled(); await expect(title).toBeDisabled(); await expect(row.getByRole("button", { name: "复制", exact: true })).toBeDisabled();
      const reread = page.getByRole("button", { name: "重新读取删除状态", exact: true }); await reread.click(); await expect(error).toContainText("记录不符"); expect(deletes).toBe(1);
      await reread.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath(`resume-delete-unknown-${width}.png`), animations: "disabled" }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await reread.click(); await expect(page.getByRole("alert").filter({ hasText: "目前仍存在" })).toBeVisible(); await expect(remove).toBeEnabled(); expect(await get(request, endpoint)).toEqual(before);
      await remove.click(); await dialog.getByRole("button", { name: "删除", exact: true }).click(); await expect(row).toHaveCount(0); expect(deletes).toBe(2); expect(reads).toBe(4); await expect(title).toHaveValue("保留的新建标题");
      for (const url of [endpoint, `/api/resumes/${data.id}/versions/${data.version.id}`, `/api/interviews/${data.ids.interviews}`, `/api/interviews/series/${data.ids.interview_series}`, `/api/intros/${data.ids.intros}`]) expect((await request.get(url)).status(), url).toBe(404);
      expect((await request.get(`/api/resumes/${data.id}/diagnose`)).status()).toBe(404);
      const afterBackup = await exportEncryptedBackup(request); expect(afterBackup.response.ok()).toBe(true);
      await rewriteEncryptedBackup(afterBackup.bytes, records => {
        for (const table of ["resume_modules", "resume_versions", "resume_diagnoses", "intros", "interviews", "interview_series"]) expect(records.filter(row => row.kind === "row" && row.table === table && row.data.resume_id === data.id), table).toHaveLength(0);
        expect(records.filter(row => row.kind === "row" && row.table === "intro_versions" && row.data.intro_id === data.ids.intros)).toHaveLength(0);
        expect(records.filter(row => row.kind === "row" && row.table === "interview_turns" && row.data.interview_id === data.ids.interviews)).toHaveLength(0);
      });
      expect(await get(request, `/api/notebook/${data.ids.notebook_entries}`)).toEqual(notebook); expect(await get(request, `/api/reviews/${data.ids.review_cards}`)).toEqual(review);
      expect(await get(request, `/api/drills/${data.ids.drills}`)).toEqual({ ...drill, interview_id: null }); expect(await get(request, `/api/tools/resume-defenses/${data.ids.resume_defenses}`)).toEqual({ ...defense, report: { ...defense.report, resumeId: null, resumeVersionId: null } });
      const afterApplication = await get(request, `/api/applications/${data.applicationId}`); expect(afterApplication.submitted_resume).toEqual(application.submitted_resume); expect(afterApplication.submitted_jd).toEqual(application.submitted_jd); expect(afterApplication.resume_id).toBeNull(); expect(afterApplication.resume_version_id).toBeNull();
      expect(await get(request, `/api/resumes/${data.otherId}`)).toEqual(other);
    } finally { await page.goto("/"); expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });

  for (const kind of ["create", "copy"]) test(`简历目录 ${kind} ${width}px：同事件互斥删除，离页后真实写入的迟到回复不导航或刷新`, async ({ page, request }) => {
    test.setTimeout(90_000); const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true); const pending = gate(); const saved = gate(); const delivered = gate(); let posts = 0; let deletes = 0;
    try {
      const id = await create(request, "待复制的原始简历"); const endpoint = kind === "create" ? "/api/resumes" : `/api/resumes/${id}/copy`;
      await page.route(`**${endpoint}`, async route => { if (route.request().method() !== "POST") return route.continue(); posts++; const response = await route.fetch(); expect(response.status()).toBe(201); saved.release(); await pending.promise; try { await route.fulfill({ response }); } catch { /* 离页已取消本地等待。 */ } finally { delivered.release(); } });
      await page.route(`**/api/resumes/${id}`, route => { if (route.request().method() === "DELETE") deletes++; return route.continue(); });
      await page.setViewportSize({ width, height: 900 }); await page.goto("/resumes"); await page.getByRole("textbox", { name: "新简历标题", exact: true }).fill("新建简历原稿");
      const button = kind === "create" ? page.getByRole("button", { name: "立即创建", exact: true }) : card(page, id).getByRole("button", { name: "复制", exact: true });
      await button.evaluate(node => { (node as HTMLButtonElement).click(); document.querySelectorAll<HTMLButtonElement>("button").forEach(button => { if (button.textContent?.trim() === "删除") button.click(); }); (node as HTMLButtonElement).click(); });
      await saved.promise; expect(posts).toBe(1); expect(deletes).toBe(0); await expect(page.getByRole("dialog")).toHaveCount(0); await expect(card(page, id).getByRole("button", { name: "删除", exact: true })).toBeDisabled();
      await page.locator('a[href="/"]').first().click(); await expect(page).toHaveURL(/\/$/); pending.release(); await delivered.promise; await page.getByRole("heading", { level: 1 }).waitFor(); await expect(page).toHaveURL(/\/$/);
      const resumes = await get(request, "/api/resumes"); expect(resumes.filter((row: { title: string }) => row.title === (kind === "create" ? "新建简历原稿" : "待复制的原始简历（副本）"))).toHaveLength(1); expect(posts).toBe(1); expect(deletes).toBe(0);
    } finally { pending.release(); await page.goto("/"); expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });
}
