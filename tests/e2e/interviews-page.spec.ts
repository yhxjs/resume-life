import { expect, test } from "@playwright/test";
import { gate } from "./synthetic-api";

const singleInterview = (id: number, title: string) => ({
  id,
  jd: `${title} JD`,
  rounds: 8,
  style: "gentle",
  status: "ongoing",
  created_at: `2026-09-${String(id).padStart(2, "0")}T00:00:00Z`,
  resume_title: title,
  resume_version_id: 101,
  resume_version: 1,
  resume_version_name: "测试发布版本",
  answered: 2,
});

const interviewSeries = (id: number, title: string) => ({
  id,
  jd: `${title} JD`,
  status: "ongoing",
  created_at: `2026-09-${String(id).padStart(2, "0")}T00:00:00Z`,
  resume_title: title,
  resume_version_id: 101,
  resume_version: 1,
  resume_version_name: "测试发布版本",
  rounds_done: 1,
  rounds_total: 3,
  final_overall: null,
});

const listPage = <T,>(items: T[]) => ({ items, nextCursor: null, total: items.length });

test("面试页使用查询参数创建进阶面试并导航到首轮", async ({ page }) => {
  let createBody: Record<string, unknown> | null = null;
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === "/api/resumes") {
      await route.fulfill({ json: [
        { id: 1, title: "默认简历", versions: [{ id: 101, version: 1, name: "测试发布版本" }] },
        { id: 2, title: "查询简历", versions: [{ id: 201, version: 1, name: "查询发布版本" }] },
      ] });
      return;
    }
    if (path === "/api/interviews" && route.request().method() === "POST") {
      createBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        headers: { "Content-Type": "text/event-stream" },
        body: [
          `event: delta\ndata: ${JSON.stringify("合成首题")}\n\n`,
          `event: done\ndata: ${JSON.stringify({ id: 99, series_id: 9 })}\n\n`,
        ].join(""),
      });
      return;
    }
    if (path === "/api/interviews" && route.request().method() === "GET") {
      await route.fulfill({ json: listPage([singleInterview(1, "单轮记录")]) });
      return;
    }
    if (path === "/api/interviews/series") {
      await route.fulfill({ json: listPage([interviewSeries(2, "进阶记录")]) });
      return;
    }
    await route.fulfill({ json: {} });
  });

  await page.goto(`/interviews?jd=${encodeURIComponent("查询岗位要求")}&resumeId=2`);
  await expect(page.getByLabel("关联简历")).toHaveValue("2");
  await expect(page.getByRole("combobox", { name: "已发布版本", exact: true })).toHaveValue("201");
  await expect(page.getByLabel("目标岗位要求（JD / 职位描述）")).toHaveValue("查询岗位要求");
  await expect(page.getByRole("link", { name: "单轮记录 v1 · 测试发布版本", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "进阶记录 v1 · 测试发布版本", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "进阶三轮连打", exact: true }).click();
  await page.getByRole("button", { name: "开启进阶三轮连打", exact: true }).click();

  await expect.poll(() => createBody).toMatchObject({
    resume_id: 2,
    resume_version_id: 201,
    jd: "查询岗位要求",
    rounds: 8,
    style: "gentle",
    mode: "series",
  });
  await page.waitForURL("**/interviews/99");
});

test("面试历史分别翻页，不截断第 51 条且累计场次不受首页条数限制", async ({ page }) => {
  const singles = Array.from({ length: 51 }, (_, index) => ({
    ...singleInterview(51 - index, `单轮 ${51 - index}`),
    created_at: "2026-09-24T00:00:00Z",
  }));
  const series = Array.from({ length: 51 }, (_, index) => ({
    ...interviewSeries(51 - index, `进阶 ${51 - index}`),
    created_at: "2026-09-24T00:00:00Z",
  }));

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/resumes") {
      await route.fulfill({ json: [{ id: 1, title: "默认简历", versions: [{ id: 101, version: 1, name: "测试发布版本" }] }] });
      return;
    }
    if (url.pathname === "/api/interviews" || url.pathname === "/api/interviews/series") {
      const records = url.pathname.endsWith("/series") ? series : singles;
      const cursor = Number(url.searchParams.get("cursor") ?? Infinity);
      const rows = records.filter((record) => record.id < cursor).slice(0, 51);
      const items = rows.slice(0, 50);
      await route.fulfill({ json: {
        items,
        nextCursor: rows.length > 50 ? String(items.at(-1)!.id) : null,
        total: records.length,
      } });
      return;
    }
    await route.fulfill({ json: {} });
  });

  await page.goto("/interviews");
  await expect(page.getByText("已累计实战：")).toContainText("102");
  await expect(page.getByRole("link", { name: "单轮 1 v1 · 测试发布版本", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "进阶 1 v1 · 测试发布版本", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "加载更多单轮面试" }).click();
  await expect(page.getByRole("link", { name: "单轮 1 v1 · 测试发布版本", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "加载更多进阶面试" }).click();
  await expect(page.getByRole("link", { name: "进阶 1 v1 · 测试发布版本", exact: true })).toBeVisible();
  await expect(page.getByText("已累计实战：")).toContainText("102");
});

test("面试页删除单场与系列，并拒绝过期搜索结果覆盖新查询", async ({ page }) => {
  let singles = [singleInterview(3, "保留记录"), singleInterview(2, "单轮待删")];
  let series = [interviewSeries(1, "系列待删")];
  const oldQueryGate = gate();
  let oldRequests = 0;

  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();
    if (path === "/api/resumes") {
      await route.fulfill({ json: [{ id: 1, title: "默认简历", versions: [{ id: 101, version: 1, name: "测试发布版本" }] }] });
      return;
    }
    if (/^\/api\/interviews\/series\/\d+$/u.test(path) && method === "DELETE") {
      series = series.filter((item) => item.id !== Number(path.split("/").at(-1)));
      await route.fulfill({ json: { ok: true } });
      return;
    }
    if (/^\/api\/interviews\/\d+$/u.test(path) && method === "DELETE") {
      singles = singles.filter((item) => item.id !== Number(path.split("/").at(-1)));
      await route.fulfill({ json: { ok: true } });
      return;
    }
    if (path === "/api/interviews" || path === "/api/interviews/series") {
      const query = url.searchParams.get("q") ?? "";
      if (query === "旧查询") {
        oldRequests += 1;
        await oldQueryGate.promise;
        try {
          await route.fulfill({
            json: listPage(path.endsWith("/series") ? [] : [singleInterview(8, "过期结果")]),
          });
        } catch {
          // 浏览器取消旧请求后，路由无法再响应是预期行为。
        }
        return;
      }
      if (query === "新查询") {
        await route.fulfill({
          json: listPage(path.endsWith("/series") ? [] : [singleInterview(9, "最新结果")]),
        });
        return;
      }
      await route.fulfill({ json: path.endsWith("/series") ? listPage(series) : listPage(singles) });
      return;
    }
    await route.fulfill({ json: {} });
  });

  await page.goto("/interviews");
  const singleCard = page.locator("div.group").filter({
    has: page.getByRole("link", { name: "单轮待删 v1 · 测试发布版本", exact: true }),
  });
  await singleCard.getByRole("button", { name: "删除", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "删除", exact: true }).click();
  await expect(page.getByRole("link", { name: "单轮待删 v1 · 测试发布版本", exact: true })).toHaveCount(0);

  const seriesCard = page.locator("div.group").filter({
    has: page.getByRole("link", { name: "系列待删 v1 · 测试发布版本", exact: true }),
  });
  await seriesCard.getByRole("button", { name: "删除", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "删除", exact: true }).click();
  await expect(page.getByRole("link", { name: "系列待删 v1 · 测试发布版本", exact: true })).toHaveCount(0);

  const search = page.getByLabel("搜索面试记录");
  await search.fill("旧查询");
  await expect.poll(() => oldRequests).toBe(2);
  await search.fill("新查询");
  await expect(page.getByRole("link", { name: "最新结果 v1 · 测试发布版本", exact: true })).toBeVisible();
  oldQueryGate.release();
  await expect(page.getByRole("link", { name: "过期结果 v1 · 测试发布版本", exact: true })).toHaveCount(0);
});

test("开始面试可取消：中断首题请求并恢复可重试的表单", async ({ page }) => {
  const held = gate();
  const aborted: string[] = [];
  page.on("requestfailed", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/interviews") {
      aborted.push(request.failure()?.errorText ?? "");
    }
  });

  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/resumes") {
      await route.fulfill({ json: [{ id: 1, title: "默认简历", versions: [{ id: 101, version: 1, name: "测试发布版本" }] }] });
      return;
    }
    if (path === "/api/interviews" && route.request().method() === "POST") {
      await held.promise;
      try {
        await route.fulfill({
          headers: { "Content-Type": "text/event-stream" },
          body: `event: done\ndata: ${JSON.stringify({ id: 99 })}\n\n`,
        });
      } catch {
        // 取消后浏览器已断开该请求，路由无法再响应是预期行为。
      }
      return;
    }
    if (path === "/api/interviews" || path === "/api/interviews/series") {
      await route.fulfill({ json: listPage([]) });
      return;
    }
    await route.fulfill({ json: {} });
  });

  await page.goto(`/interviews?jd=${encodeURIComponent("合成岗位要求")}`);
  await page.getByRole("button", { name: "立即开启模拟实战", exact: true }).click();

  const cancel = page.getByRole("button", { name: "取消", exact: true });
  await expect(cancel).toBeVisible();
  await cancel.click();

  await expect.poll(() => aborted.length).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "立即开启模拟实战", exact: true })).toBeEnabled();
  expect(new URL(page.url()).pathname).toBe("/interviews");
  held.release();
});
