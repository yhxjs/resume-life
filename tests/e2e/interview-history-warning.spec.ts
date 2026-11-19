import { expect, test } from "@playwright/test";
import { mockApi } from "./synthetic-api";

for (const width of [390, 1280]) {
  test(`重答历史 ${width}px：损坏提示保留原题，修复后刷新恢复版本入口`, async ({ page }, testInfo) => {
    await mockApi(page);
    await page.setViewportSize({ width, height: 900 });
    const warning = "重答历史暂无法读取，原始记录已保留。请刷新核对，或从有效备份恢复后再重答。";
    const original = "原答 <T> &amp;：仅负责接口校验，未上线。";
    const reference = "原题参考 <T> &amp;\n成果仍需核实。";
    let damaged = true;
    let writes = 0;
    await page.route("**/api/interviews/9016**", async route => {
      if (route.request().method() !== "GET") writes++;
      await route.fulfill({ json: {
        id: 9016, resume_title: "历史读取合成简历", jd: "接口开发", rounds: 1, style: "technical", status: "finished",
        series_id: null, round_no: 1, series_status: null, series_rounds: [], report: null, evaluator_report: null, reverse_interview: null,
        created_at: "2026-10-28", finished_at: "2026-10-28",
        turns: [{ id: 90161, idx: 1, kind: "question", question: "如何验证接口？", answer: original, comment: "原点评", scores: null,
          reference, answered_at: "2026-10-28", notebook_id: null,
          retries: damaged ? [] : [{ id: "legacy", answer: "旧回答", scores: null, comment: "", created_at: "" }],
          ...(damaged ? { retries_error: warning } : {}),
        }],
      } });
    });
    await page.goto("/interviews/9016");
    const card = page.locator("#turn-90161");
    await expect(card.getByRole("alert")).toHaveText(warning);
    await expect(card.getByText(original, { exact: true })).toBeVisible();
    expect(await card.getByRole("region", { name: "当前回答参考", exact: true }).textContent()).toBe(reference);
    await expect(card.getByRole("button", { name: /重答这一题/ })).toBeDisabled();
    await expect(card.getByText(/重答暂时停用/)).toBeVisible();
    await expect(card.getByText(/随时可以发起重答/)).toHaveCount(0);
    await expect(card.getByRole("textbox")).toHaveCount(0);
    expect(writes).toBe(0);
    await card.screenshot({ path: testInfo.outputPath(`history-warning-${width}.png`) });
    damaged = false;
    await page.reload();
    await expect(card.getByRole("alert")).toHaveCount(0);
    await expect(card.getByRole("button", { name: /重答#1/ })).toBeVisible();
    await expect(card.getByText("旧回答", { exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: /重答这一题/ })).toBeEnabled();
    expect(await card.getByRole("region", { name: "当前回答参考", exact: true }).textContent()).toBe(reference);
    expect(writes).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
