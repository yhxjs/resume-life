import { expect, test } from "@playwright/test";
import { mockApi } from "./synthetic-api";

for (const width of [390, 1280]) {
  for (const kind of ["jd", "decoder"] as const) {
    test(`${kind} 历史报告损坏 ${width}px：原文可核对，刷新不写入或删除记录`, async ({ page }) => {
      await mockApi(page);
      const source = "原文本 <T> &amp;\n只维护已有平台；规模、权限与时间安排尚未确认。";
      const isJd = kind === "jd";
      const endpoint = isJd ? "jd-portraits" : "jargon-decodings";
      const data = { id: 9013, result: null, created_at: "2026-10-28", ...(isJd ? { jd: source } : { source_text: source }) };
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      let writes = 0;
      await page.route(`**/api/tools/${endpoint}**`, (route) => {
        if (route.request().method() !== "GET") writes++;
        return route.fulfill({ json: data });
      });
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/tools/${kind}/9013`);
      for (const refresh of [false, true]) {
        if (refresh) await page.reload();
        await expect(page.getByText(isJd ? /该画像内容无法解析/ : /该报告内容无法解析/)).toBeVisible();
        await page.getByText(isJd ? "查看完整原始 JD 文本要求" : "查看原始 JD / 输入文本", { exact: true }).click();
        await expect(page.getByRole("region", { name: isJd ? "原始 JD" : "原始输入文本", exact: true })).toHaveText(source);
        await expect(page.getByRole("link", { name: isJd ? "返回列表" : "返回重试", exact: true }))
          .toHaveAttribute("href", `/tools/${kind}`);
        await expect(page.getByText(/可删除.*后重新生成/)).toHaveCount(0);
        await expect(page.getByRole("meter")).toHaveCount(0);
      }
      expect(errors).toEqual([]);
      expect(writes).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  }
}
