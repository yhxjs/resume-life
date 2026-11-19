import { expect, test } from "@playwright/test";

for (const width of [390, 1280]) {
  test(`面试排期摘要 ${width}px：真实多轮按投递计数，分钟倒计时随页面时钟更新`, async ({ page, request }, testInfo) => {
    const now = new Date(); let id = 0, statsReads = 0;
    const errors: string[] = [], writes: string[] = [];
    const company = "完整公司 <T> &amp; " + "连续长名称_".repeat(12);
    try {
      const app = await request.post("/api/applications", { data: { company, role: "系统开发", stage: "interview", jd: "真实排期测试 JD" } });
      expect(app.status()).toBe(201); id = (await app.json()).id;
      for (const [round_name, minutes] of [["技术一面", 20], ["技术二面", 120]] as const) {
        const response = await request.post(`/api/applications/${id}/interviews`, { data: { round_name, interview_time: new Date(now.getTime() + minutes * 60_000).toISOString() } });
        expect(response.status()).toBe(201);
      }
      const stats = await (await request.get("/api/applications/stats")).json();
      expect(stats.upcomingInterviews.filter((app: { id: number }) => app.id === id)).toHaveLength(1);
      expect(stats.upcomingInterviews.find((app: { id: number }) => app.id === id).interviews).toHaveLength(2);
      page.on("pageerror", error => errors.push(error.message));
      page.on("request", req => {
        const path = new URL(req.url()).pathname;
        if (path === "/api/applications/stats") statsReads++;
        if (path.startsWith("/api/") && !["GET", "HEAD", "OPTIONS"].includes(req.method())) writes.push(req.method());
      });
      await page.clock.install({ time: now });
      await page.setViewportSize({ width, height: 900 }); await page.goto("/applications?view=funnel");
      await page.screenshot({ path: testInfo.outputPath(`schedule-initial-${width}.png`) });
      const summary = page.getByRole("region", { name: /面试排期提醒/ });
      await expect(summary).toContainText("1 条投递");
      await expect(summary).toContainText("每条投递仅显示最近一次排期");
      await expect(summary).toContainText("仅剩 20m");
      await expect(page.getByRole("tab", { name: /日程日历/ }).locator("span").last()).toHaveText("1");
      await page.clock.fastForward(5 * 60_000);
      await expect(summary).toContainText("仅剩 15m");
      await page.clock.fastForward(16 * 60_000);
      await expect(summary).toContainText("已到排期时间");
      await expect(summary).not.toContainText("已结束");
      await expect(summary.locator(".bg-danger")).toHaveCount(0);
      await expect(page.getByRole("tab", { name: /日程日历/ }).locator(".animate-pulse")).toHaveCount(0);
      expect(statsReads).toBe(1); expect(writes).toEqual([]); expect(errors).toEqual([]);
      const name = summary.getByText(company, { exact: true });
      expect(await name.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`schedule-elapsed-${width}.png`) });
      await summary.getByRole("link", { name: "查看完整日程", exact: true }).click();
      await expect(page.getByRole("tab", { name: /日程日历/ })).toHaveAttribute("aria-selected", "true");
      await page.getByRole("button", { name: /议程清单/ }).click();
      await expect(page.getByText("技术二面", { exact: true })).toBeVisible();
      expect(writes).toEqual([]); expect(errors).toEqual([]);
    } finally { if (id) await request.delete(`/api/applications/${id}`); }
  });
}
