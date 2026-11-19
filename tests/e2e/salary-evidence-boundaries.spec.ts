import { expect, test } from "@playwright/test";
import type { NegotiationReport, SalaryNegotiationDetail } from "../../src/lib/salary-negotiation";
import { gate, mockApi } from "./synthetic-api";

for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
  test(`谈薪 ${viewport.width}px：未达成的结束、条件与开局评分边界`, async ({ page }, testInfo) => {
    await mockApi(page);
    const summary = "尚未达成；税前 CNY 月薪 30k × 12，奖金需审批，签字费尚未书面确认。";
    const supplement = "我只认可月薪；奖金、签字费仍待 HR 确认。";
    const reference = "请确认保证薪数与浮动奖金，当前未达成一致。";
    const report: NegotiationReport = {
      final_package_summary: summary, score: 75, persuasion_grade: "B", leverage_efficiency: "尚无法确认保证现金增益。",
      turn_critiques: [], real_world_tips: ["先核对书面审批与保证薪数"], mentor_summary: "这只是模拟练习，保持条件边界。",
    };
    let saved: SalaryNegotiationDetail & { revision: string } = {
      revision: "a".repeat(64),
      id: 9011, target_company_tier: "top_tech", target_role: "未达成条件边界演练", expected_salary: "税前 CNY 月薪 30k × 12",
      current_or_competing_offer: "无竞品 Offer", hr_style: "standard", status: "ongoing", initial_offer: "模拟 28k × 12",
      final_package: "", report: null, created_at: "2026-10-28", finished_at: "",
      turns: [{
        id: 90111, negotiation_id: 9011, turn_no: 1, user_message: "", hr_response: "模拟报价仍需审批，请先确认薪数。", hr_tactics: "模拟澄清条件",
        hr_mindset: { looseness: 0, current_attitude: "模拟，暂无调整", estimated_package: "模拟，需审批", tactics_label: "模拟澄清", internal_pressure: "未设定" },
        mentor_analysis: { user_argument_score: 5, strengths: ["已知候选人期望"], vulnerabilities: ["保证薪数待确认"], tactical_tips: "候选人尚未发言，这是中性起点。",
          suggested_replies: [{ title: "澄清薪酬结构", content: reference, rationale: "区分保证现金与浮动部分" }] }, created_at: "2026-10-28",
      }],
    };
    let turnsSent = 0;
    let finalizations = 0;
    const pending = gate();
    await page.route("**/api/tools/salary-negotiations**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/turn")) {
        turnsSent++;
        await route.fulfill({ status: 500, json: { error: "本流程不应自动发送建议" } });
      } else if (url.pathname.endsWith("/finalize")) {
        finalizations++;
        const baseRevision = saved.revision;
        expect(route.request().postDataJSON()).toEqual({ final_words: supplement, expected_revision: baseRevision });
        await pending.promise;
        saved = { ...saved, revision: "b".repeat(64), status: "finished", final_package: summary, report, finished_at: "2026-10-28" };
        await route.fulfill({ json: { id: saved.id, status: saved.status, final_package: summary, finished_at: saved.finished_at, report,
          base_revision: baseRevision, revision: saved.revision } });
      } else if (url.pathname.endsWith("/9011")) {
        await route.fulfill({ json: saved });
      } else {
        await route.fulfill({ json: { items: [{ ...saved, turns_count: 1 }], nextCursor: null, total: 1 } });
      }
    });
    await page.setViewportSize(viewport);
    await page.goto("/tools/salary/9011");
    await expect(page.getByText("开局分析 · 尚未评分", { exact: true })).toBeVisible();
    await expect(page.getByText("/10", { exact: true })).toHaveCount(0);
    const meter = page.getByRole("meter", { name: "模拟可谈程度", exact: true });
    await expect(meter).toHaveAttribute("aria-valuenow", "0");
    await expect(meter.locator("div")).toHaveCSS("width", "0px");
    await expect(page.getByText(/不代表真实 HR 心理、公司预算或谈成概率/)).toBeVisible();
    await page.getByRole("button", { name: "一键填入输入框 ↗", exact: true }).click();
    const input = page.getByRole("textbox", { name: "你的练习回复", exact: true });
    await expect(input).toHaveValue(reference);
    await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", isComposing: true });
    await input.dispatchEvent("keydown", { key: "Enter", code: "Enter", keyCode: 229 });
    await expect(input).toHaveValue(reference);
    expect(turnsSent).toBe(0);
    await page.getByRole("button", { name: "结束模拟 / 生成复盘", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "结束模拟并生成复盘报告", exact: true });
    await dialog.getByRole("textbox", { name: "结束补充（可选）", exact: true }).fill(supplement);
    await dialog.getByRole("button", { name: "结束模拟并生成报告", exact: true }).click();
    await expect(dialog.getByRole("button", { name: "正在生成复盘报告…", exact: true })).toBeVisible();
    pending.release();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("heading", { name: `本次模拟结果：${summary}`, exact: true })).toBeVisible();
    await expect(page.getByText("模拟练习评分", { exact: true })).toHaveCount(0);
    await expect(page.getByText(/尚无已提交的候选人发言/)).toBeVisible();
    await page.reload();
    await expect(page.getByRole("heading", { name: `本次模拟结果：${summary}`, exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "你的练习回复", exact: true })).toHaveCount(0);
    await page.goto("/tools/salary");
    await expect(page.getByText("模拟已结束 / 已复盘", { exact: true })).toBeVisible();
    await expect(page.getByText(`终局: ${summary}`, { exact: true })).toBeVisible();
    await expect(page.getByText("已达成 / 已复盘", { exact: true })).toHaveCount(0);
    await page.getByRole("link", { name: "查看复盘", exact: true }).click();
    await expect(page.getByRole("heading", { name: `本次模拟结果：${summary}`, exact: true })).toBeVisible();
    expect(turnsSent).toBe(0);
    expect(finalizations).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`salary-report-${viewport.width}.png`), fullPage: true });
  });
}
