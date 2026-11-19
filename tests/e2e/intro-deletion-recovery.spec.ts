import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { exportEncryptedBackup, postEncryptedBackup, rewriteEncryptedBackup } from "./backup-helpers";
import { publishResume } from "./resume-version-helpers";
import { gate } from "./synthetic-api";

const root = "/api/intros";
const draft = "  未提交 <T> &amp;\n内部  空格  ";
async function seed(request: APIRequestContext) {
  const title = "原始发布简历_" + "LongTitle_".repeat(18);
  const created = await request.post("/api/resumes", { data: { title } }); expect(created.status()).toBe(201);
  const resume = await created.json(); const published = await publishResume(request, resume.id);
  let targetId = 0; let otherId = 0; let versionId = 0; let logId = 0;
  const jd = "只参与参数校验 <T> &amp;\n内部  空格_" + "HistoryToken_".repeat(35);
  const initial = await exportEncryptedBackup(request); expect(initial.response.ok()).toBe(true);
  const bytes = await rewriteEncryptedBackup(initial.bytes, records => {
    const nextId = (table: string) => Math.max(0, ...records.flatMap(row => row.kind === "row" && row.table === table ? [Number(row.data.id)] : [])) + 1;
    otherId = nextId("intros"); targetId = otherId + 1; versionId = nextId("intro_versions"); logId = nextId("llm_call_logs");
    const add = (table: string, data: Record<string, unknown>) => records.splice(records.findIndex(row => row.kind === "end"), 0, { kind: "row", table, data });
    add("intros", { id: otherId, resume_id: resume.id, jd: "另一份旧记录必须保留", created_at: "2026-10-29", resume_version_id: null });
    add("intros", { id: targetId, resume_id: resume.id, jd, created_at: "2026-10-29", resume_version_id: published.id });
    add("intro_versions", { id: versionId, intro_id: targetId, kind: "30s", sentences: JSON.stringify([{ text: "历史原文 <T> &amp;\n内部  空格".repeat(50), comment: "原点评" }]), updated_at: "2026-10-29" });
    add("intro_versions", { id: versionId + 1, intro_id: targetId, kind: "2min", sentences: "[]", updated_at: "2026-10-29" });
    add("intro_versions", { id: versionId + 2, intro_id: otherId, kind: "30s", sentences: JSON.stringify([{ text: "另一份原文", comment: "" }]), updated_at: "2026-10-29" });
    for (const [index, id] of [targetId, otherId].entries()) add("llm_call_logs", { id: logId + index, created_at: "2026-10-29", feature: "intro", entity_type: "intro", entity_id: id, entity_label: title, task: "intro", model: "synthetic", api_format: "openai_chat", status: "ok", error_code: "", attempts: 1, duration_ms: 1, input_tokens: 12, output_tokens: 10, cached_tokens: null });
    const manifest = records.find(row => row.kind === "manifest"); const end = records.find(row => row.kind === "end");
    if (manifest?.kind !== "manifest" || end?.kind !== "end") throw new Error("Missing backup envelope");
    end.stats = Object.fromEntries(manifest.tables.map(table => [table, records.filter(row => row.kind === "row" && row.table === table).length]));
    end.totalRecords = Object.values(end.stats).reduce((sum, count) => sum + count, 0);
    manifest.sequences = { ...manifest.sequences, intros: targetId, intro_versions: versionId + 2, llm_call_logs: logId + 1 };
  });
  const restored = await postEncryptedBackup(request, "/api/backup/restore", bytes); expect(restored.status(), await restored.text()).toBe(200);
  return { targetId, otherId, versionId, logId, jd, title, published, resume };
}
async function configure(page: Page, data: Awaited<ReturnType<typeof seed>>) {
  const resume = page.getByRole("combobox", { name: "选择参考简历", exact: true }); await resume.selectOption(String(data.resume.id));
  const version = page.getByRole("combobox", { name: "已发布版本", exact: true }); await version.selectOption(String(data.published.id));
  const input = page.getByRole("textbox", { name: "目标岗位要求（JD / 职位描述）", exact: true }); await input.fill(draft);
  return { input, resume, version, start: page.getByRole("button", { name: "立即生成两版自我介绍", exact: true }) };
}
async function capture(page: Page, info: TestInfo, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(name), animations: "disabled" });
}

for (const width of [390, 1280]) test.describe(`自我介绍删除 ${width}px`, () => {
  test.use({ viewport: { width, height: 900 }, actionTimeout: 10_000 });
  test("取消零写入；实际删除坏响应后只读恢复，刷新失败与旧列表不复活", async ({ page, request }, info) => {
    test.setTimeout(90_000); const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
    const reading = gate(); const holdRead = gate(); let deletes = 0; let reads = 0; let posts = 0; let failList = false; let stale = false;
    try {
      const data = await seed(request); const endpoint = `${root}/${data.targetId}`;
      const before = await (await request.get(endpoint)).json(); const other = await (await request.get(`${root}/${data.otherId}`)).json();
      const oldList = await (await request.get(`${root}?limit=50`)).json();
      await page.route(`**${root}**`, async route => {
        const url = new URL(route.request().url()); const method = route.request().method(); if (method === "POST") posts++;
        if (url.pathname === endpoint && method === "DELETE") { deletes++; const response = await route.fetch(); expect(response.status()).toBe(200); return route.fulfill({ json: { ok: "true" } }); }
        if (url.pathname === endpoint && method === "GET") {
          reads++; if (reads === 1) return route.fulfill({ status: 503, json: { error: "合成核对失败" } });
          if (reads === 2) return route.fulfill({ json: other });
          reading.release(); await holdRead.promise;
        }
        if (url.pathname === root && method === "GET") {
          if (failList) return route.fulfill({ status: 503, json: { error: "合成历史刷新失败" } });
          if (stale) return route.fulfill({ json: oldList });
        }
        return route.continue();
      });
      await page.goto("/intros"); const config = await configure(page, data);
      const row = page.getByRole("article", { name: `自我介绍 #${data.targetId}`, exact: true });
      const otherRow = page.getByRole("article", { name: `自我介绍 #${data.otherId}`, exact: true }); const remove = row.getByRole("button", { name: "删除", exact: true });
      const dialog = page.getByRole("dialog", { name: "删除自我介绍", exact: true });
      await remove.click();
      for (const text of [`#${data.targetId}`, data.jd, data.title, data.published.name, "两版介绍与逐句点评"]) await expect(dialog).toContainText(text);
      await capture(page, info, "intro-delete-confirm.png");
      await dialog.getByRole("button", { name: "取消", exact: true }).click(); expect(deletes).toBe(0); expect(reads).toBe(0);
      expect(await (await request.get(endpoint)).json()).toEqual(before);
      await remove.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
      await dialog.getByRole("button", { name: "删除", exact: true }).click();
      const error = page.getByRole("alert").filter({ hasText: "删除结果尚未确认" }); await expect(error).toContainText("合成核对失败");
      await expect(config.input).toBeDisabled(); await expect(config.start).toBeDisabled(); await expect(otherRow.getByRole("button", { name: "删除", exact: true })).toBeDisabled();
      const retry = page.getByRole("button", { name: "重新读取删除状态", exact: true });
      await retry.click(); await expect(error).toContainText("记录不符"); await retry.scrollIntoViewIfNeeded(); await capture(page, info, "intro-delete-unknown.png");
      await retry.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); }); await reading.promise;
      expect(reads).toBe(3); expect(deletes).toBe(1); failList = true; holdRead.release();
      await expect(page.getByRole("status").filter({ hasText: `已确认自我介绍 #${data.targetId} 不存在` })).toContainText("已请求刷新自我介绍历史");
      await expect(page.getByRole("alert").filter({ hasText: "合成历史刷新失败" })).toBeVisible(); await expect(row).toHaveCount(0);
      failList = false; stale = true; await page.getByRole("button", { name: "重试加载", exact: true }).click();
      await expect(otherRow).toBeVisible(); await expect(row).toHaveCount(0); await expect(config.input).toBeEnabled(); await expect(config.input).toHaveValue(draft);
      await expect(config.resume).toHaveValue(String(data.resume.id)); await expect(config.version).toHaveValue(String(data.published.id));
      await otherRow.scrollIntoViewIfNeeded(); await capture(page, info, "intro-delete-recovered.png");
      expect((await request.get(endpoint)).status()).toBe(404); expect(await (await request.get(`${root}/${data.otherId}`)).json()).toEqual(other);
      const after = await exportEncryptedBackup(request); expect(after.response.ok()).toBe(true);
      await rewriteEncryptedBackup(after.bytes, records => {
        expect(records.filter(row => row.kind === "row" && row.table === "intro_versions" && row.data.intro_id === data.targetId)).toHaveLength(0);
        for (const [id, label] of [[data.logId, ""], [data.logId + 1, data.title]] as const) {
          const log = records.find(row => row.kind === "row" && row.table === "llm_call_logs" && row.data.id === id);
          expect(log?.kind === "row" && log.data).toMatchObject({ entity_label: label, input_tokens: 12 });
        }
      });
      expect(deletes).toBe(1); expect(reads).toBe(3); expect(posts).toBe(0);
    } finally { holdRead.release(); expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });

  test("明确仍存在的长历史与坏原稿可再确认，绝不自动重删", async ({ page, request }, info) => {
    test.setTimeout(90_000); const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true); let deletes = 0; let reads = 0;
    try {
      const data = await seed(request); const endpoint = `${root}/${data.targetId}`; const before = await (await request.get(endpoint)).json();
      expect(before.versions).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "2min", sentences: [], read_error: expect.any(String), raw_sentences: "[]" })]));
      const other = await (await request.get(`${root}/${data.otherId}`)).json();
      await page.route(`**${endpoint}`, async route => {
        if (route.request().method() === "GET") reads++;
        if (route.request().method() === "DELETE" && ++deletes === 1) return route.fulfill({ json: {} });
        return route.continue();
      });
      await page.goto("/intros"); const config = await configure(page, data);
      const row = page.getByRole("article", { name: `自我介绍 #${data.targetId}`, exact: true }); const remove = row.getByRole("button", { name: "删除", exact: true });
      const dialog = page.getByRole("dialog", { name: "删除自我介绍", exact: true });
      await remove.click(); await dialog.getByRole("button", { name: "删除", exact: true }).click();
      const error = page.getByRole("alert").filter({ hasText: `自我介绍 #${data.targetId} 目前仍存在` }); await expect(error).toBeVisible();
      await expect(config.input).toBeEnabled(); await expect(config.input).toHaveValue(draft); expect(await (await request.get(endpoint)).json()).toEqual(before);
      await error.scrollIntoViewIfNeeded(); await capture(page, info, "intro-delete-existing.png");
      await remove.click(); await dialog.getByRole("button", { name: "取消", exact: true }).click(); expect(deletes).toBe(1);
      await remove.click(); await dialog.getByRole("button", { name: "删除", exact: true }).click(); await expect(row).toHaveCount(0);
      expect(deletes).toBe(2); expect(reads).toBe(1); expect(await (await request.get(`${root}/${data.otherId}`)).json()).toEqual(other);
    } finally { expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });

  test("生成与确认双向互斥，失败保留配置，取消无删除", async ({ page, request }) => {
    test.setTimeout(90_000); const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
    const posting = gate(); const hold = gate(); let posts = 0; let deletes = 0;
    try {
      const data = await seed(request); const before = await (await request.get(`${root}/${data.targetId}`)).json();
      await page.route(`**${root}**`, async route => {
        if (route.request().method() === "POST") { posts++; posting.release(); await hold.promise; return route.fulfill({ status: 503, json: { error: "合成生成失败" } }); }
        if (route.request().method() === "DELETE") deletes++;
        return route.continue();
      });
      await page.goto("/intros"); const config = await configure(page, data);
      const row = page.getByRole("article", { name: `自我介绍 #${data.targetId}`, exact: true }); const remove = row.getByRole("button", { name: "删除", exact: true });
      await config.start.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); }); await posting.promise;
      await expect(remove).toBeDisabled(); await remove.evaluate(button => (button as HTMLButtonElement).click()); await expect(page.getByRole("dialog")).toHaveCount(0);
      hold.release(); await expect(page.getByText("合成生成失败", { exact: true })).toBeVisible(); await expect(config.input).toHaveValue(draft);
      await remove.click(); await config.start.evaluate(button => (button as HTMLButtonElement).click());
      await page.getByRole("dialog", { name: "删除自我介绍", exact: true }).getByRole("button", { name: "取消", exact: true }).click();
      await expect(config.start).toBeEnabled(); expect(posts).toBe(1); expect(deletes).toBe(0); expect(await (await request.get(`${root}/${data.targetId}`)).json()).toEqual(before);
    } finally { hold.release(); expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });

  test("离页取消本地等待，迟到删除响应不刷新新页面", async ({ page, request }) => {
    test.setTimeout(90_000); const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
    const deleted = gate(); const hold = gate(); const delivered = gate(); let heads = 0; let deletes = 0;
    try {
      const data = await seed(request); const endpoint = `${root}/${data.targetId}`;
      await page.addInitScript(() => {
        const original = window.fetch;
        window.fetch = (input, init) => {
          if (String(input).startsWith("/api/intros/") && init?.method === "DELETE") init.signal?.addEventListener("abort", () => { document.documentElement.dataset.introDeleteAborted = "true"; });
          return original(input, init);
        };
      });
      await page.route(`**${root}**`, async route => {
        if (new URL(route.request().url()).pathname === root && route.request().method() === "GET") heads++;
        if (route.request().method() === "DELETE") {
          deletes++; const response = await route.fetch(); expect(response.status()).toBe(200); deleted.release(); await hold.promise;
          try { await route.fulfill({ json: { ok: true } }); } finally { delivered.release(); }
          return;
        }
        return route.continue();
      });
      await page.goto("/intros");
      await page.getByRole("article", { name: `自我介绍 #${data.targetId}`, exact: true }).getByRole("button", { name: "删除", exact: true }).click();
      await page.getByRole("dialog", { name: "删除自我介绍", exact: true }).getByRole("button", { name: "删除", exact: true }).click(); await deleted.promise;
      if (width < 768) await page.getByRole("button", { name: "打开导航菜单", exact: true }).click();
      await page.getByRole("link", { name: "工具箱", exact: true }).click(); await expect(page).toHaveURL(/\/tools$/);
      await expect(page.locator("html")).toHaveAttribute("data-intro-delete-aborted", "true");
      if (width < 768) await page.getByRole("button", { name: "打开导航菜单", exact: true }).click();
      else await page.getByRole("button", { name: "面试演练", exact: true }).hover();
      await page.getByRole("link", { name: /^自我介绍/ }).click();
      await expect(page.getByRole("article", { name: `自我介绍 #${data.otherId}`, exact: true })).toBeVisible();
      const config = await configure(page, data); hold.release(); await delivered.promise;
      await expect(config.input).toHaveValue(draft); await expect(page.getByText(/已确认自我介绍 .*不存在/)).toHaveCount(0);
      expect(heads).toBe(2); expect(deletes).toBe(1); expect((await request.get(endpoint)).status()).toBe(404);
    } finally { hold.release(); expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });
});
