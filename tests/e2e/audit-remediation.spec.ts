import { expect, test } from "@playwright/test";
import JSZip from "jszip";

test.use({ timezoneId: "Asia/Shanghai" });

test("日期浮层支持键盘打开、内层 Escape 和提交回焦", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-18T02:00:00.000Z") });
  await page.goto("/applications");
  await page.getByRole("button", { name: /登记新投递/ }).click();
  const trigger = page.getByRole("button", { name: "下次面试时间 (约面/待面)" });
  for (const key of ["Enter", "Space"]) {
    await trigger.focus();
    await trigger.press(key);
    const picker = page.getByRole("dialog", { name: "选择日期与时间", exact: true });
    await expect(picker.getByRole("button", { name: "2026年10月18日", pressed: true })).toBeFocused();
    const hour = picker.getByRole("button", { name: "14 点", exact: true });
    await hour.focus();
    await hour.press("Escape");
    await expect(picker).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(trigger).toBeVisible();
  }
  await trigger.press("Enter");
  await page.getByRole("button", { name: "14 点", exact: true }).click();
  await page.getByRole("button", { name: "30 分", exact: true }).click();
  await expect(trigger).toContainText("2026-10-18 14:30");
  await expect(trigger).toBeFocused();
});

test("浏览器时区随用量请求发送，单日和七天趋势日期正确", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-18T02:00:00.000Z") });
  await page.goto("/settings/usage");
  const weekResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/settings/llm-usage" && url.searchParams.get("from") === "2026-10-11T16:00:00.000Z";
  });
  await page.getByRole("button", { name: "近 7 天", exact: true }).click();
  const response = await weekResponse;
  expect(response.status()).toBe(200);
  expect(new URL(response.url()).searchParams.get("timeZone")).toBe("Asia/Shanghai");
  const week = await response.json();
  expect(week.daily.map((row: { date: string }) => row.date)).toEqual([
    "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18",
  ]);
  await page.getByRole("button", { name: "自定义", exact: true }).click();
  await page.getByLabel("起始日期").fill("2026-10-18");
  const dayResponse = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/settings/llm-usage"
    && new URL(res.url()).searchParams.get("from") === "2026-10-17T16:00:00.000Z");
  await page.getByLabel("结束日期").fill("2026-10-18");
  const day = await (await dayResponse).json();
  expect(day.daily).toHaveLength(1);
  expect(day.daily[0].date).toBe("2026-10-18");
});

test("项目删除后导出明确失败，移除失效选择后保留其余链接恢复导出", async ({ request }) => {
  const marker = `审计修复${Date.now()}`;
  const resumeResponse = await request.post("/api/resumes", { data: { title: marker } });
  expect(resumeResponse.status()).toBe(201);
  const resume = await resumeResponse.json() as { id: number };
  const projectIds: number[] = [];
  try {
    for (const suffix of ["删除", "保留"]) {
      const response = await request.post("/api/projects", { data: { name: `${marker}${suffix}` } });
      expect(response.status()).toBe(201);
      projectIds.push((await response.json()).id);
    }
    const duplicate = await request.post("/api/portfolio/export", { data: {
      resumeId: resume.id, selectedProjects: [{ projectId: projectIds[0] }, { projectId: projectIds[0] }],
    } });
    expect(duplicate.status()).toBe(400);
    const selectedProjects = projectIds.map((projectId) => ({ projectId, customLinks: { demoUrl: "https://example.invalid/keep" } }));
    expect((await request.delete(`/api/projects/${projectIds[0]}`)).ok()).toBe(true);
    const stale = await request.post("/api/portfolio/export", { data: { resumeId: resume.id, selectedProjects } });
    expect(stale.status()).toBe(409);
    expect((await stale.json()).error).toContain("已不存在");

    const sources = await (await request.get("/api/portfolio/sources")).json() as { projects: Array<{ id: number }> };
    const remaining = selectedProjects.filter((selection) => sources.projects.some((project) => project.id === selection.projectId));
    expect(remaining).toHaveLength(1);
    const exported = await request.post("/api/portfolio/export", { data: { resumeId: resume.id, selectedProjects: remaining } });
    expect(exported.status()).toBe(200);
    expect(exported.headers()["content-type"]).toContain("application/zip");
    const zip = await JSZip.loadAsync(await exported.body());
    const html = await zip.file("index.html")!.async("string");
    expect(html).toContain(`${marker}保留`);
    expect(html).toContain("https://example.invalid/keep");
    expect(html).not.toContain(`${marker}删除`);
  } finally {
    for (const id of projectIds) await request.delete(`/api/projects/${id}`);
    await request.delete(`/api/resumes/${resume.id}`);
  }
});
