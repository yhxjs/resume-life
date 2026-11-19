import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { exportEncryptedBackup, postEncryptedBackup, rewriteEncryptedBackup } from "./backup-helpers";
import { publishResume } from "./resume-version-helpers";
import { gate } from "./synthetic-api";

async function get(request: APIRequestContext, url: string) {
  const response = await request.get(url); expect(response.status(), await response.text()).toBe(200); return response.json();
}
async function seed(request: APIRequestContext, kind: string) {
  const created = await request.post("/api/resumes", { data: { title: "面试删除原始简历 <T> &amp;" } }); expect(created.status()).toBe(201);
  const resumeId = (await created.json()).id; const version = await publishResume(request, resumeId, "删除验证发布版");
  const backup = await exportEncryptedBackup(request); expect(backup.response.ok()).toBe(true);
  let singleId = 0; let seriesId = 0; let firstChild = 0; let notebookId = 0; let drillId = 0;
  const jd = "完整岗位原文 <T> &amp;\n内部  空格 " + "原始职责_".repeat(80); const timestamp = "2026-11-03T00:00:00.000Z";
  const rewritten = await rewriteEncryptedBackup(backup.bytes, records => {
    const next = (table: string) => Math.max(0, ...records.flatMap(row => row.kind === "row" && row.table === table ? [Number(row.data.id)] : [])) + 1;
    singleId = next("interviews"); seriesId = next("interview_series"); firstChild = singleId + 2;
    let turnId = next("interview_turns"); notebookId = next("notebook_entries"); drillId = next("drills");
    const questionId = next("drill_questions");
    const add = (table: string, data: Record<string, unknown>) => records.splice(records.findIndex(row => row.kind === "end"), 0, { kind: "row", table, data });
    add("interview_series", { id: seriesId, resume_id: resumeId, jd, rounds: 8, status: "ongoing", final_report: "", created_at: timestamp, finished_at: "", resume_version_id: version.id });
    const interview = (id: number, series: number | null, round: number) => {
      add("interviews", { id, resume_id: resumeId, jd, rounds: 8, style: "gentle", series_id: series, round_no: round, status: "ongoing", report: "", reverse_interview: "", evaluator_report: "", created_at: timestamp, finished_at: "", resume_version_id: version.id });
      add("interview_turns", { id: turnId++, interview_id: id, idx: 1, kind: "question", question: `原题 ${id}`, answer: "原始答复", comment: "原点评", scores: "", reference: "原参考", retries: "[]", answered_at: timestamp });
    };
    const sourceTurn = turnId + (kind === "single" ? 0 : 2);
    interview(singleId, null, 0); interview(singleId + 1, null, 0);
    for (let round = 1; round <= 3; round++) interview(firstChild + round - 1, seriesId, round);
    const sourceId = kind === "single" ? singleId : firstChild;
    add("drills", { id: drillId, source: "interview", project_id: null, direction: "面试追练", jd, interview_id: sourceId, focus: "保留追练", created_at: timestamp });
    add("drill_questions", { id: questionId, drill_id: drillId, idx: 1, question: "已生成追练原题", answer: "追练原答", comment: "追练点评", reference: "", scores: "", answered_at: timestamp, kind: "tech" });
    add("notebook_entries", { id: notebookId, category_id: null, source: "interview", source_id: sourceTurn, source_label: "独立收藏快照", question: "收藏原题", answer: "收藏原答", comment: "收藏点评", reference: "", scores: "", created_at: timestamp, updated_at: timestamp });
    const manifest = records.find(row => row.kind === "manifest"); const end = records.find(row => row.kind === "end");
    if (manifest?.kind !== "manifest" || end?.kind !== "end") throw new Error("Missing backup envelope");
    end.stats = Object.fromEntries(manifest.tables.map(table => [table, records.filter(row => row.kind === "row" && row.table === table).length]));
    end.totalRecords = Object.values(end.stats).reduce((sum, count) => sum + count, 0);
    manifest.sequences = { ...manifest.sequences, interviews: firstChild + 2, interview_series: seriesId, interview_turns: turnId - 1, drills: drillId, drill_questions: questionId, notebook_entries: notebookId };
  });
  const restored = await postEncryptedBackup(request, "/api/backup/restore", rewritten); expect(restored.status(), await restored.text()).toBe(200);
  return { id: kind === "single" ? singleId : seriesId, endpoint: kind === "single" ? `/api/interviews/${singleId}` : `/api/interviews/series/${seriesId}`, singleId, seriesId, firstChild, notebookId, drillId, jd };
}
const card = (page: Page, endpoint: string) => page.locator("div.group").filter({ has: page.locator(`a[href="${endpoint.replace("/api", "")}"]`).first() });

for (const width of [390, 1280]) for (const kind of ["single", "series"]) {
  test(`面试删除 ${kind} ${width}px：确认随离页取消，重新进入取消零写入`, async ({ page, request }) => {
    test.setTimeout(90_000); const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true); let deletes = 0;
    try {
      const data = await seed(request, kind); const before = await get(request, data.endpoint);
      await page.route(`**${data.endpoint}`, route => { if (route.request().method() === "DELETE") deletes++; return route.continue(); });
      await page.setViewportSize({ width, height: 900 }); await page.goto("/interviews"); await expect(card(page, data.endpoint)).toBeVisible();
      await page.locator('a[href="/"]').first().click(); await expect(page).toHaveURL(/\/$/); await page.goBack();
      await card(page, data.endpoint).getByRole("button", { name: "删除", exact: true }).click(); await expect(page.getByRole("dialog")).toBeVisible();
      await page.goForward(); await expect(page).toHaveURL(/\/$/); await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(deletes).toBe(0); expect(await get(request, data.endpoint)).toEqual(before);
      await page.goBack(); await card(page, data.endpoint).getByRole("button", { name: "删除", exact: true }).click();
      const dialog = page.getByRole("dialog"); await expect(dialog).toContainText(`#${data.id}`); await expect(dialog).toContainText(data.jd);
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      await expect(card(page, data.endpoint).getByRole("button", { name: "删除", exact: true })).toBeFocused();
      expect(deletes).toBe(0); expect(await get(request, data.endpoint)).toEqual(before);
    } finally { await page.goto("/"); expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).status()).toBe(200); }
  });

  test(`面试删除 ${kind} ${width}px：坏确认只读核对，明确再删才写入，级联与独立快照正确`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000); const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
    let deletes = 0; let reads = 0;
    try {
      const data = await seed(request, kind); const before = await get(request, data.endpoint); const notebook = await get(request, `/api/notebook/${data.notebookId}`);
      const drill = await get(request, `/api/drills/${data.drillId}`); const other = await get(request, `/api/interviews/${data.singleId + 1}`);
      await page.route(`**${data.endpoint}`, async route => {
        if (route.request().method() === "DELETE") {
          deletes++; if (deletes === 1) return route.fulfill({ json: {} });
          const response = await route.fetch(); expect(response.status()).toBe(200); return route.fulfill({ json: { ok: "true" } });
        }
        reads++;
        if (reads === 1) return route.fulfill({ status: 503, json: { error: "合成核对失败" } });
        if (reads === 2) return route.fulfill({ json: { ...before, id: data.id + 1 } });
        return route.continue();
      });
      await page.setViewportSize({ width, height: 900 }); await page.goto(`/interviews?jd=${encodeURIComponent("删除期间保留新建面试原稿")}`);
      const row = card(page, data.endpoint); const button = row.getByRole("button", { name: "删除", exact: true });
      await button.evaluate(node => { (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click(); });
      const dialog = page.getByRole("dialog"); await expect(dialog).toContainText(data.jd); await expect(dialog).toContainText("已收藏错题");
      await dialog.getByRole("button", { name: "删除", exact: true }).click();
      await expect(page.getByRole("alert").filter({ hasText: "删除结果尚未确认" })).toContainText("合成核对失败"); expect(deletes).toBe(1); expect(reads).toBe(1);
      await expect(button).toBeDisabled(); await expect(page.getByRole("button", { name: "立即开启模拟实战", exact: true })).toBeDisabled();
      const reread = page.getByRole("button", { name: "重新读取删除状态", exact: true }); await reread.click();
      await expect(page.getByRole("alert").filter({ hasText: "删除结果尚未确认" })).toContainText("记录不符"); expect(deletes).toBe(1);
      await reread.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath(`interview-delete-unknown-${kind}-${width}.png`), animations: "disabled" });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await reread.click(); await expect(page.getByRole("alert").filter({ hasText: "目前仍存在" })).toBeVisible(); await expect(button).toBeEnabled();
      expect(deletes).toBe(1); expect(await get(request, data.endpoint)).toEqual(before);
      await button.click(); await page.getByRole("dialog").getByRole("button", { name: "删除", exact: true }).click();
      await expect(row).toHaveCount(0); await expect(page.getByRole("dialog")).toHaveCount(0); expect(deletes).toBe(2); expect(reads).toBe(4);
      expect((await request.get(data.endpoint)).status()).toBe(404); expect(await get(request, `/api/notebook/${data.notebookId}`)).toEqual(notebook);
      expect(await get(request, `/api/drills/${data.drillId}`)).toEqual({ ...drill, interview_id: null }); expect(await get(request, `/api/interviews/${data.singleId + 1}`)).toEqual(other);
      if (kind === "series") for (let offset = 0; offset < 3; offset++) expect((await request.get(`/api/interviews/${data.firstChild + offset}`)).status()).toBe(404);
      else expect((await request.get(`/api/interviews/series/${data.seriesId}`)).status()).toBe(200);
      await expect(page.getByLabel("目标岗位要求（JD / 职位描述）")).toHaveValue("删除期间保留新建面试原稿");
    } finally { await page.goto("/"); expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).status()).toBe(200); }
  });

  test(`面试删除 ${kind} ${width}px：首题生成期间不能删除，取消生成后须再次明确确认`, async ({ page, request }) => {
    test.setTimeout(90_000); const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
    const started = gate(); const pending = gate(); let creates = 0; let deletes = 0;
    try {
      const data = await seed(request, kind);
      await page.route("**/api/interviews", async route => {
        if (route.request().method() !== "POST") return route.continue(); creates++; started.release(); await pending.promise;
        try { await route.fulfill({ status: 400, json: { error: "合成首题未创建" } }); } catch { /* 取消后不再接收。 */ }
      });
      await page.route(`**${data.endpoint}`, route => { if (route.request().method() === "DELETE") deletes++; return route.continue(); });
      await page.setViewportSize({ width, height: 900 }); await page.goto(`/interviews?jd=${encodeURIComponent("生成期间保留原稿")}`);
      const row = card(page, data.endpoint); const remove = row.getByRole("button", { name: "删除", exact: true }); await expect(remove).toBeEnabled();
      await page.getByRole("button", { name: "立即开启模拟实战", exact: true }).evaluate(button => {
        (button as HTMLButtonElement).click();
        // React 提交 busy 状态前，旧删除按钮也必须被同步命令检查拦下。
        document.querySelectorAll<HTMLButtonElement>("button").forEach(node => { if (node.textContent?.trim() === "删除") node.click(); });
      });
      await started.promise; await expect(remove).toBeDisabled(); await expect(page.getByRole("dialog")).toHaveCount(0); expect(deletes).toBe(0); expect(creates).toBe(1);
      await page.getByRole("button", { name: "取消", exact: true }).click(); pending.release(); await expect(remove).toBeEnabled();
      await remove.click(); await page.getByRole("dialog").getByRole("button", { name: "取消", exact: true }).click(); expect(deletes).toBe(0);
      expect((await request.get(data.endpoint)).status()).toBe(200); await expect(page.getByLabel("目标岗位要求（JD / 职位描述）")).toHaveValue("生成期间保留原稿");
    } finally { pending.release(); await page.goto("/"); expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).status()).toBe(200); }
  });
}
