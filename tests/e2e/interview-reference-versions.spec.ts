import { expect, test } from "@playwright/test";
import { gate, mockApi } from "./synthetic-api";

function retry(id: string) {
  return { id, answer: `重答 ${id}：只负责接口校验，尚未上线。`, scores: { depth: 8, structure: 8, authenticity: 8, completeness: 8 },
    comment: `点评 ${id}：保留分工边界`, reference: `参考 ${id}：[待补充：真实方案]，未上线；<T> &amp; 保留原字符。`, created_at: "2026-10-28" };
}

for (const width of [390, 1280]) {
  test(`面试复盘 ${width}px：参考对应所选版本，失败可重试，重答只提交实际输入`, async ({ page }, testInfo) => {
    await mockApi(page);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    const original = "题目原参考：只说明实际分工，[待补充：方案]。";
    let saved = {
      id: 9013, resume_title: "合成简历", resume_version_id: 90001, resume_version: 1, resume_version_name: "测试版本", jd: "接口开发岗位",
      rounds: 1, style: "technical", series_id: null, round_no: 1, series_status: null, series_rounds: [], status: "finished", report: null,
      evaluator_report: null, reverse_interview: null, created_at: "2026-10-28", finished_at: "2026-10-28",
      turns: [{ id: 90131, idx: 1, kind: "question", question: "你个人负责哪些工作？", answer: "原答：仅做接口联调，没有选型权。", comment: "原答点评，分工明确。",
        scores: { depth: 7, structure: 7, authenticity: 8, completeness: 7 }, reference: original, retries: [retry("a"), retry("b")], answered_at: "2026-10-28", notebook_id: null }],
    };
    let referenceCalls = 0;
    let retryCalls = 0;
    const pending = gate();
    const answer = "我仅负责接口参数校验，没有架构选型权，尚未上线。";
    const regenerated = "重新生成的题目参考：仅依据原题、原答；[待补充：实际方案]。";
    await page.route("**/api/interviews/9013**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/reference")) {
        referenceCalls++;
        if (referenceCalls === 1) {
          await route.fulfill({ status: 502, json: { error: "合成参考生成失败" } });
          return;
        }
        saved = { ...saved, turns: [{ ...saved.turns[0]!, reference: regenerated }] };
        await route.fulfill({ json: { reference: regenerated } });
      } else if (path.endsWith("/retry")) {
        retryCalls++;
        expect(route.request().postDataJSON()).toEqual({ answer });
        await pending.promise;
        const next = { ...retry("c"), id: `retry_${route.request().headers()["idempotency-key"]}`, answer };
        const turn = { ...saved.turns[0]!, retries: [...saved.turns[0]!.retries, next] };
        saved = { ...saved, turns: [turn] };
        await route.fulfill({ json: { retry: next, retries: turn.retries, reference: turn.reference } });
      } else {
        await route.fulfill({ json: saved });
      }
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/interviews/9013");
    const reference = page.getByRole("region", { name: "当前回答参考", exact: true });
    const card = page.locator("#turn-90131");
    await expect(reference).toHaveText(retry("b").reference);
    for (const [name, expected] of [["重答#1", retry("a").reference], ["原答", original], ["重答#2", retry("b").reference]] as const) {
      await page.getByRole("button", { name: new RegExp(name) }).click();
      await expect(reference).toHaveText(expected);
      await page.getByRole("button", { name: "复制参考答案", exact: true }).click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expected);
    }
    expect(referenceCalls).toBe(0);
    expect(retryCalls).toBe(0);
    await page.getByRole("button", { name: "查看题目参考", exact: true }).click();
    await page.getByRole("button", { name: "重新生成", exact: true }).click();
    await expect(card.getByRole("alert")).toHaveText("合成参考生成失败");
    await expect(reference).toHaveText(original);
    await page.getByRole("button", { name: "重新生成", exact: true }).click();
    await expect(reference).toHaveText(regenerated);
    await expect(card.getByRole("alert")).toHaveCount(0);
    await page.getByRole("button", { name: /重答#2/ }).click();
    await expect(reference).toHaveText(retry("b").reference);
    await page.getByRole("button", { name: /重答这一题/ }).click();
    const input = page.getByRole("textbox", { name: /重新作答此题/ });
    await expect(input).toHaveValue(retry("b").answer);
    await input.fill(answer);
    await page.getByRole("button", { name: "提交并重新评分", exact: true }).click();
    for (const name of ["清空重新写", "导入当前作答做修改", "收起重答面板"]) {
      await expect(page.getByRole("button", { name, exact: true })).toBeDisabled();
    }
    await expect(input).toHaveValue(answer);
    pending.release();
    await expect(input).toHaveCount(0);
    await expect(reference).toHaveText(retry("c").reference);
    await page.reload();
    await expect(reference).toHaveText(retry("c").reference);
    expect(referenceCalls).toBe(2);
    expect(retryCalls).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`interview-reference-${width}.png`), fullPage: true });
  });

  test(`面试复盘 ${width}px：十二次重答的版本入口完整可见，可键盘切换并复制`, async ({ page }, testInfo) => {
    await mockApi(page);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    const reference = "原答的题目参考：[待补充：原始分工记录]。";
    const retries = Array.from({ length: 12 }, (_, index) => retry(`v${index + 1}`));
    let writes = 0;
    await page.route("**/api/interviews/9014**", async (route) => {
      if (route.request().method() !== "GET") writes++;
      await route.fulfill({ json: {
        id: 9014, resume_title: "多次重答合成简历", jd: "接口开发", rounds: 1, style: "deep", status: "finished",
        series_id: null, round_no: 1, series_status: null, series_rounds: [], report: null, evaluator_report: null,
        reverse_interview: null, created_at: "2026-10-28", finished_at: "2026-10-28",
        turns: [{ id: 90141, idx: 1, kind: "question", question: "如何核实个人分工与验证范围？", answer: "原答：仅负责接口联调，未上线。",
          comment: "原答点评", scores: { depth: 7, structure: 7, authenticity: 8, completeness: 7 }, reference, retries,
          answered_at: "2026-10-28", notebook_id: null }],
      } });
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/interviews/9014");
    const card = page.locator("#turn-90141");
    const versionGroup = card.getByRole("group", { name: "作答版本", exact: true });
    const versions = versionGroup.getByRole("button", { name: /^重答#/ });
    await expect(versions).toHaveCount(12);
    const clipped = await versions.evaluateAll((buttons) => buttons.flatMap((button) => {
      const bounds = button.parentElement!.parentElement!.getBoundingClientRect();
      const rect = button.getBoundingClientRect();
      return rect.left < bounds.left - 1 || rect.right > bounds.right + 1 ? [button.textContent] : [];
    }));
    expect(clipped).toEqual([]);
    const displayed = card.getByRole("region", { name: "当前回答参考", exact: true });
    for (const index of [0, 5, 11]) {
      const button = versionGroup.getByRole("button", { name: new RegExp(`^重答#${index + 1}(?!\\d)`) });
      await button.focus();
      await button.press("Enter");
      await expect(button).toHaveAttribute("aria-pressed", "true");
      await expect(displayed).toHaveText(retries[index]!.reference);
      await expect(card.getByText(retries[index]!.answer, { exact: true })).toBeVisible();
      await card.getByRole("button", { name: "复制参考答案", exact: true }).click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(retries[index]!.reference);
    }
    await card.getByRole("button", { name: "原答", exact: true }).click();
    await expect(displayed).toHaveText(reference);
    await expect(versionGroup.getByRole("button", { pressed: true })).toHaveText("原答");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(writes).toBe(0);
    await card.screenshot({ path: testInfo.outputPath(`interview-many-versions-${width}.png`) });
  });
}
