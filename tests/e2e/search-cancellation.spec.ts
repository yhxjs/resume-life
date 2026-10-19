import { expect, test } from "@playwright/test";
import { gate, mockApi } from "./synthetic-api";

test("clearing command search then pressing Enter cannot open a stale result", async ({ page }) => {
  await mockApi(page);
  const pending = gate();
  await page.route("**/api/search**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("q") === "新查询") await pending.promise;
    await route.fulfill({
      json: { resumes: [{ id: 9001, title: "旧结果", updated_at: "2026-09-16T00:00:00Z" }], projects: [], questions: [], interviews: [] },
    }).catch(() => {});
  });
  await page.goto("/tools");
  await page.getByRole("button", { name: "全局搜索", exact: true }).click();
  const input = page.getByRole("combobox", { name: "搜索关键词" });
  await input.fill("旧查询");
  await expect(page.getByRole("option", { name: /^旧结果/ })).toBeVisible();
  await input.fill("新查询");
  await input.press("Enter");
  await expect(input).toBeVisible();
  await expect(page).toHaveURL(/\/tools$/);
  await input.fill("");
  await input.press("Enter");
  await expect(page).toHaveURL(/\/tools$/);
  await expect(page.getByRole("option", { name: /^旧结果/ })).toHaveCount(0);
  pending.release();
});

test("command palette aborts a stale request and keeps only the latest result", async ({ page }) => {
  await mockApi(page);
  const staleRequest = gate();
  let staleStarted = false;
  let staleAborted = false;

  page.on("requestfailed", (request) => {
    const query = new URL(request.url()).searchParams.get("q");
    if (query === "旧查询") staleAborted = true;
  });
  await page.route("**/api/search**", async (route) => {
    const query = new URL(route.request().url()).searchParams.get("q");
    if (query === "旧查询") {
      staleStarted = true;
      await staleRequest.promise;
      try {
        await route.fulfill({
          json: { resumes: [{ id: 9001, title: "旧结果", updated_at: "2026-09-16T00:00:00Z" }], projects: [], questions: [], interviews: [] },
        });
      } catch {
        // 浏览器已取消旧请求时，路由无法再响应是预期行为。
      }
      return;
    }
    await route.fulfill({
      json: { resumes: [{ id: 9002, title: "新结果", updated_at: "2026-09-16T00:00:00Z" }], projects: [], questions: [], interviews: [] },
    });
  });

  await page.goto("/tools");
  await page.getByRole("button", { name: "全局搜索", exact: true }).click();
  const input = page.getByRole("combobox", { name: "搜索关键词", exact: true });
  await input.fill("旧查询");
  await expect.poll(() => staleStarted).toBe(true);
  await input.fill("新查询");

  await expect(page.getByRole("option", { name: /^新结果/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /^旧结果/ })).toHaveCount(0);
  await expect.poll(() => staleAborted).toBe(true);
  await expect(page.getByText(/无法连接服务器|HTTP/)).toHaveCount(0);

  staleRequest.release();
});

test("command palette displays matched snippets and highlights query keywords", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/search**", async (route) => {
    await route.fulfill({
      json: {
        resumes: [
          {
            id: 8888,
            title: "高级前端开发专家",
            updated_at: "2026-09-20T00:00:00Z",
            snippets: [
              { source: "工作经历", text: "…深度使用 React 进行大型项目重构…" },
              { source: "项目经历", text: "…研发基于 React 的组件库与状态方案…" },
            ],
          },
        ],
        projects: [],
        questions: [],
        interviews: [],
      },
    });
  });

  await page.goto("/tools");
  await page.getByRole("button", { name: "全局搜索", exact: true }).click();
  const input = page.getByRole("combobox", { name: "搜索关键词", exact: true });
  await input.fill("React");

  const option = page.getByRole("option", { name: /高级前端开发专家/ });
  await expect(option).toBeVisible();

  // 验证多个片段被渲染
  await expect(option).toContainText("深度使用");
  await expect(option).toContainText("研发基于");

  // 验证 mark 标签高亮了搜索词
  const marks = option.locator("mark");
  await expect(marks).toHaveCount(2);
  await expect(marks.first()).toHaveText("React");
});

test("command palette does not trigger search while typing Chinese in IME composition until confirmed", async ({ page }) => {
  await mockApi(page);
  const requestedQueries: string[] = [];

  await page.route("**/api/search**", async (route) => {
    const q = new URL(route.request().url()).searchParams.get("q") ?? "";
    requestedQueries.push(q);
    await route.fulfill({
      json: {
        resumes: q === "简历" ? [{ id: 9999, title: "中文确认后的简历", updated_at: "2026-09-20T00:00:00Z" }] : [],
        projects: [],
        questions: [],
        interviews: [],
      },
    });
  });

  await page.goto("/tools");
  await page.getByRole("button", { name: "全局搜索", exact: true }).click();
  const input = page.getByRole("combobox", { name: "搜索关键词", exact: true });

  // 模拟中文输入法过程：触发 compositionstart -> 输入拼音 jianli -> 此时不应触发搜索
  await input.evaluate((el) => {
    el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  });
  // 改变值但不派发 compositionend（模拟拼音仍在候选框）
  await input.fill("jianli");

  // 等待超过 debounce/throttle 延迟（400ms）
  await page.waitForTimeout(450);

  // 此时不应该有包含 "jianli" 的搜索请求
  expect(requestedQueries).not.toContain("jianli");

  // 用户按下数字键/空格键确认候选词为 "简历" 并结束 composition
  await input.evaluate((el) => {
    const inputEl = el as HTMLInputElement;
    inputEl.value = "简历";
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    inputEl.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "简历" }));
  });

  // 确认后应该触发对 "简历" 的搜索
  await expect(page.getByRole("option", { name: /中文确认后的简历/ })).toBeVisible();
  expect(requestedQueries).toContain("简历");
});

test("command palette debounces typing and does not send requests for intermediate strokes", async ({ page }) => {
  await mockApi(page);
  const requests: string[] = [];
  await page.route("**/api/search**", async (route) => {
    requests.push(new URL(route.request().url()).searchParams.get("q") ?? "");
    await route.fulfill({
      json: {
        resumes: [{ id: 1001, title: "搜索防抖测试", updated_at: "2026-09-20T00:00:00Z" }],
        projects: [],
        questions: [],
        interviews: [],
      },
    });
  });

  await page.goto("/tools");
  await page.getByRole("button", { name: "全局搜索", exact: true }).click();
  const input = page.getByRole("combobox", { name: "搜索关键词", exact: true });

  // 模拟快速连续打字（每个字符间隔 100ms < 400ms）
  await input.pressSequentially("abcd", { delay: 100 });

  // 在打字刚结束的瞬间（小于 400ms），尚未发起请求
  expect(requests).toHaveLength(0);

  // 等待防抖计时器到达
  await expect(page.getByRole("option", { name: /搜索防抖测试/ })).toBeVisible();

  // 验证只发出了最终的 "abcd" 请求，中间没有产生 a, ab, abc 请求
  expect(requests).toEqual(["abcd"]);
});
