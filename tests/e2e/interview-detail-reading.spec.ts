import { expect, test } from "@playwright/test";
import { mockApi } from "./synthetic-api";

for (const width of [390, 1280]) {
  test(`面试详情 ${width}px：错误详情可重读，保存后坏回读保留草稿且不重复提交`, async ({ page }, testInfo) => {
    await mockApi(page);
    await page.setViewportSize({ width, height: 900 });
    const draft = "  我的真实回答 <T> &amp;\n仍待核实  ";
    const turn = { id: 90171, idx: 1, kind: "question", question: "如何核对接口验证范围？", answer: "", comment: "", scores: null, reference: "", retries: [], answered_at: "", notebook_id: null };
    const data = { id: 9017, resume_title: "详情读取合成简历", jd: "接口开发", rounds: 2, style: "technical", status: "ongoing", series_id: null,
      round_no: 1, series_status: null, series_rounds: [], report: null, evaluator_report: null, reverse_interview: null, created_at: "2026-11-03", finished_at: "", turns: [turn] };
    const saved = { ...data, turns: [{ ...turn, answer: draft.trim(), comment: "已保存点评", answered_at: "saved" }, { ...turn, id: 90172, idx: 2, question: "哪些结果仍待核实？" }] };
    let reads = 0;
    let writes = 0;
    const pageErrors: string[] = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.route("**/api/interviews/9017**", async route => {
      if (route.request().method() === "POST") {
        writes++;
        expect(route.request().postDataJSON()).toEqual({ turn_id: turn.id, answer: draft });
        await route.fulfill({ contentType: "text/event-stream", body: "event: done\ndata: {}\n\n" });
        return;
      }
      reads++;
      const payload = reads === 1 ? { ...data, id: 9999 } : reads === 2 ? { ...data, turns: [{ ...turn, question: {} }] }
        : reads === 3 ? data : reads === 4 ? { ...saved, turns: [{ ...saved.turns[0], scores: {} }, saved.turns[1]] } : saved;
      await route.fulfill({ json: payload });
    });
    await page.goto("/interviews/9017");
    const content = page.getByRole("main");
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(content.getByRole("alert")).toContainText("面试状态不完整");
      await expect(page.getByRole("button", { name: "提交回答", exact: true })).toHaveCount(0);
      expect(writes).toBe(0);
      if (attempt === 0) await page.screenshot({ path: testInfo.outputPath(`detail-invalid-${width}.png`), fullPage: true });
      await page.getByRole("button", { name: "重试加载", exact: true }).click();
    }
    const input = page.getByRole("textbox", { name: /以候选人身份组织作答/ });
    await input.fill(draft);
    await page.getByRole("button", { name: "提交回答", exact: true }).click();
    await expect(content.getByRole("alert")).toContainText("作答已保存，读取结果失败");
    await expect(page.getByRole("textbox")).toHaveValue(draft);
    expect(writes).toBe(1);
    await page.screenshot({ path: testInfo.outputPath(`detail-read-recovery-${width}.png`), fullPage: true });
    await page.getByRole("button", { name: "重新读取已保存作答", exact: true }).click();
    await expect(page.getByText("哪些结果仍待核实？", { exact: true })).toBeVisible();
    await expect(input).toHaveValue("");
    await expect(content.getByRole("alert")).toHaveCount(0);
    expect(reads).toBe(5);
    expect(writes).toBe(1);
    expect(pageErrors).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
