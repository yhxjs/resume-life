import { expect, test } from "@playwright/test";
import { mockApi } from "./synthetic-api";

for (const width of [390, 1280]) {
  test(`题目参考 ${width}px：坏正文保留旧参考与草稿，主动重试只更新题目参考`, async ({ page }, testInfo) => {
    await mockApi(page);
    await page.setViewportSize({ width, height: 900 });
    const original = "题目原参考 <T> &amp;\n内部  空格，实际结果待核实。";
    const next = "新题目参考 <T> &amp;\n保留实际分工，未上线。";
    const oldRetry = { id: "historical", answer: "旧重答，未上线", scores: null, comment: "旧点评", reference: "旧重答的独立参考", created_at: "2026-10-28" };
    const data = {
      id: 9015, resume_title: "合成简历", resume_version_id: 90001, resume_version: 1, resume_version_name: "测试版本", jd: "接口开发岗位",
      rounds: 1, style: "technical", series_id: null, round_no: 1, series_status: null, series_rounds: [], status: "finished", report: null,
      evaluator_report: null, reverse_interview: null, created_at: "2026-10-28", finished_at: "2026-10-28",
      turns: [{ id: 90151, idx: 1, kind: "question", question: "如何验证接口兼容性？", answer: "仅参与参数校验，尚未上线。", comment: "原答点评",
        scores: null, reference: original, retries: [oldRetry], answered_at: "2026-10-28", notebook_id: null }],
    };
    const bad = [{}, { reference: {} }, { reference: 123 }, { reference: " \n\t " }];
    let writes = 0;
    let retryWrites = 0;
    await page.route("**/api/interviews/9015**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/reference")) {
        const response = bad[writes++];
        if (response) return route.fulfill({ json: response });
        data.turns[0]!.reference = next;
        return route.fulfill({ json: { reference: next } });
      }
      if (route.request().method() !== "GET") retryWrites++;
      return route.fulfill({ json: data });
    });
    await page.goto("/interviews/9015");
    const card = page.locator("#turn-90151");
    const reference = card.getByRole("region", { name: "当前回答参考", exact: true });
    await card.getByRole("button", { name: "查看题目参考", exact: true }).click();
    await card.getByRole("button", { name: /重答这一题/ }).click();
    const draft = card.getByRole("textbox", { name: /重新作答此题/ });
    const text = "  我的新草稿 <T> &amp;\n仍待核实  ";
    await draft.fill(text);
    for (let index = 0; index < bad.length; index++) {
      await card.getByRole("button", { name: "重新生成", exact: true }).click();
      await expect(card.getByRole("alert")).toContainText("参考答案响应不完整");
      expect(await reference.textContent()).toBe(original);
      await expect(draft).toHaveValue(text);
      expect(writes).toBe(index + 1);
      expect(retryWrites).toBe(0);
    }
    await page.screenshot({ path: testInfo.outputPath(`reference-invalid-${width}.png`), fullPage: true, animations: "disabled" });
    await card.getByRole("button", { name: "重新生成", exact: true }).click();
    await expect(reference).toHaveText(next);
    await expect(card.getByRole("alert")).toHaveCount(0);
    await expect(draft).toHaveValue(text);
    await card.getByRole("button", { name: /重答#1/ }).click();
    await expect(reference).toHaveText(oldRetry.reference);
    await card.getByRole("button", { name: "查看题目参考", exact: true }).click();
    expect(await reference.textContent()).toBe(next);
    expect(writes).toBe(5);
    expect(retryWrites).toBe(0);
    expect(data.turns[0]!.retries).toEqual([oldRetry]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.reload();
    await card.getByRole("button", { name: "查看题目参考", exact: true }).click();
    expect(await reference.textContent()).toBe(next);
  });
}
