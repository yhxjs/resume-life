import { expect, test } from "@playwright/test";

const SUMMARY = {
  calls: 42, failed: 2, cancelled: 1,
  inputTokens: 128400, outputTokens: 36200, cachedTokens: 60800,
  usageReportedCalls: 40, cacheReportedCalls: 38,
};

const LOGS = {
  items: [
    {
      id: 2, createdAt: "2026-09-19T06:02:11.412Z", feature: "简历润色",
      entityType: "resume", entityId: 12, entityLabel: "前端开发工程师",
      model: "deepseek-chat", status: "ok", errorCode: "", attempts: 0, durationMs: 3120,
      inputTokens: 1240, outputTokens: 380, cachedTokens: null,
    },
    {
      id: 1, createdAt: "2026-09-19T06:00:00.000Z", feature: "黑话解码",
      entityType: "jargon_decoding", entityId: 9, entityLabel: "",
      model: "deepseek-chat", status: "cancelled", errorCode: "cancelled", attempts: 0, durationMs: 900,
      inputTokens: null, outputTokens: null, cachedTokens: null,
    },
  ],
  nextCursor: null,
};

async function mockUsage(page: import("@playwright/test").Page, summary = SUMMARY) {
  const seen: string[] = [];
  // 与 tests/e2e/synthetic-api.ts 一致：用 **/api/** 兜底拦截，未列出的请求返回空对象，
  // 避免任何组件请求落到真实 dev server。
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/api/settings/llm-usage") {
      seen.push(url.toString());
      await route.fulfill({ json: summary });
      return;
    }
    if (path === "/api/settings/llm-logs") {
      seen.push(url.toString());
      await route.fulfill({ json: LOGS });
      return;
    }
    if (path === "/api/settings") {
      await route.fulfill({
        json: {
          base_url: "", api_key: "", api_format: "openai_chat",
          model_parse: "", model_summary: "", model_question: "", model_evaluate: "",
        },
      });
      return;
    }
    await route.fulfill({ json: {} });
  });
  return seen;
}

test("看板渲染四张卡片与日志表", async ({ page }) => {
  await mockUsage(page);
  await page.goto("/settings/usage");

  await expect(page.locator("span").filter({ hasText: /^调用次数$/ })).toBeVisible();
  await expect(page.getByText("42", { exact: true })).toBeVisible();
  await expect(page.getByText("失败 3（中断 1）")).toBeVisible();
  await expect(page.getByText("128,400")).toBeVisible();
  await expect(page.getByText("47.4%")).toBeVisible();

  await expect(page.getByRole("cell", { name: "简历润色" })).toBeVisible();
  await expect(page.getByText("简历 #12 前端开发工程师")).toBeVisible();
  await expect(page.getByText("黑话解码 #9", { exact: true })).toBeVisible();
  await expect(page.getByText("已中断")).toBeVisible();
});

test("缓存未上报时显示 — 而不是 0%", async ({ page }) => {
  await mockUsage(page, { ...SUMMARY, cacheReportedCalls: 0, cachedTokens: 0 });
  await page.goto("/settings/usage");

  await expect(page.getByText("上游未返回缓存数据")).toBeVisible();
  await expect(page.getByText("0.0%")).toHaveCount(0);
});

test("切换时间档位重新请求，且「全部」不带时间参数", async ({ page }) => {
  const seen = await mockUsage(page);
  await page.goto("/settings/usage");
  await expect(page.getByRole("button", { name: "本月" })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => seen.some((url) => url.includes("from="))).toBe(true);

  seen.length = 0;
  await page.getByRole("button", { name: "全部" }).click();
  await expect.poll(() => seen.length).toBeGreaterThan(0);
  expect(seen.every((url) => !url.includes("from=") && !url.includes("to="))).toBe(true);
});

test("设置页入口卡片显示本月调用次数并可跳转到用量统计", async ({ page }) => {
  await mockUsage(page);
  await page.goto("/settings");
  const entry = page.getByRole("link", { name: /用量统计/ });
  await expect(entry).toContainText("本月调用 42 次");
  await entry.click();
  await expect(page).toHaveURL(/\/settings\/usage$/);
});
