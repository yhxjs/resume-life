import { expect, test } from "@playwright/test";
import { mockApi } from "./synthetic-api";

for (const width of [390, 1280]) {
  for (const reducedMotion of ["no-preference", "reduce"] as const) {
    test(`复盘跳题 ${width}px ${reducedMotion}：题头避开换行导航，调整窗口后仍可键盘定位`, async ({ page }, testInfo) => {
      await mockApi(page);
      await page.emulateMedia({ reducedMotion });
      await page.setViewportSize({ width, height: 900 });
      const turns = Array.from({ length: 14 }, (_, index) => ({
        id: 90201 + index, idx: index + 1, kind: "question",
        question: `第 ${index + 1} 题：如何核实个人分工与验证范围？`,
        answer: Array.from({ length: 20 }, (_, line) => `记录 ${line + 1}：我仅负责接口联调，尚未上线；实际方案仍待核实。`).join("\n\n"),
        comment: "仅按实际分工点评，不推断未验证结果。", scores: null,
        reference: "[待补充：实际方案]。", retries: [], answered_at: "2026-10-28", notebook_id: null,
      }));
      let writes = 0;
      await page.route("**/api/interviews/9020**", async (route) => {
        if (route.request().method() !== "GET") writes++;
        await route.fulfill({ json: {
          id: 9020, resume_title: "跳题合成简历", jd: "接口开发", rounds: 14, style: "technical", status: "finished",
          series_id: null, round_no: 1, series_status: null, series_rounds: [], report: null, evaluator_report: null,
          reverse_interview: null, created_at: "2026-10-28", finished_at: "2026-10-28", turns,
        } });
      });
      await page.goto("/interviews/9020");
      const navigation = page.getByRole("navigation", { name: "复盘题目导航", exact: true });
      await expect(navigation.getByRole("button")).toHaveCount(14);
      for (const viewport of [width, width === 390 ? 1280 : 390]) {
        await page.setViewportSize({ width: viewport, height: 900 });
        for (const index of [0, 6, 13]) {
          const jump = navigation.getByRole("button", { name: new RegExp(`^Q${index + 1}(?!\\d)`) });
          await jump.focus();
          await jump.press(index === 6 ? "Space" : "Enter");
          await expect.poll(async () => {
            const card = await page.locator(`#turn-${turns[index]!.id}`).boundingBox();
            const bar = await navigation.boundingBox();
            return card!.y - (bar!.y + bar!.height);
          }).toBeCloseTo(16, 0);
          const question = page.getByRole("heading", { name: turns[index]!.question, exact: true });
          await expect(question).toBeInViewport();
          const uncovered = await question.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const top = document.elementFromPoint(rect.left + 5, rect.top + rect.height / 2);
            return top === element || element.contains(top);
          });
          expect(uncovered).toBe(true);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      }
      expect(writes).toBe(0);
      await page.screenshot({ path: testInfo.outputPath(`review-navigation-${width}-${reducedMotion}.png`) });
    });
  }
}
