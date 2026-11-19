import { expect, test, type APIRequestContext } from "@playwright/test";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import type { BankEntry } from "../../src/lib/bank";

const root = "/api/bank";
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
async function entries(request: APIRequestContext, params: Record<string, string>) {
  const response = await request.get(`${root}?${new URLSearchParams({ ...params, limit: "50" })}`);
  expect(response.status(), await response.text()).toBe(200); const data = await response.json(); expect(data.nextCursor).toBeNull(); return data.items as BankEntry[];
}

for (const width of [390, 1280]) {
  test(`题库导入 ${width}px：解锁确认随离页关闭，返回后取消归还焦点，确认本身不重发`, async ({ page, request }) => {
    test.setTimeout(90_000); const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
    const marker = `E2E导入确认${width}`; const oldRaw = `${marker} 旧页原题`; const newRaw = `${marker} 新页第一题 <T> &amp;\n${marker} 新页第二题 内部  空格`;
    let posts = 0;
    try {
      await page.route(`**${root}`, async route => {
        if (route.request().method() !== "POST") return route.continue();
        posts++; const response = await route.fetch(); expect(response.status()).toBe(201);
        return posts <= 2 ? route.fulfill({ json: { count: -1 } }) : route.fulfill({ response });
      });
      await page.setViewportSize({ width, height: 900 }); await page.goto("/bank");
      await page.locator('a[href="/"]').first().click(); await expect(page).toHaveURL(/\/$/); await page.goBack();
      const input = page.getByRole("textbox", { name: "导入考题", exact: true }); await input.fill(oldRaw);
      await page.getByRole("button", { name: "导入 1 道考题", exact: true }).click();
      const allow = page.getByRole("button", { name: "保留原稿并允许再次导入", exact: true }); await allow.click();
      const dialog = page.getByRole("dialog", { name: "允许再次导入", exact: true }); await expect(dialog).toBeVisible();
      await page.goForward(); await expect(page).toHaveURL(/\/$/); await expect(page.getByRole("dialog")).toHaveCount(0);
      expect(posts).toBe(1); const previous = await entries(request, { q: marker }); expect(previous).toHaveLength(1);
      await page.goBack(); await expect(input).toHaveValue(""); await input.fill(newRaw);
      await page.getByRole("button", { name: "导入 2 道考题", exact: true }).click();
      await expect(page.getByRole("region", { name: "导入结果核对快照", exact: true })).toBeVisible();
      const current = await entries(request, { q: marker }); expect(current).toHaveLength(3);
      await allow.focus();
      await allow.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
      await expect(dialog).toContainText("本批次包含 2 道题"); await expect(dialog).toContainText("可能产生重复");
      await dialog.getByRole("button", { name: "取消", exact: true }).click(); await expect(allow).toBeFocused();
      await expect(input).toBeDisabled(); await expect(input).toHaveValue(newRaw); expect(posts).toBe(2);
      await allow.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
      await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0); await expect(allow).toBeFocused();
      await expect(input).toBeDisabled(); expect(await entries(request, { q: marker })).toEqual(current); expect(posts).toBe(2);
      await allow.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
      await dialog.getByRole("button", { name: "允许再次导入", exact: true }).click();
      await expect(dialog).toHaveCount(0); await expect(input).toBeEnabled(); await expect(input).toHaveValue(newRaw); expect(posts).toBe(2);
      await page.getByRole("button", { name: "导入 2 道考题", exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: "成功导入 2 道题" })).toBeVisible(); expect(posts).toBe(3);
      const final = await entries(request, { q: marker }); expect(final).toHaveLength(5); expect(final.find(item => item.id === previous[0]!.id)).toEqual(previous[0]);
    } finally { await page.goto("/"); expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });

  test(`题库导入 ${width}px：等待锁定全部材料，双击单次写入，未指定方向不会伪报总数`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000);
    const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
    const responseGate = gate(); const saved = gate(); let posts = 0;
    const marker = `E2E无方向${width}`;
    const questions = [`${marker} C++ / C# <T> &amp; 内部  空格？`, `${marker} 未确定条件如何核实？`];
    const raw = `  ${questions[0]}  \n\n${questions[1]}\n${questions[0]}  `;
    try {
      expect((await request.post(root, { data: { direction: `${marker}:另一方向`, kind: "tech", text: `${marker} 另一题` } })).status()).toBe(201);
      const previous = await entries(request, { direction: `${marker}:另一方向` });
      await page.route(`**${root}`, async route => {
        if (route.request().method() !== "POST") return route.continue();
        posts++;
        expect(route.request().postDataJSON()).toEqual({ direction: "", kind: "tech", text: raw });
        try {
          const response = await route.fetch(); expect(response.status()).toBe(201); saved.release();
          await responseGate.promise; await route.fulfill({ response });
        } finally { saved.release(); }
      });
      await page.setViewportSize({ width, height: 900 }); await page.goto("/bank");
      const form = page.getByRole("group", { name: "批量录入考题", exact: true });
      const input = form.getByRole("textbox", { name: "导入考题", exact: true }); await input.fill(raw);
      await form.getByRole("button", { name: "导入 2 道考题", exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
      await saved.promise; expect(posts).toBe(1);
      for (const control of [input, form.getByRole("combobox", { name: "导入方向", exact: true }), form.getByRole("button", { name: "八股", exact: true }), form.getByRole("button", { name: "行为", exact: true }), form.getByRole("button", { name: "技术八股", exact: true }), form.getByRole("button", { name: "综合行为", exact: true })]) await expect(control).toBeDisabled();
      await expect(input).toHaveValue(raw); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`bank-import-pending-${width}.png`), animations: "disabled" });
      responseGate.release(); await expect(page.getByRole("status").filter({ hasText: "成功导入 2 道题" })).toBeVisible(); await expect(input).toHaveValue("");
      for (const question of questions) await expect(page.getByText(question, { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "全部方向", exact: true })).toBeVisible();
      expect((await entries(request, { q: marker })).filter(item => item.direction === "").map(item => item.question).sort()).toEqual([...questions].sort());
      expect(await entries(request, { direction: `${marker}:另一方向` })).toEqual(previous); expect(posts).toBe(1);
    } finally {
      responseGate.release(); if (posts > 0) await saved.promise;
      expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
    }
  });

  test(`题库导入 ${width}px：实际写入后数量坏响应，503 与串筛选只能只读核对，再导入须显式确认`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000);
    const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
    const marker = `E2E题库恢复${width}`; const direction = `${marker}:` + "LongDirection_".repeat(12);
    const questions = [`${marker} C++ / C# <T> &amp; 内部  空格？`, `${marker} 不编造未知条件？`];
    const raw = `  ${questions[0]}  \n\n${questions[1]}\n${questions[0]}  `; let posts = 0; let reads = 0;
    try {
      const data = { direction, kind: "tech", text: raw };
      expect((await request.post(root, { data })).status()).toBe(201);
      expect((await request.post(root, { data: { direction: `${marker}:另一方向`, kind: "behavior", text: `${marker} 另一题保留` } })).status()).toBe(201);
      const other = await entries(request, { direction: `${marker}:另一方向` });
      await page.route(`**${root}**`, async route => {
        const url = new URL(route.request().url()); if (url.pathname !== root) return route.continue();
        if (route.request().method() === "POST") {
          posts++; expect(route.request().postDataJSON()).toEqual(data);
          const response = await route.fetch(); expect(response.status()).toBe(201);
          return posts === 1 ? route.fulfill({ status: 201, json: { count: 9 } }) : route.fulfill({ response });
        }
        if (url.searchParams.get("limit") === "50") {
          reads++; expect(url.searchParams.get("kind")).toBe("tech"); expect(url.searchParams.get("direction")).toBe(direction);
          if (reads === 1) return route.fulfill({ status: 503, json: { error: "合成题库读取失败" } });
          if (reads === 2) return route.fulfill({ json: { items: other, nextCursor: null } });
        }
        return route.continue();
      });
      await page.setViewportSize({ width, height: 900 }); await page.goto("/bank");
      const form = page.getByRole("group", { name: "批量录入考题", exact: true });
      const dir = form.getByRole("combobox", { name: "导入方向", exact: true }); await dir.fill(direction); await dir.press("Enter");
      const input = form.getByRole("textbox", { name: "导入考题", exact: true }); await input.fill(raw); await form.getByRole("button", { name: "导入 2 道考题", exact: true }).click();
      const error = page.getByRole("alert").filter({ hasText: "导入结果尚未确认" }); await expect(error).toContainText("合成题库读取失败");
      await expect(input).toHaveValue(raw); await expect(input).toBeDisabled(); await expect(page.getByRole("button", { name: "保留原稿并允许再次导入", exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "重新读取题库", exact: true }).click(); await expect(error).toContainText("筛选不符"); expect(posts).toBe(1);
      expect(await entries(request, { direction })).toHaveLength(4); expect(await entries(request, { direction: `${marker}:另一方向` })).toEqual(other);
      await page.getByRole("button", { name: "重新读取题库", exact: true }).click();
      const snapshot = page.getByRole("region", { name: "导入结果核对快照", exact: true }); await expect(snapshot).toBeVisible(); await expect(snapshot).toContainText("不是本批次的写入回执");
      await expect(snapshot.getByRole("listitem")).toHaveCount(4); await expect(error).toContainText("同文题目不能确认");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await snapshot.scrollIntoViewIfNeeded(); await page.screenshot({ path: testInfo.outputPath(`bank-import-recovery-${width}.png`), animations: "disabled" });
      const allow = page.getByRole("button", { name: "保留原稿并允许再次导入", exact: true }); await allow.click();
      const dialog = page.getByRole("dialog", { name: "允许再次导入", exact: true }); await expect(dialog).toContainText("可能产生重复");
      expect(await dialog.locator(":scope > div").evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`bank-import-confirm-${width}.png`), animations: "disabled" });
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      await expect(input).toBeDisabled(); expect(posts).toBe(1);
      await allow.click(); await dialog.getByRole("button", { name: "允许再次导入", exact: true }).click();
      await expect(input).toBeEnabled(); await expect(input).toHaveValue(raw); expect(posts).toBe(1);
      await form.getByRole("button", { name: "导入 2 道考题", exact: true }).click(); await expect(page.getByRole("status").filter({ hasText: "成功导入 2 道题" })).toBeVisible();
      expect(posts).toBe(2); expect(reads).toBe(3); expect(await entries(request, { direction })).toHaveLength(6); expect(await entries(request, { direction: `${marker}:另一方向` })).toEqual(other);
    } finally { expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });

  test(`题库导入 ${width}px：方向坏响应可重试，明确拒绝保留原稿且无存档，修正后单次导入`, async ({ page, request }) => {
    test.setTimeout(90_000);
    const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
    const marker = `E2E题库校验${width}`; const direction = `${marker}:新方向`; const raw = `${marker} <T> &amp; C++\n${marker} C# 内部  空格`;
    let posts = 0; let directions = 0;
    try {
      await page.route(`**${root}**`, async route => {
        const url = new URL(route.request().url());
        if (url.pathname === `${root}/directions`) { directions++; if (directions === 1) return route.fulfill({ json: { bad: true } }); }
        if (url.pathname === root && route.request().method() === "POST") { posts++; expect(route.request().postDataJSON()).toEqual({ direction, kind: "tech", text: raw }); if (posts === 1) return route.fulfill({ status: 400, json: { error: "合成导入校验拒绝" } }); }
        return route.continue();
      });
      await page.setViewportSize({ width, height: 900 }); await page.goto("/bank");
      await expect(page.getByRole("alert").filter({ hasText: "方向列表加载失败" })).toContainText("响应不完整");
      const form = page.getByRole("group", { name: "批量录入考题", exact: true }); const input = form.getByRole("textbox", { name: "导入考题", exact: true }); await input.fill(raw);
      await page.getByRole("button", { name: "点击重试", exact: true }).click(); await expect(page.getByRole("alert").filter({ hasText: "方向列表加载失败" })).toHaveCount(0);
      // 自由输入失焦和提交发生在同次点击链中，提交必须使用刚刚确认的新方向。
      await form.getByRole("combobox", { name: "导入方向", exact: true }).fill(direction);
      await form.getByRole("button", { name: "导入 2 道考题", exact: true }).click(); await expect(page.getByRole("alert").filter({ hasText: "合成导入校验拒绝" })).toBeVisible();
      await expect(input).toHaveValue(raw); await expect(input).toBeEnabled(); expect(await entries(request, { q: marker })).toHaveLength(0);
      await form.getByRole("button", { name: "导入 2 道考题", exact: true }).click(); await expect(page.getByRole("status").filter({ hasText: "成功导入 2 道题" })).toBeVisible();
      const stored = await entries(request, { q: marker }); expect(stored).toHaveLength(2); expect(stored.every(item => item.direction === direction)).toBe(true); expect(posts).toBe(2);
    } finally { expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
  });
}
