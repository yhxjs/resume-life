import { expect, test } from "@playwright/test";
import { mockApi } from "./synthetic-api";
import { emptySummary, type ProjectSummary } from "../../src/lib/summary";
import { compareProjectSummaries } from "../../src/lib/project-summary-diff";

test("knowledge detail keeps material drafts after failure and requires summary confirmation", async ({ page }) => {
  await mockApi(page);
  let materialPostAttempts = 0;
  let materials = [{ id: 1, title: "已有材料", source: "paste", filename: "", content: "已有内容", created_at: "2026-09-16" }];
  let summary = emptySummary();
  let revisionId = 0;
  let summaryPatches = 0;

  await page.route("**/api/projects/1", async (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as { summary?: ProjectSummary; expectedRevisionId?: number };
      if (body.summary) {
        expect(body.expectedRevisionId).toBe(revisionId);
        summary = body.summary;
        revisionId += 1;
        summaryPatches += 1;
      }
      await route.fulfill({ json: { revisionId, summary, summary_updated_at: "2026-11-02T00:00:00Z" } });
      return;
    }
    await route.fulfill({ json: { id: 1, name: "合成项目", summary, summary_revision_id: revisionId, summary_updated_at: revisionId ? "2026-11-02T00:00:00Z" : "", materials } });
  });
  await page.route("**/api/projects/1/materials", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fulfill({ json: {} });
      return;
    }
    materialPostAttempts += 1;
    if (materialPostAttempts === 1) {
      // 明确拒绝允许修正后重提；503 的未知写入归属由真实接口恢复用例覆盖。
      await route.fulfill({ status: 400, json: { error: "合成材料失败" } });
      return;
    }
    materials = [...materials, { id: 2, title: "新材料", source: "paste", filename: "", content: "保留草稿", created_at: "2026-09-16" }];
    await route.fulfill({ status: 201, json: { id: 2, title: "新材料", source: "paste", filename: "" } });
  });
  await page.route("**/api/projects/1/materials/1", async (route) => {
    materials = materials.filter((material) => material.id !== 1);
    await route.fulfill({ json: { ok: true } });
  });
  await page.route("**/api/projects/1/summarize", async (route) => {
    const generated = { ...emptySummary(), overview: "合成摘要" };
    await route.fulfill({
      headers: { "Content-Type": "text/event-stream" },
      body: `event: done\ndata: ${JSON.stringify({ summary: generated, comparison: compareProjectSummaries(summary, generated, {}), materialChanges: [], materialFingerprint: "a".repeat(64), revisionId })}\n\n`,
    });
  });

  await page.goto("/knowledge/1");
  await expect(page.getByRole("heading", { name: "合成项目", exact: true })).toBeVisible();

  const materialInput = page.getByPlaceholder("粘贴架构方案、接口说明、大促复盘笔记或 PRD 重点…");
  await page.getByRole("textbox", { name: "材料标题", exact: true }).fill("新材料");
  await materialInput.fill("保留草稿");
  await page.getByRole("button", { name: "+ 导入粘贴材料", exact: true }).click();
  await expect(page.getByText("合成材料失败", { exact: true })).toBeVisible();
  await expect(materialInput).toHaveValue("保留草稿");
  await expect(page.getByRole("textbox", { name: "材料标题", exact: true })).toHaveValue("新材料");

  await page.getByRole("button", { name: "+ 导入粘贴材料", exact: true }).click();
  await expect(page.getByText("新材料", { exact: true })).toBeVisible();
  await expect(materialInput).toHaveValue("");
  expect(materialPostAttempts).toBe(2);

  await page.getByRole("button", { name: /生成 AI STAR 总结/ }).first().click();
  await expect(page.getByText("AI 总结草稿已生成，确认前不会写入项目档案", { exact: true })).toBeVisible();
  expect(summaryPatches).toBe(0);
  await page.getByRole("button", { name: "确认采用入库", exact: true }).click();
  await expect.poll(() => summaryPatches).toBe(1);
  await expect(page.getByText("草稿已确认，总结已写入项目档案", { exact: true })).toBeVisible();
  expect(summary).toEqual({ ...emptySummary(), overview: "合成摘要" });

  await page.getByRole("button", { name: "删除", exact: true }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "删除", exact: true }).click();
  await expect(page.getByText("已有材料", { exact: true })).toHaveCount(0);
});

test("gap remedies preserve input across preset inspection and generation failure", async ({ page }) => {
  await mockApi(page);
  let deleted = false;
  let generationAttempts = 0;
  const record = {
    id: 1,
    scenario_type: "gap",
    raw_story: "历史空窗经历",
    target_role: "前端工程师",
    persona_style: "pragmatic",
    result: JSON.stringify({ title: "历史报告", punchline: "保持稳定", scripts: { concise: { script: "简短" }, detailed: { script: "详细" } } }),
    created_at: "2026-09-16T00:00:00Z",
  };
  await page.route("**/api/tools/career-gap-remedies*", async (route) => {
    if (route.request().method() === "POST") {
      generationAttempts += 1;
      await route.fulfill({ status: 502, json: { error: "合成生成失败" } });
      return;
    }
    await route.fulfill({ json: { items: deleted ? [] : [record], nextCursor: null } });
  });
  await page.route("**/api/tools/career-gap-remedies/1", async (route) => {
    deleted = true;
    await route.fulfill({ json: { ok: true } });
  });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

  await page.goto("/tools/gap");
  const storyInput = page.getByRole("textbox", { name: "真实经历与希望说明的问题" });
  await storyInput.fill("我自己的真实经历");
  await page.getByRole("button", { name: /裸辞休息/ }).click();
  await expect(storyInput).toHaveValue("我自己的真实经历");

  await page.getByRole("button", { name: "复制示例", exact: true }).first().click();
  await expect(page.getByRole("button", { name: "已复制 ✓", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "生成沟通方案 →", exact: true }).click();
  await expect(page.getByRole("alert", { name: "空窗方案生成状态", exact: true })).toHaveText(
    "合成生成失败。原始材料已保留，结果仍可能已经保存，请先核对历史记录再决定是否重试；不会自动再次生成。",
  );
  await expect(storyInput).toHaveValue("我自己的真实经历");

  await expect(page.getByText("历史空窗经历", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "删除", exact: true }).click();
  await expect(page.getByText("历史空窗经历", { exact: true })).toHaveCount(0);
  expect(generationAttempts).toBe(1);
});
