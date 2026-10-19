import { expect, test } from "@playwright/test";
import { mockApi } from "./synthetic-api";

const empty = { overview: "", architecture: "", highlights: "", responsibilities: "", challenges: "", techStack: "", brief: "", achievements: [] as string[] };
const materialFingerprint = "0".repeat(64);

test("重新总结逐段采纳并保留校正表达，刷新后可查看历史", async ({ page }) => {
  await mockApi(page);
  let summary = { ...empty, overview: "我校正的项目定位", architecture: "旧架构" };
  let revisionId = 2;
  let lastPatch: { summary: typeof summary; proposal?: { acceptedKeys: string[] } } = { summary };
  const history = [{ id: 2, source: "manual", createdAt: "2026-09-28T10:00:00.000Z", summary, aiBaseline: { overview: "AI 旧定位", architecture: "旧架构" } }];

  await page.route("**/api/projects/1", async (route) => {
    if (route.request().method() === "PATCH") {
      lastPatch = route.request().postDataJSON();
      summary = lastPatch.summary;
      revisionId += 1;
      history.unshift({ id: revisionId, source: "ai", createdAt: "2026-09-29T10:00:00.000Z", summary, aiBaseline: { overview: "AI 旧定位", architecture: "新架构" } });
      await route.fulfill({ json: { ok: true, revisionId } });
      return;
    }
    await route.fulfill({ json: {
      id: 1, name: "合成项目", summary, summary_revision_id: revisionId,
      summary_updated_at: "2026-09-28T10:00:00.000Z", materials: [{ id: 1, title: "材料", source: "paste", filename: "", content: "内容", created_at: "2026-09-28" }],
    } });
  });
  await page.route("**/api/projects/1/summary-history*", async (route) => {
    await route.fulfill({ json: { items: history, nextCursor: null } });
  });
  await page.route("**/api/projects/1/summarize", async (route) => {
    const generated = { ...empty, overview: "AI 新项目定位", architecture: "新架构", techStack: "React" };
    const comparison = [
      { key: "overview", label: "项目概述", status: "conflict", previous: summary.overview, next: generated.overview },
      { key: "architecture", label: "架构设计", status: "changed", previous: summary.architecture, next: generated.architecture },
      { key: "techStack", label: "技术栈", status: "new", previous: "", next: generated.techStack },
    ];
    await route.fulfill({ headers: { "Content-Type": "text/event-stream" }, body: `event: done\ndata: ${JSON.stringify({ summary: generated, comparison, materialChanges: [{ id: 1, title: "材料", status: "changed" }], materialFingerprint, revisionId })}\n\n` });
  });

  await page.goto("/knowledge/1");
  await page.getByRole("button", { name: /重新生成 STAR 总结/ }).click();
  const review = page.getByRole("region", { name: "本次总结差异" });
  await expect(review).toBeVisible();
  await expect(review).toContainText("冲突");
  await expect(review).toContainText("变化");
  await expect(review).toContainText("新增");
  await expect(review).toContainText("材料");
  await expect(page.locator("#project-summary-overview")).toHaveValue("我校正的项目定位");
  await review.getByRole("group", { name: "架构设计" }).getByRole("button", { name: "采纳本段" }).click();
  await page.getByRole("button", { name: "确认采用入库", exact: true }).click();
  await expect.poll(() => lastPatch.proposal?.acceptedKeys).toEqual(["architecture"]);
  expect(lastPatch.summary).toMatchObject({ overview: "我校正的项目定位", architecture: "新架构" });

  await page.reload();
  await expect(page.locator("#project-summary-overview")).toHaveValue("我校正的项目定位");
  const historyPanel = page.getByRole("region", { name: "总结历史" });
  await expect(historyPanel).toContainText("2026");
  await historyPanel.getByText("手动保存", { exact: true }).click();
  await expect(historyPanel).toContainText("旧架构");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(historyPanel).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("首次草稿撤销采纳不会保存 AI 文案，手动改写仍可保存", async ({ page }) => {
  await mockApi(page);
  let saved: { summary: typeof empty; proposal: { acceptedKeys: string[] } } = { summary: empty, proposal: { acceptedKeys: [] } };
  let savedCount = 0;
  await page.route("**/api/projects/1", async (route) => {
    if (route.request().method() === "PATCH") {
      saved = route.request().postDataJSON();
      savedCount += 1;
      await route.fulfill({ json: { ok: true, revisionId: 1 } });
      return;
    }
    await route.fulfill({ json: {
      id: 1, name: "合成项目", summary: saved.summary, summary_revision_id: savedCount,
      summary_updated_at: savedCount ? "2026-09-29T10:00:00.000Z" : "", materials: [{ id: 1, title: "材料", source: "paste", filename: "", content: "内容", created_at: "2026-09-29" }],
    } });
  });
  await page.route("**/api/projects/1/summary-history*", async (route) => {
    await route.fulfill({ json: { items: [], nextCursor: null } });
  });
  await page.route("**/api/projects/1/summarize", async (route) => {
    const generated = { ...empty, overview: "AI 项目定位", architecture: "AI 架构", achievements: ["AI 成果"] };
    await route.fulfill({ headers: { "Content-Type": "text/event-stream" }, body: `event: done\ndata: ${JSON.stringify({
      summary: generated,
      comparison: [
        { key: "overview", label: "项目概述", status: "new", previous: "", next: generated.overview },
        { key: "architecture", label: "架构设计", status: "new", previous: "", next: generated.architecture },
        { key: "achievement:0", label: "项目描述与成果 1", status: "new", previous: "", next: generated.achievements[0] },
      ], materialChanges: [], materialFingerprint, revisionId: 0,
    })}\n\n` });
  });

  await page.goto("/knowledge/1");
  await page.getByRole("button", { name: /生成 AI STAR 总结/ }).click();
  await expect(page.locator("#project-summary-overview")).toHaveValue("AI 项目定位");
  await page.getByRole("region", { name: "本次总结差异" }).getByRole("group", { name: "项目概述" }).getByRole("button", { name: "撤销采纳" }).click();
  await expect(page.locator("#project-summary-overview")).toHaveValue("");
  await page.locator("#project-summary-architecture").fill("用户改写架构");
  const achievement = page.locator('textarea[placeholder^="成果 1"]');
  await achievement.fill("");
  await expect(achievement).toBeVisible();
  await achievement.fill("用户成果");
  await page.getByRole("button", { name: "确认采用入库", exact: true }).click();
  await expect.poll(() => saved.summary).toMatchObject({ overview: "", architecture: "用户改写架构", achievements: ["用户成果"] });
  expect(saved.proposal.acceptedKeys).toEqual([]);
});

test("编辑一条成果不会取消其他成果的采纳", async ({ page }) => {
  await mockApi(page);
  let saved: { summary: typeof empty; proposal: { acceptedKeys: string[] } } = { summary: empty, proposal: { acceptedKeys: [] } };
  await page.route("**/api/projects/1", async (route) => {
    if (route.request().method() === "PATCH") {
      saved = route.request().postDataJSON();
      await route.fulfill({ json: { ok: true, revisionId: 1 } });
      return;
    }
    await route.fulfill({ json: {
      id: 1, name: "合成项目", summary: empty, summary_revision_id: 0,
      summary_updated_at: "", materials: [{ id: 1, title: "材料", source: "paste", filename: "", content: "内容", created_at: "2026-09-29" }],
    } });
  });
  await page.route("**/api/projects/1/summary-history*", async (route) => {
    await route.fulfill({ json: { items: [], nextCursor: null } });
  });
  await page.route("**/api/projects/1/summarize", async (route) => {
    const generated = { ...empty, achievements: ["AI 成果一", "AI 成果二"] };
    await route.fulfill({ headers: { "Content-Type": "text/event-stream" }, body: `event: done\ndata: ${JSON.stringify({
      summary: generated,
      comparison: generated.achievements.map((next, index) => ({ key: `achievement:${index}`, label: `项目描述与成果 ${index + 1}`, status: "new", previous: "", next })),
      materialChanges: [], materialFingerprint, revisionId: 0,
    })}\n\n` });
  });

  await page.goto("/knowledge/1");
  await page.getByRole("button", { name: /生成 AI STAR 总结/ }).click();
  await page.locator('textarea[placeholder^="成果 1"]').fill("用户改写成果一");
  await expect(page.locator('textarea[placeholder^="成果 2"]')).toHaveValue("AI 成果二");
  await page.getByRole("button", { name: "确认采用入库", exact: true }).click();
  await expect.poll(() => saved.summary.achievements).toEqual(["用户改写成果一", "AI 成果二"]);
  expect(saved.proposal.acceptedKeys).toEqual(["achievement:1"]);
});
