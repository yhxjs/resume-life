import { expect, test } from "@playwright/test";
import { gate, mockApi } from "./synthetic-api";

for (const width of [390, 1280]) {
  test(`公共列表 ${width}px：新筛选失败不显示旧题，异常分页不重复追加`, async ({ page }, testInfo) => {
    await mockApi(page);
    const waiting = gate();
    let entered = false;
    let newFirstPages = 0;
    let morePages = 0;
    let writes = 0;
    const row = (id: number, question: string) => ({ id, question, kind: "tech", direction: "合成方向", created_at: "2026-10-28" });
    await page.route("**/api/bank?**", async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() !== "GET") { writes++; return route.fulfill({ status: 500, json: { error: "此用例不应写入" } }); }
      if (url.searchParams.has("cursor")) {
        morePages++;
        if (morePages === 1) return route.fulfill({ json: { items: [row(2, "新筛选异常分页不应出现")], nextCursor: "3" } });
        return route.fulfill({ json: { items: [row(2, "新筛选第二题")], nextCursor: null } });
      }
      if (url.searchParams.get("q") === "新筛选") {
        newFirstPages++;
        if (newFirstPages === 1) {
          entered = true;
          await waiting.promise;
          return route.fulfill({ status: 503, json: { error: "合成新筛选失败" } });
        }
        return route.fulfill({ json: { items: [row(3, "新筛选第一题")], nextCursor: "3" } });
      }
      return route.fulfill({ json: { items: [row(4, "旧筛选题目")], nextCursor: "4" } });
    });
    try {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/bank");
      const input = page.getByRole("searchbox", { name: "搜索题库", exact: true });
      await input.fill("旧筛选");
      await expect(page.getByText("旧筛选题目", { exact: true })).toBeVisible();
      await input.fill("新筛选");
      await expect.poll(() => entered).toBe(true);
      await expect(page.getByText("旧筛选题目", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "加载更多", exact: true })).toHaveCount(0);
      waiting.release();
      await expect(page.getByRole("alert").filter({ hasText: "合成新筛选失败" })).toBeVisible();
      await expect(page.getByText("旧筛选题目", { exact: true })).toHaveCount(0);
      await expect(input).toHaveValue("新筛选");
      await page.getByRole("button", { name: "重试加载", exact: true }).click();
      await expect(page.getByText("新筛选第一题", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "加载更多", exact: true }).click();
      const alert = page.getByRole("alert").filter({ hasText: "题库读取响应不完整或筛选不符" });
      await expect(alert).toBeVisible();
      await expect(page.getByText("新筛选异常分页不应出现", { exact: true })).toHaveCount(0);
      await expect(page.getByText("新筛选第一题", { exact: true })).toHaveCount(1);
      expect(morePages).toBe(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await alert.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`cursor-list-error-${width}.png`) });
      await page.getByRole("button", { name: "重试加载更多", exact: true }).click();
      await expect(page.getByText("新筛选第一题", { exact: true })).toHaveCount(1);
      await expect(page.getByText("新筛选第二题", { exact: true })).toHaveCount(1);
      await expect(page.getByRole("alert").filter({ hasText: "题库读取响应" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "加载更多", exact: true })).toHaveCount(0);
      expect(morePages).toBe(2);
      expect(newFirstPages).toBe(2);
      expect(writes).toBe(0);
    } finally {
      waiting.release();
    }
  });
}
