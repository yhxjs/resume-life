import { expect, test } from "@playwright/test";
import { gate, mockApi } from "./synthetic-api";

for (const leave of [true, false]) {
  test(`intro generation ${leave ? "is aborted when leaving" : "navigates when still mounted"}`, async ({ page }) => {
    await mockApi(page);
    const started = gate();
    const complete = gate();
    await page.addInitScript(() => {
      const original = window.fetch;
      window.fetch = (input, init) => {
        if (input === "/api/intros" && init?.method === "POST") {
          const track = () => document.documentElement.dataset.introAborted = String(init?.signal?.aborted ?? false);
          track();
          init?.signal?.addEventListener("abort", track);
        }
        return original(input, init);
      };
    });
    await page.route("**/api/intros*", async (route) => {
      if (route.request().method() === "GET") return route.fulfill({ json: { items: [], nextCursor: null } });
      started.release();
      await complete.promise;
      await route.fulfill({ contentType: "text/event-stream", body: 'event: done\ndata: {"id":9003}\n\n' });
    });
    await page.route("**/api/intros/9003", (route) => route.fulfill({ json: {
      id: 9003, jd: "测试岗位", resume_id: 9001, resume_version_id: 90001, resume_version: 1, resume_version_name: "测试发布版本", resume_title: "合成简历", created_at: "2026-09-16T00:00:00Z", versions: [],
    } }));
    await page.goto("/intros");
    await expect(page.getByRole("combobox", { name: "已发布版本", exact: true })).toHaveValue("90001");
    await page.getByRole("textbox", { name: /目标岗位要求/ }).fill("测试岗位");
    await page.getByRole("button", { name: "立即生成两版自我介绍" }).click();
    await started.promise;
    try {
      if (leave) {
        await page.getByRole("link", { name: "工具箱", exact: true }).click();
        await expect(page).toHaveURL(/\/tools$/);
        await expect(page.locator("html")).toHaveAttribute("data-intro-aborted", "true");
      }
    } finally { complete.release(); }
    await expect(page).toHaveURL(leave ? /\/tools$/ : /\/intros\/9003$/);
  });
}

function syntheticIntro() {
  return {
    id: 9003, jd: "测试岗位", resume_id: 9001, resume_title: "合成简历", created_at: "2026-10-11T00:00:00Z",
    versions: [
      { kind: "30s", revision: "a".repeat(64), sentences: [
        { text: "字".repeat(40), comment: "合成点评" }, { text: "字".repeat(40), comment: "合成点评" },
      ] },
      { kind: "2min", revision: "b".repeat(64), sentences: [{ text: "字".repeat(240), comment: "合成点评" }] },
    ],
  };
}

test("intro editor preserves oversized pasted text and saves all 800 characters at the boundary", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/intros/9003", (route) => route.fulfill({ json: syntheticIntro() }));
  const writes: { sentences: { text: string; comment: string }[] }[] = [];
  await page.route("**/api/intros/9003/versions/30s", async (route) => {
    const body = route.request().postDataJSON() as (typeof writes)[number];
    writes.push(body);
    await route.fulfill({ json: { kind: "30s", revision: "c".repeat(64), sentences: body.sentences } });
  });
  await page.goto("/intros/9003");
  await page.getByRole("button", { name: "微调", exact: true }).first().click();
  const editor = page.getByRole("textbox", { name: "30 秒版第 1 句", exact: true });
  const tooLong = "字".repeat(801);
  await editor.fill(tooLong);
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.getByText("每句最多 800 字", { exact: true })).toBeVisible();
  await expect(editor).toHaveValue(tooLong);
  expect(writes).toHaveLength(0);
  const boundary = "字".repeat(795) + "尾部不能丢";
  await editor.fill(boundary);
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect(writes[0]?.sentences[0]?.text).toBe(boundary);
  await expect(page.getByText(boundary, { exact: true })).toBeVisible();
});

for (const status of [200, 409]) {
  test(`intro ${status} save response leaves a newer other-version draft editable`, async ({ page }) => {
    await mockApi(page);
    await page.route("**/api/intros/9003", (route) => route.fulfill({ json: syntheticIntro() }));
    const started = gate();
    const complete = gate();
    await page.route("**/api/intros/9003/versions/30s", async (route) => {
      const body = route.request().postDataJSON() as { sentences: { text: string; comment: string }[] };
      started.release();
      await complete.promise;
      await route.fulfill({ status, json: status === 200
        ? { kind: "30s", revision: "c".repeat(64), sentences: body.sentences }
        : { error: "旧版本保存冲突" } });
    });
    await page.goto("/intros/9003");
    await page.getByRole("button", { name: "微调", exact: true }).first().click();
    await page.getByRole("textbox", { name: "30 秒版第 1 句", exact: true }).fill("短版待保存正文");
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await started.promise;
    try {
      await page.getByRole("button", { name: "2 分钟版", exact: true }).click();
      await page.getByRole("button", { name: "微调", exact: true }).click();
      await page.getByRole("textbox", { name: "2 分钟版第 1 句", exact: true }).fill("长版新草稿保持完整");
    } finally { complete.release(); }
    await expect(page.getByRole("button", { name: "保存修改", exact: true })).toBeEnabled();
    await expect(page.getByRole("textbox", { name: "2 分钟版第 1 句", exact: true })).toHaveValue("长版新草稿保持完整");
    await expect(page.getByText("旧版本保存冲突", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "获取最新版本（保留草稿）", exact: true })).toHaveCount(0);
  });
}

test("intro estimated reading time follows word count and sentence count across versions", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/intros/9003", (route) => route.fulfill({ json: syntheticIntro() }));
  await page.goto("/intros/9003");
  const estimate = page.locator("div").filter({ has: page.getByRole("heading", { name: "预估朗读时长", exact: true }) }).last();
  await expect(estimate).toContainText("约 20 秒");
  await expect(estimate).toContainText("平均约 10 秒/句");
  await expect(page.getByText("00:28.4", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "2 分钟版", exact: true }).click();
  await expect(estimate).toContainText("约 1 分钟");
  await expect(estimate).toContainText("平均约 60 秒/句");
  await expect(page.getByText("01:52.0", { exact: true })).toHaveCount(0);
});
