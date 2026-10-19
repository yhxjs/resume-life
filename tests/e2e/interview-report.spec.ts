import { expect, test } from "@playwright/test";
import { mockApi } from "./synthetic-api";

test("missing evaluator stays explicit and retry preserves the candidate report", async ({ page }) => {
  await mockApi(page);
  const writes: string[] = [];
  const candidate = { depth: 9, structure: 9, authenticity: 9, completeness: 9, jd_match: 9, overall: 9, strengths: "原有候选人优势", weaknesses: "原有短板", suggestions: "原有建议" };
  const evaluator = { recommendation: "Lean No", level: "P5", level_justification: "需验证系统设计能力", summary_for_hr: "原始回答证据不足", hire_reasons: [], concerns_and_risks: ["系统设计薄弱"], placement_suggestion: "建议追加考察" };
  await page.route("**/api/interviews/9004**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (route.request().method() === "POST") {
      writes.push(pathname);
      return route.fulfill({ json: { evaluator_report: evaluator } });
    }
    return route.fulfill({ json: {
      id: 9004, resume_title: "合成简历", resume_version_id: 90001, resume_version: 1, resume_version_name: "测试发布版本", jd: "合成岗位", rounds: 1, style: "gentle", series_id: null,
      round_no: 0, series_status: null, series_rounds: [], status: "finished", report: candidate,
      evaluator_report: null, reverse_interview: null, created_at: "2026-09-16T00:00:00Z", finished_at: "2026-09-16T00:01:00Z", turns: [],
    } });
  });
  await page.goto("/interviews/9004");
  await expect(page.getByText("原有候选人优势", { exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("面试官评估未生成");
  await page.getByRole("button", { name: "前往重试面试官评估" }).click();
  await expect(page.getByRole("heading", { name: "面试官评估未生成" })).toBeVisible();
  await expect(page.getByText(/STRONG HIRE|P7/)).toHaveCount(0);
  await page.getByRole("button", { name: "重试生成面试官评估", exact: true }).click();
  await expect(page.getByText("原始回答证据不足", { exact: true })).toBeVisible();
  expect(writes).toEqual(["/api/interviews/9004/evaluator-report"]);
  await page.getByRole("button", { name: /候选人全景复盘报告/ }).click();
  await expect(page.getByText("原有候选人优势", { exact: true })).toBeVisible();
});
