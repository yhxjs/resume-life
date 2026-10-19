import { expect, test } from "@playwright/test";
import { mockApi } from "./synthetic-api";

const histories = [
  {
    name: "自我介绍",
    page: "/intros",
    api: "/api/intros",
    item: (id: number) => ({ id, jd: `岗位 ${id}`, resume_title: "简历", resume_version_id: 90001, resume_version: 1, resume_version_name: "测试发布版本", created_at: "2026-09-16" }),
    oldest: "岗位 1",
  },
  {
    name: "薪酬谈判",
    page: "/tools/salary",
    api: "/api/tools/salary-negotiations",
    item: (id: number) => ({ id, target_company_tier: "top_tech", target_role: `岗位 ${id}`, expected_salary: "30k", hr_style: "standard", status: "ongoing", initial_offer: "25k", final_package: "", created_at: "2026-09-16", turns_count: 1 }),
    oldest: "岗位 1",
  },
  {
    name: "黑话解码",
    page: "/tools/decoder",
    api: "/api/tools/jargon-decodings",
    item: (id: number) => ({ id, source_text: `黑话 ${id}`, result: "", created_at: "2026-09-16" }),
    oldest: "黑话 1",
  },
  {
    name: "空窗期对策",
    page: "/tools/gap",
    api: "/api/tools/career-gap-remedies",
    item: (id: number) => ({ id, scenario_type: "gap", raw_story: `经历 ${id}`, target_role: "", persona_style: "pragmatic", result: "", created_at: "2026-09-16" }),
    oldest: "经历 1",
  },
  {
    name: "JD 画像",
    page: "/tools/jd",
    api: "/api/tools/jd-portraits",
    item: (id: number) => ({ id, jd: `JD ${id}`, result: "", created_at: "2026-09-16" }),
    oldest: "JD 1",
  },
] as const;

for (const history of histories) {
  test(`${history.name} 可从列表加载第 51 条`, async ({ page }) => {
    await mockApi(page);
    const records = Array.from({ length: 51 }, (_, index) => history.item(51 - index));
    await page.route(`**${history.api}*`, async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() !== "GET") return route.continue();
      expect(url.searchParams.get("limit")).toBe("50");
      const cursor = url.searchParams.get("cursor");
      const items = cursor === null ? records.slice(0, 50) : records.filter((record) => record.id < Number(cursor));
      await route.fulfill({ json: { items, nextCursor: cursor === null ? "2" : null, total: records.length } });
    });

    await page.goto(history.page);
    await expect(page.getByText("共 51", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "加载更多", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: history.oldest, exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "加载更多", exact: true }).click();
    await expect(page.getByRole("link", { name: history.oldest, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "加载更多", exact: true })).toHaveCount(0);
  });
}

test("薪酬谈判 HR 风格可用原生单选组和键盘选择", async ({ page }) => {
  await mockApi(page);
  await page.route("**/api/tools/salary-negotiations?*", (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } })
  );
  await page.goto("/tools/salary");
  const group = page.getByRole("group", { name: "对手 HR 人设与风格" });
  const radios = group.getByRole("radio");
  await expect(radios).toHaveCount(3);
  await expect(radios.nth(1)).toBeChecked();
  await radios.nth(1).focus();
  await page.keyboard.press("ArrowRight");
  await expect(radios.nth(2)).toBeChecked();
});
