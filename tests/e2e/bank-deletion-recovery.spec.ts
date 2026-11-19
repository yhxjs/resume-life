import { expect, test, type APIRequestContext } from "@playwright/test";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import type { BankEntry } from "../../src/lib/bank";

const root = "/api/bank";
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
async function seed(request: APIRequestContext, marker: string) {
  const direction = `${marker}:` + "LongDirection_".repeat(12);
  const questions = [`${marker} C++ / C# <T> &amp; 内部  空格？`, `${marker} 另一题必须保留`];
  expect((await request.post(root, { data: { direction, kind: "tech", text: questions.join("\n") } })).status()).toBe(201);
  const response = await request.get(`${root}?${new URLSearchParams({ direction, limit: "50" })}`);
  expect(response.ok()).toBe(true); const data = await response.json(); expect(data.nextCursor).toBeNull();
  const items = data.items as BankEntry[];
  return { direction, first: items.find(item => item.question === questions[0])!, other: items.find(item => item.question === questions[1])! };
}

for (const width of [390, 1280]) {
  test(`题库删除 ${width}px：取消零写入，实际删除后坏响应只读恢复，旧列表不能复活题目`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000);
    const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
    let deletes = 0; let reads = 0; let failList = false; let staleList = false;
    const readGate = gate(); const reading = gate();
    try {
      const { first, other, direction } = await seed(request, `E2E题库删除${width}`);
      const endpoint = `${root}/${first.id}`;
      const stale = await (await request.get(root)).json();
      await page.route(`**${root}**`, async route => {
        const url = new URL(route.request().url());
        if (url.pathname === endpoint && route.request().method() === "DELETE") {
          deletes++; const response = await route.fetch(); expect(response.ok()).toBe(true);
          return route.fulfill({ json: { ok: "true" } });
        }
        if (url.pathname === endpoint && route.request().method() === "GET") {
          reads++;
          if (reads === 1) return route.fulfill({ status: 503, json: { error: "合成核对失败" } });
          if (reads === 2) return route.fulfill({ json: other });
          reading.release(); await readGate.promise;
        }
        if (url.pathname === root && route.request().method() === "GET") {
          if (failList) return route.fulfill({ status: 503, json: { error: "合成目录刷新失败" } });
          if (staleList) return route.fulfill({ json: stale });
        }
        return route.continue();
      });
      await page.setViewportSize({ width, height: 900 }); await page.goto("/bank");
      const firstRow = page.getByRole("listitem").filter({ has: page.getByText(first.question, { exact: true }) });
      const otherRow = page.getByRole("listitem").filter({ has: page.getByText(other.question, { exact: true }) });
      const firstDelete = firstRow.getByRole("button", { name: "删除", exact: true });
      await expect(firstDelete).toBeVisible();
      const input = page.getByRole("textbox", { name: "导入考题", exact: true }); const draft = "  未提交 C++ <T> &amp;\n内部  空格";
      await input.fill(draft); const importButton = page.getByRole("button", { name: "导入 2 道考题", exact: true });
      await firstDelete.click(); const dialog = page.getByRole("dialog", { name: "删除题目", exact: true });
      for (const text of [`#${first.id}`, first.question, direction, "题型：八股"]) await expect(dialog).toContainText(text);
      expect(await dialog.locator(":scope > div").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`bank-delete-confirm-${width}.png`), animations: "disabled" });
      await dialog.getByRole("button", { name: "取消", exact: true }).click(); expect(deletes).toBe(0); expect(reads).toBe(0);
      await expect(input).toHaveValue(draft); expect(await (await request.get(endpoint)).json()).toEqual(first);
      await firstDelete.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
      await expect(page.getByRole("dialog")).toHaveCount(1); await dialog.getByRole("button", { name: "删除", exact: true }).click();
      const error = page.getByRole("alert").filter({ hasText: "删除结果尚未确认" }); await expect(error).toContainText("合成核对失败");
      await expect(firstDelete).toBeDisabled(); await expect(otherRow.getByRole("button", { name: "删除", exact: true })).toBeDisabled();
      await expect(input).toBeDisabled(); await expect(importButton).toBeDisabled();
      const retry = page.getByRole("button", { name: "重新读取删除状态", exact: true }); await retry.click(); await expect(error).toContainText("记录不符");
      await retry.scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`bank-delete-unknown-${width}.png`), animations: "disabled" });
      failList = true;
      await retry.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
      await reading.promise; await expect(page.getByRole("status").filter({ hasText: "正在核对删除状态" })).toBeVisible();
      expect(reads).toBe(3); expect(deletes).toBe(1); await expect(input).toHaveValue(draft); readGate.release();
      await expect(page.getByRole("status").filter({ hasText: `已确认题目 #${first.id} 不存在` })).toBeVisible();
      await expect(page.getByRole("alert").filter({ hasText: "合成目录刷新失败" })).toBeVisible(); await expect(firstRow).toHaveCount(0);
      failList = false; staleList = true; await page.getByRole("button", { name: "重试加载", exact: true }).click();
      await expect(otherRow).toBeVisible(); await expect(firstRow).toHaveCount(0);
      await expect(page.getByText("当前筛选显示：", { exact: false })).toContainText("1 题");
      await expect(input).toBeEnabled(); await expect(input).toHaveValue(draft);
      expect((await request.get(endpoint)).status()).toBe(404); expect(await (await request.get(`${root}/${other.id}`)).json()).toEqual(other);
      expect(deletes).toBe(1); expect(reads).toBe(3);
    } finally { readGate.release(); expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });

  test(`题库删除 ${width}px：未写入的坏响应显示原题仍在，显式再确认才删除`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000);
    const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
    let deletes = 0; let reads = 0;
    try {
      const { first, other } = await seed(request, `E2E题库保留${width}`); const endpoint = `${root}/${first.id}`;
      await page.route(`**${endpoint}`, async route => {
        if (route.request().method() === "DELETE") { deletes++; if (deletes === 1) return route.fulfill({ json: {} }); }
        else reads++;
        return route.continue();
      });
      await page.setViewportSize({ width, height: 900 }); await page.goto("/bank");
      const row = page.getByRole("listitem").filter({ has: page.getByText(first.question, { exact: true }) });
      const input = page.getByRole("textbox", { name: "导入考题", exact: true }); const draft = "原稿保留 <T> &amp;\n另一行"; await input.fill(draft);
      await row.getByRole("button", { name: "删除", exact: true }).click(); const dialog = page.getByRole("dialog", { name: "删除题目", exact: true });
      await dialog.getByRole("button", { name: "删除", exact: true }).click();
      const error = page.getByRole("alert").filter({ hasText: `题目 #${first.id} 目前仍存在` });
      await expect(error).toBeVisible(); await expect(input).toBeEnabled();
      expect(deletes).toBe(1); expect(reads).toBe(1); expect(await (await request.get(endpoint)).json()).toEqual(first);
      await error.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath(`bank-delete-existing-${width}.png`), animations: "disabled" });
      await row.getByRole("button", { name: "删除", exact: true }).click(); await dialog.getByRole("button", { name: "取消", exact: true }).click(); expect(deletes).toBe(1);
      await row.getByRole("button", { name: "删除", exact: true }).click(); await dialog.getByRole("button", { name: "删除", exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: `已确认题目 #${first.id} 不存在` })).toBeVisible();
      await expect(page.getByText(other.question, { exact: true })).toBeVisible(); await expect(row).toHaveCount(0); await expect(input).toHaveValue(draft);
      expect(deletes).toBe(2); expect(reads).toBe(1); expect((await request.get(endpoint)).status()).toBe(404);
      expect(await (await request.get(`${root}/${other.id}`)).json()).toEqual(other);
    } finally { expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });

  test(`题库删除 ${width}px：导入等待及未知结果都阻止删除，恢复后取消不写入`, async ({ page, request }) => {
    test.setTimeout(90_000);
    const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
    const postGate = gate(); const posting = gate(); let posts = 0; let deletes = 0;
    try {
      const { first, other } = await seed(request, `E2E题库互斥${width}`);
      await page.route(`**${root}**`, async route => {
        const method = route.request().method(); const url = new URL(route.request().url());
        if (method === "DELETE") deletes++;
        if (url.pathname === root && method === "POST") { posts++; posting.release(); await postGate.promise; return route.fulfill({ status: 503, json: { error: "合成导入未确认" } }); }
        return route.continue();
      });
      await page.setViewportSize({ width, height: 900 }); await page.goto("/bank");
      const row = page.getByRole("listitem").filter({ has: page.getByText(first.question, { exact: true }) }); const remove = row.getByRole("button", { name: "删除", exact: true });
      const input = page.getByRole("textbox", { name: "导入考题", exact: true }); const draft = "未确认的导入 <T> &amp;"; await input.fill(draft);
      await page.getByRole("button", { name: "导入 1 道考题", exact: true }).click(); await posting.promise;
      await expect(remove).toBeDisabled(); await remove.evaluate(button => (button as HTMLButtonElement).click()); await expect(page.getByRole("dialog")).toHaveCount(0);
      postGate.release(); await expect(page.getByRole("alert").filter({ hasText: "导入结果尚未确认" })).toBeVisible();
      await expect(remove).toBeDisabled(); await expect(input).toHaveValue(draft);
      await page.getByRole("button", { name: "保留原稿并允许再次导入", exact: true }).click();
      await page.getByRole("dialog", { name: "允许再次导入", exact: true }).getByRole("button", { name: "允许再次导入", exact: true }).click();
      await expect(remove).toBeEnabled(); expect(posts).toBe(1); expect(deletes).toBe(0);
      await remove.click(); await page.getByRole("dialog", { name: "删除题目", exact: true }).getByRole("button", { name: "取消", exact: true }).click();
      expect(posts).toBe(1); expect(deletes).toBe(0); await expect(input).toHaveValue(draft);
      expect(await (await request.get(`${root}/${first.id}`)).json()).toEqual(first); expect(await (await request.get(`${root}/${other.id}`)).json()).toEqual(other);
    } finally { postGate.release(); expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });

  test(`题库删除 ${width}px：已删项填满旧页时仍可加载更早题目`, async ({ page, request }) => {
    test.setTimeout(90_000);
    const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
    try {
      const { first: earlier, other: target } = await seed(request, `E2E题库续页${width}`); let deletes = 0; let more = 0;
      // 合法的缩短首页与旧首页回包；后续游标继续交给真实接口读取。
      await page.route(`**${root}**`, async route => {
        const url = new URL(route.request().url());
        if (route.request().method() === "DELETE") deletes++;
        if (url.pathname === root && route.request().method() === "GET") {
          if (!url.searchParams.has("cursor")) return route.fulfill({ json: { items: [target], nextCursor: String(target.id) } });
          expect(url.searchParams.get("cursor")).toBe(String(target.id)); more++;
        }
        return route.continue();
      });
      await page.setViewportSize({ width, height: 900 }); await page.goto("/bank");
      await page.getByRole("listitem").filter({ has: page.getByText(target.question, { exact: true }) }).getByRole("button", { name: "删除", exact: true }).click();
      await page.getByRole("dialog", { name: "删除题目", exact: true }).getByRole("button", { name: "删除", exact: true }).click();
      await expect(page.getByText("当前已加载的题目均已删除，可继续加载更早题目。", { exact: true })).toBeVisible();
      await expect(page.getByText(target.question, { exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "加载更多", exact: true }).click(); await expect(page.getByText(earlier.question, { exact: true })).toBeVisible();
      await expect(page.getByText(target.question, { exact: true })).toHaveCount(0); expect(deletes).toBe(1); expect(more).toBe(1);
      expect((await request.get(`${root}/${target.id}`)).status()).toBe(404); expect(await (await request.get(`${root}/${earlier.id}`)).json()).toEqual(earlier);
    } finally { expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });
}
