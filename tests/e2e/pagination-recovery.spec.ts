import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import type { Application } from "../../src/lib/applications-types";
import { gate, mockApi } from "./synthetic-api";

function application(id: number, company: string): Application {
  return {
    id,
    company,
    role: "测试工程师",
    flow_status: "active", batch_name: "", hiring_stage: null, stage_changed_at: "", terminal_stage: null, terminal_reason: "", terminal_at: "",
    salary_range: "",
    stage: "interested",
    resume_id: null,
    jd: "",
    interview_id: null,
    interview_series_id: null,
    next_interview_at: "",
    notes: "",
    created_at: "2026-09-16T00:00:00.000Z",
    updated_at: `2026-09-16T00:00:${String(id).padStart(2, "0")}.000Z`,
  };
}

function applications(count: number): Application[] {
  return Array.from({ length: count }, (_, index) => application(index + 1, `合成公司 ${index + 1}`));
}

test("投递分页追加、故障重试与写后列表和统计刷新相互独立", async ({ page }) => {
  const api = await mockApi(page, applications(52));
  await page.goto("/applications");

  await expect(page.getByTitle("编辑卡片", { exact: true })).toHaveCount(50);
  await expect.poll(() => api.applicationListRequests.length).toBe(1);
  await expect.poll(() => api.applicationStatsRequests).toBe(1);

  api.failNextApplicationListRequests = 1;
  await page.getByRole("button", { name: "加载更多", exact: true }).click();
  await expect(page.getByText("合成公司 52", { exact: true })).toBeVisible();
  await expect(page.getByTitle("编辑卡片", { exact: true })).toHaveCount(50);
  await expect(page.getByText(/合成列表失败/)).toBeVisible();
  await expect(page.getByRole("button", { name: "重试加载更多", exact: true })).toBeVisible();
  expect(api.applicationStatsRequests).toBe(1);

  await page.getByRole("button", { name: "重试加载更多", exact: true }).click();
  await expect(page.getByTitle("编辑卡片", { exact: true })).toHaveCount(52);
  await expect.poll(() => api.applicationListRequests.length).toBe(3);
  expect(api.applicationStatsRequests).toBe(1);

  const dialogs: string[] = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  api.failNextApplicationStatsRequests = 1;
  const firstCard = page.locator('[draggable="true"]').filter({ hasText: "合成公司 52" });
  await firstCard.locator("select").selectOption("applied");

  await expect.poll(() => api.applicationWrites.length).toBe(1);
  await expect.poll(() => api.applicationListRequests.length).toBe(4);
  await expect.poll(() => api.applicationStatsRequests).toBe(2);
  await expect(page.getByTitle("编辑卡片", { exact: true })).toHaveCount(50);
  await expect(page.getByText(/合成统计失败/)).toBeVisible();
  expect(dialogs).toEqual([]);

  await page.getByRole("button", { name: "重试统计", exact: true }).click();
  await expect.poll(() => api.applicationStatsRequests).toBe(3);
  await expect(page.getByText(/合成统计失败/)).toBeHidden();
  await expect(page.getByRole("button", { name: /已投递/ }).getByText("1", { exact: true })).toBeVisible();

  api.failNextApplicationListRequests = 1;
  await page.getByRole("button", { name: /已投递/ }).click();
  await expect.poll(() => api.applicationListRequests.length).toBe(5);
  expect(api.applicationStatsRequests).toBe(3);
  await expect(page.getByText(/合成列表失败/)).toBeVisible();
  await expect(page.getByText("合成公司 52", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "重试加载", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "重试加载", exact: true }).click();
  await expect.poll(() => api.applicationListRequests.length).toBe(6);
  expect(api.applicationStatsRequests).toBe(3);
  await expect(page.getByTitle("编辑卡片", { exact: true })).toHaveCount(1);
});

test("延迟写完成后使用当前阶段筛选刷新投递列表", async ({ page }) => {
  const rows = applications(2);
  rows[0]!.stage = "applied";
  const api = await mockApi(page, rows);
  const patchGate = gate();
  api.beforePatch = async () => patchGate.promise;
  await page.goto("/applications");

  await expect(page.getByTitle("编辑卡片", { exact: true })).toHaveCount(2);
  const changingCard = page.locator('[draggable="true"]').filter({ hasText: "合成公司 2" });
  await changingCard.locator("select").selectOption("interviewing");
  await expect.poll(() => api.applicationWrites.length).toBe(1);

  await page.getByRole("button", { name: /已投递/ }).click();
  await expect.poll(() => api.applicationListRequests.length).toBe(2);
  await expect(page.getByText("合成公司 1", { exact: true })).toBeVisible();
  await expect(page.getByText("合成公司 2", { exact: true })).toBeHidden();

  patchGate.release();
  await expect.poll(() => api.applicationListRequests.length).toBe(3);
  await expect.poll(() => api.applicationStatsRequests).toBe(2);
  expect(api.applicationListRequests.slice(1).every((requestUrl) =>
    new URL(requestUrl).searchParams.get("stage") === "applied"
  )).toBe(true);
  await expect(page.getByText("合成公司 1", { exact: true })).toBeVisible();
  await expect(page.getByText("合成公司 2", { exact: true })).toBeHidden();
  await expect(page.getByTitle("编辑卡片", { exact: true })).toHaveCount(1);
});

type PagedListState = { requests: number; failInitial: boolean; failMore: boolean; failFiltered: boolean };

function newPagedListState(): PagedListState {
  return { requests: 0, failInitial: true, failMore: true, failFiltered: true };
}

/**
 * 四个列表页共用的分页桩：首批失败一次、续页失败一次、筛选替换失败一次，之后均成功。
 * `matched` 命中即视为「筛选后的新首页」——用于验证筛选失败不会丢弃已有列表。
 */
async function fulfillPagedList(
  route: Route,
  state: PagedListState,
  plan: { matched: (url: URL) => boolean; first: unknown[]; second: unknown[]; filtered: unknown[] },
) {
  const url = new URL(route.request().url());
  state.requests += 1;
  if (plan.matched(url)) {
    if (state.failFiltered) {
      state.failFiltered = false;
      await route.fulfill({ status: 503, json: { error: "合成筛选失败" } });
      return;
    }
    await route.fulfill({ json: { items: plan.filtered, nextCursor: null } });
    return;
  }
  const cursor = url.searchParams.get("cursor");
  if (!cursor && state.failInitial) {
    state.failInitial = false;
    await route.fulfill({ status: 503, json: { error: "合成首批失败" } });
    return;
  }
  if (cursor && state.failMore) {
    state.failMore = false;
    await route.fulfill({ status: 503, json: { error: "合成续页失败" } });
    return;
  }
  await route.fulfill({
    json: cursor
      ? { items: plan.second, nextCursor: null }
      : { items: plan.first, nextCursor: "2" },
  });
}

function bankQuestion(id: number, question: string) {
  return { id, direction: "前端", kind: "tech", question, created_at: "2026-09-16" };
}

function notebookEntry(id: number, question: string) {
  return {
    id,
    category_id: null,
    category_name: null,
    source: "drill",
    source_label: "合成标签",
    question,
    answer: "",
    comment: "",
    reference: "",
    scores: null,
    created_at: "2026-09-16T00:00:00.000Z",
    updated_at: "2026-09-16T00:00:00.000Z",
  };
}

function drillRecord(id: number, direction: string) {
  return { id, source: "bank", direction, jd: "", focus: "", created_at: "2026-09-16", project_name: null, total: 3, answered: 1 };
}

/** 四个列表页的差异部分：列表接口桩、条目定位、筛选控件；其余断言共用一套。 */
type PagedPageCase = {
  path: string;
  /** 只拦该页的分页列表接口，同前缀的其它接口（如 /api/applications/stats）仍走 mockApi */
  install: (page: Page, state: PagedListState) => Promise<void>;
  firstItem: string;
  secondItem: string;
  moreItem: string;
  filteredItem: string;
  locate: (page: Page, text: string) => Locator;
  /** 条目数定位器：首批为 2，续页后为 3，筛选替换后为 1 */
  countItems: (page: Page) => Locator;
  /** 触发一次筛选变更；四个页面的筛选控件不同 */
  changeFilter: (page: Page) => Promise<void>;
};

const PAGED_PAGES: PagedPageCase[] = [
  {
    path: "/applications",
    install: async (page, state) => {
      await page.route(/\/api\/applications(\?|$)/, (route) =>
        fulfillPagedList(route, state, {
          matched: (url) => url.searchParams.get("q") === "筛选",
          first: [application(3, "合成公司 3"), application(2, "合成公司 2")],
          second: [application(1, "合成公司 1")],
          filtered: [application(4, "筛选后公司")],
        })
      );
    },
    firstItem: "合成公司 3",
    secondItem: "合成公司 2",
    moreItem: "合成公司 1",
    filteredItem: "筛选后公司",
    locate: (page, text) => page.getByText(text, { exact: true }),
    countItems: (page) => page.locator('[draggable="true"]'),
    changeFilter: (page) => page.getByPlaceholder("搜索公司、岗位或笔记...").fill("筛选"),
  },
  {
    path: "/bank",
    install: async (page, state) => {
      await page.route("**/api/bank**", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === "/api/bank/directions") {
          await route.fulfill({ json: [] });
          return;
        }
        await fulfillPagedList(route, state, {
          matched: (requestUrl) => requestUrl.searchParams.get("kind") === "behavior",
          first: [bankQuestion(3, "合成题目三"), bankQuestion(2, "合成题目二")],
          second: [bankQuestion(1, "合成题目一")],
          filtered: [{ id: 4, direction: "通用", kind: "behavior", question: "筛选后题目", created_at: "2026-09-16" }],
        });
      });
    },
    firstItem: "合成题目三",
    secondItem: "合成题目二",
    moreItem: "合成题目一",
    filteredItem: "筛选后题目",
    locate: (page, text) => page.getByText(text, { exact: true }),
    countItems: (page) => page.locator("ul li"),
    changeFilter: async (page) => {
      await page.getByLabel("按题型过滤").selectOption("behavior");
    },
  },
  {
    path: "/notebook",
    install: async (page, state) => {
      await page.route("**/api/notebook**", async (route) => {
        const url = new URL(route.request().url());
        if (url.pathname === "/api/notebook/categories") {
          await route.fulfill({ json: [] });
          return;
        }
        await fulfillPagedList(route, state, {
          matched: (requestUrl) => requestUrl.searchParams.get("q") === "筛选",
          first: [notebookEntry(3, "合成错题三"), notebookEntry(2, "合成错题二")],
          second: [notebookEntry(1, "合成错题一")],
          filtered: [notebookEntry(4, "筛选后错题")],
        });
      });
    },
    firstItem: "合成错题三",
    secondItem: "合成错题二",
    moreItem: "合成错题一",
    filteredItem: "筛选后错题",
    locate: (page, text) => page.getByText(text, { exact: true }),
    countItems: (page) => page.getByRole("heading", { level: 3 }),
    changeFilter: (page) => page.getByLabel("搜索错题").fill("筛选"),
  },
  {
    path: "/drills",
    install: async (page, state) => {
      await page.route("**/api/drills**", (route) =>
        fulfillPagedList(route, state, {
          matched: (url) => url.searchParams.get("q") === "筛选",
          first: [drillRecord(3, "合成练习三"), drillRecord(2, "合成练习二")],
          second: [drillRecord(1, "合成练习一")],
          filtered: [drillRecord(4, "筛选后练习")],
        })
      );
    },
    firstItem: "合成练习三",
    secondItem: "合成练习二",
    moreItem: "合成练习一",
    filteredItem: "筛选后练习",
    locate: (page, text) => page.getByRole("link", { name: text, exact: true }),
    countItems: (page) => page.getByRole("button", { name: "删除", exact: true }),
    changeFilter: (page) => page.getByLabel("搜索练习记录").fill("筛选"),
  },
];

// 同一套分页竞态场景逐页跑：首批失败、续页失败、筛选替换失败，三处都必须可重试且不丢弃已有条目
for (const pageCase of PAGED_PAGES) {
  test(`${pageCase.path} 首批、续页与筛选替换失败后均可重试且不丢弃已有条目`, async ({ page }) => {
    await mockApi(page);
    const state = newPagedListState();
    await pageCase.install(page, state);

    await page.goto(pageCase.path);
    await expect(page.getByText(/合成首批失败/)).toBeVisible();
    await page.getByRole("button", { name: "重试加载", exact: true }).click();

    // 非空校验：改筛选前确已渲染首批两条，否则后面的「不丢弃已有条目」是空断言
    await expect(pageCase.locate(page, pageCase.firstItem)).toBeVisible();
    await expect(pageCase.locate(page, pageCase.secondItem)).toBeVisible();
    await expect(pageCase.countItems(page)).toHaveCount(2);
    await expect(page.getByText(/合成首批失败/)).toBeHidden();

    // 续页失败：报错但保留首批两条
    await page.getByRole("button", { name: "加载更多", exact: true }).click();
    await expect(page.getByText(/合成续页失败/)).toBeVisible();
    await expect(pageCase.locate(page, pageCase.firstItem)).toBeVisible();
    await expect(pageCase.countItems(page)).toHaveCount(2);

    // 续页重试成功：追加而非替换
    await page.getByRole("button", { name: "重试加载更多", exact: true }).click();
    await expect(pageCase.locate(page, pageCase.moreItem)).toBeVisible();
    await expect(pageCase.countItems(page)).toHaveCount(3);

    // 筛选替换失败：报错但保留已有三条
    await pageCase.changeFilter(page);
    await expect(page.getByText(/合成筛选失败/)).toBeVisible();
    await expect(pageCase.locate(page, pageCase.firstItem)).toBeVisible();
    await expect(pageCase.countItems(page)).toHaveCount(3);

    // 筛选重试成功：整列替换为新结果
    await page.getByRole("button", { name: "重试加载", exact: true }).click();
    await expect(pageCase.locate(page, pageCase.filteredItem)).toBeVisible();
    await expect(pageCase.locate(page, pageCase.firstItem)).toBeHidden();
    await expect(pageCase.countItems(page)).toHaveCount(1);

    // 全流程恰好 6 次列表请求：首批、首批重试、续页、续页重试、筛选、筛选重试
    expect(state.requests).toBe(6);
  });
}
