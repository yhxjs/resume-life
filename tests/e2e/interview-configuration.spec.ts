import { expect, test } from "@playwright/test";
import { mockApi } from "./synthetic-api";

for (const width of [390, 1280]) {
  for (const missing of ["resume", "version"]) {
    test(`面试材料 ${width}px ${missing}：缺失绑定不换材料，重读恢复原版，非法题数零创建`, async ({ page }, testInfo) => {
      await mockApi(page);
      const first = { id: 1, title: "不能替代的其他简历", versions: [{ id: 11, version: 1, name: "其他版本" }] };
      const bound = { id: 2, title: "投递指定简历", versions: [{ id: 21, version: 1, name: "投递旧版" }, { id: 22, version: 2, name: "后发新版" }] };
      const jd = "仅参与联调 <T> &amp;\n尚未上线。";
      let reads = 0;
      let writes = 0;
      let body: Record<string, unknown> | undefined;
      await page.route("**/api/applications/9", (route) => route.fulfill({ json: { id: 9, company: "合成公司", role: "合成岗位", jd, resume_id: 2, resume_version_id: 21 } }));
      await page.route("**/api/resumes", (route) => {
        reads += 1;
        return route.fulfill({ json: reads > 1 ? [first, bound] : missing === "resume" ? [first] : [first, { ...bound, versions: [bound.versions[1]] }] });
      });
      await page.route("**/api/interviews", (route) => {
        if (route.request().method() !== "POST") return route.fulfill({ json: { items: [], nextCursor: null, total: 0 } });
        writes += 1;
        body = route.request().postDataJSON();
        return route.fulfill({ contentType: "text/event-stream", body: 'event: done\ndata: {"id":77,"series_id":7}\n\n' });
      });
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/interviews?applicationId=9&resumeId=1&resumeVersionId=11&jd=不能替代原文");
      const warning = page.getByRole("alert").filter({ hasText: "投递绑定的简历或发布版不在当前列表中" });
      await expect(warning).toBeVisible();
      await expect(page.getByText(/JD 来自该投递，简历须与其绑定发布版一致/)).toBeVisible();
      await expect(page.getByText(/已带入该投递的简历与 JD/)).toHaveCount(0);
      await expect(page.getByRole("button", { name: "立即开启模拟实战", exact: true })).toBeDisabled();
      await expect(page.getByLabel("关联简历")).toHaveValue(missing === "resume" ? "" : "2");
      if (missing === "version") await expect(page.getByRole("combobox", { name: "已发布版本", exact: true })).toHaveValue("");
      await expect(page.getByLabel("目标岗位要求（JD / 职位描述）")).toHaveValue(jd);
      expect(writes).toBe(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await warning.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`interview-missing-${width}-${missing}.png`) });
      await page.getByRole("button", { name: "重新读取简历列表", exact: true }).click();
      await expect(page.getByLabel("关联简历")).toHaveValue("2");
      await expect(page.getByRole("combobox", { name: "已发布版本", exact: true })).toHaveValue("21");
      await expect(warning).toHaveCount(0);
      expect(reads).toBe(2);
      await page.getByRole("button", { name: "进阶三轮连打", exact: true }).click();
      const input = page.getByRole("spinbutton", { name: "每轮题数", exact: true });
      const start = page.getByRole("button", { name: "开启进阶三轮连打", exact: true });
      for (const value of ["", "0", "-1", "31", "1.5"]) {
        await input.fill(value);
        await expect(input).toHaveValue(value);
        await expect(input).toHaveAttribute("aria-invalid", "true");
        await expect(input).toHaveAccessibleDescription("题数须为 1–30 的整数");
        await expect(start).toBeDisabled();
        expect(writes).toBe(0);
      }
      await input.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`interview-rounds-${width}-${missing}.png`) });
      await input.fill("3");
      await expect(input).toHaveAttribute("aria-invalid", "false");
      await expect(start).toBeEnabled();
      await start.click();
      await expect(page).toHaveURL(/\/interviews\/77\?applicationId=9$/);
      expect(body).toEqual({ resume_id: 2, resume_version_id: 21, jd, application_id: 9, rounds: 3, style: "gentle", mode: "series" });
      expect(writes).toBe(1);
    });
  }
}

test("真实创建 API 拒绝非法题数，不静默默认或夹取，历史记录保持不变", async ({ request }) => {
  const before = await (await request.get("/api/interviews")).json();
  const beforeSeries = await (await request.get("/api/interviews/series")).json();
  for (const rounds of [null, 0, -1, 31, 1.5, "8", "", true, [], {}]) {
    const response = await request.post("/api/interviews", { data: { resume_id: 1, jd: "输入校验先于资料及模型读取", rounds, mode: "series" } });
    expect(response.status()).toBe(400);
    expect(await response.json()).toEqual({ error: "题数须为 1–30 的整数" });
  }
  expect(await (await request.get("/api/interviews")).json()).toEqual(before);
  expect(await (await request.get("/api/interviews/series")).json()).toEqual(beforeSeries);
});
