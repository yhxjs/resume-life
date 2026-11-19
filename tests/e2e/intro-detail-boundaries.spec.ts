import { expect, test, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { exportEncryptedBackup, postEncryptedBackup, rewriteEncryptedBackup } from "./backup-helpers";
import { publishResume } from "./resume-version-helpers";

const dates = ["2026-10-29", "2026-02-30", "历史日期字面量", ""];
const longText = "历史原文 <T> &amp;\n内部  空格_".repeat(50);
const original = "我只参与接口校验，尚未上线。";
const draft = "未提交 <T> &amp;\n草稿  保留";

async function seed(request: APIRequestContext) {
  const response = await request.post("/api/resumes", { data: { title: "详情元数据与旧日期" } });
  expect(response.status()).toBe(201);
  const resume = await response.json();
  const published = await publishResume(request, resume.id);
  const backup = await exportEncryptedBackup(request);
  expect(backup.response.ok()).toBe(true);
  let firstId = 0;
  const bytes = await rewriteEncryptedBackup(backup.bytes, records => {
    const nextId = (table: string) => Math.max(0, ...records.flatMap(row => row.kind === "row" && row.table === table ? [Number(row.data.id)] : [])) + 1;
    firstId = nextId("intros");
    const versionId = nextId("intro_versions");
    const add = (table: string, data: Record<string, unknown>) => records.splice(records.findIndex(row => row.kind === "end"), 0, { kind: "row", table, data });
    for (const [index, date] of dates.entries()) {
      add("intros", { id: firstId + index, resume_id: resume.id, jd: "旧背景完整保留", created_at: date, resume_version_id: index === 0 ? published.id : null });
      if (index === 3) continue; // 缺版旧存档仍可读取。
      add("intro_versions", { id: versionId + index, intro_id: firstId + index, kind: "30s", sentences: JSON.stringify([{ text: index === 0 ? longText : original, comment: "原点评" }]), updated_at: "2026-10-29" });
    }
    add("intro_versions", { id: versionId + 3, intro_id: firstId, kind: "2min", sentences: "[]", updated_at: "2026-10-29" });
    const manifest = records.find(row => row.kind === "manifest");
    const end = records.find(row => row.kind === "end");
    if (manifest?.kind !== "manifest" || end?.kind !== "end") throw new Error("Missing backup envelope");
    end.stats = Object.fromEntries(manifest.tables.map(table => [table, records.filter(row => row.kind === "row" && row.table === table).length]));
    end.totalRecords = Object.values(end.stats).reduce((sum, count) => sum + count, 0);
    manifest.sequences = { ...manifest.sequences, intros: firstId + 3, intro_versions: versionId + 3 };
  });
  const restored = await postEncryptedBackup(request, "/api/backup/restore", bytes);
  expect(restored.status(), await restored.text()).toBe(200);
  return { firstId, published };
}

async function capture(page: Page, info: TestInfo, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(name), animations: "disabled" });
}

for (const width of [390, 1280]) test.describe(`自我介绍详情边界 ${width}px`, () => {
  test.use({ viewport: { width, height: 900 }, timezoneId: "America/Los_Angeles", actionTimeout: 10_000 });

  test("损坏元数据拒读后可恢复；旧日期、长稿、异常原稿与缺版零写入", async ({ page, request }, info) => {
    test.setTimeout(90_000);
    const baseline = await exportEncryptedBackup(request);
    expect(baseline.response.ok()).toBe(true);
    let writes = 0;
    try {
      const { firstId, published } = await seed(request);
      const endpoint = `/api/intros/${firstId}`;
      const before = await (await request.get(endpoint)).json();
      let invalid = true;
      await page.route("**/api/intros/**", async route => {
        if (route.request().method() !== "GET") writes++;
        if (new URL(route.request().url()).pathname === endpoint && invalid) {
          return route.fulfill({ json: { ...before, resume_version: null } });
        }
        return route.continue();
      });
      await page.goto(`/intros/${firstId}`);
      await expect(page.getByText("服务器返回的自我介绍记录不完整", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "微调", exact: true })).toHaveCount(0);
      await capture(page, info, "intro-detail-invalid.png");
      invalid = false;
      await page.getByRole("button", { name: "重试加载", exact: true }).click();
      await expect(page.getByText(longText, { exact: true })).toBeVisible();
      await expect(page.getByText(published.name, { exact: false }).first()).toBeVisible();
      await expect(page.getByText(dates[0]!, { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "2 分钟版", exact: true }).click();
      await expect(page.getByRole("alert").filter({ hasText: "本版原稿数据异常" })).toBeVisible();
      await page.getByText("查看原始数据（只读）", { exact: true }).click();
      await expect(page.getByLabel("2 分钟版原始数据", { exact: true })).toHaveText("[]");
      await capture(page, info, "intro-detail-history.png");
      for (const index of [1, 2, 3]) {
        await page.goto(`/intros/${firstId + index}`);
        await expect(page.getByText(dates[index] || "未记录时间", { exact: true })).toBeVisible();
        if (index === 3) await expect(page.getByText("数据异常：缺少版本内容。", { exact: true })).toBeVisible();
        else await expect(page.getByText(original, { exact: true })).toBeVisible();
      }
      expect(writes).toBe(0);
      expect(await (await request.get(endpoint)).json()).toEqual(before);
    } finally {
      expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
    }
  });

  for (const conflict of [false, true]) test(`${conflict ? "冲突" : "408"}回读拒绝坏元数据，草稿保留且仅一次写入`, async ({ page, request }, info) => {
    test.setTimeout(90_000);
    const baseline = await exportEncryptedBackup(request);
    expect(baseline.response.ok()).toBe(true);
    let writes = 0;
    let reads = 0;
    let invalid = false;
    try {
      const { firstId } = await seed(request);
      const endpoint = `/api/intros/${firstId + 1}`;
      const before = await (await request.get(endpoint)).json();
      await page.route(`**${endpoint}`, async route => {
        reads++;
        if (invalid) return route.fulfill({ json: { ...before, resume_id: "wrong", versions: [{ ...before.versions[0], revision: "f".repeat(64), sentences: [{ text: "错误背景不能采用", comment: "" }] }] } });
        return route.continue();
      });
      await page.route(`**${endpoint}/versions/30s`, async route => {
        writes++;
        invalid = true;
        if (!conflict) expect((await route.fetch()).status()).toBe(200);
        return route.fulfill({ status: conflict ? 409 : 408, json: { error: conflict ? "修订冲突" : "保存响应超时" } });
      });
      await page.goto(`/intros/${firstId + 1}`);
      await expect(page.getByText(original, { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "微调", exact: true }).click();
      const editor = page.getByRole("textbox");
      await editor.fill(draft);
      await page.getByRole("button", { name: "保存修改", exact: true }).click();
      const retry = page.getByRole("button", { name: conflict ? "获取最新版本（保留草稿）" : "重新读取保存状态", exact: true });
      if (conflict) { await expect(retry).toBeVisible(); await retry.click(); }
      await expect(page.getByText(/服务器返回的自我介绍记录不完整/)).toBeVisible();
      await expect(editor).toHaveValue(draft);
      await expect(page.getByText("错误背景不能采用", { exact: true })).toHaveCount(0);
      if (!conflict) {
        await expect(page.getByRole("button", { name: "保存修改", exact: true })).toBeDisabled();
        await expect(page.getByRole("button", { name: "重新点评整篇", exact: true })).toBeDisabled();
      }
      await retry.scrollIntoViewIfNeeded();
      await capture(page, info, `intro-detail-${conflict ? "conflict" : "unknown"}.png`);
      invalid = false;
      await retry.click();
      await expect(page.getByText(conflict ? "已获取最新版本，草稿已保留；请核对已保存句子后再次保存" : "已读取30 秒版的最新保存版本，请核对；可能包含其他页面的修改，当前编辑草稿已保留。", { exact: true })).toBeVisible();
      await expect(editor).toHaveValue(draft);
      await expect(page.getByRole("button", { name: "保存修改", exact: true })).toBeEnabled();
      expect(writes).toBe(1);
      expect(reads).toBe(3);
      const after = await (await request.get(endpoint)).json();
      if (conflict) expect(after).toEqual(before);
      else expect(after.versions[0].sentences).toEqual([{ text: draft, comment: "" }]);
    } finally {
      expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
    }
  });
});
