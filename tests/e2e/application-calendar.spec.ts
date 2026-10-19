import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";

test("真实日历跨页完整展示与下载，时间持续更新，快捷排期保留日期", async ({ page, request }) => {
  test.setTimeout(90_000);
  const now = new Date();
  const marker = `日历回归${now.getTime()}`;
  const interviewTime = new Date(now.getTime() + 20 * 60_000).toISOString();
  const ids: number[] = [];
  try {
    // 最旧的排期必须在第一页外，避免通过看板预先加载掩盖消费端遗漏。
    for (let i = 0; i < 51; i += 1) {
      const response = await request.post("/api/applications", { data: {
        company: `${marker}-${i}`, role: "前端", stage: "interview",
        next_interview_at: i === 0 || i === 50 ? interviewTime : "",
      } });
      expect(response.status()).toBe(201);
      ids.push((await response.json()).id);
    }
    const first = ids[0]!;
    const tasksUrl = `/api/applications/${first}/preparation/tasks`;
    expect((await request.post(tasksUrl, { data: { title: "非法截止", due_time: "not-a-date" } })).status()).toBe(400);
    const deadline = new Date(now.getTime() + 30 * 60_000).toISOString();
    const taskResponse = await request.post(tasksUrl, { data: { title: "跨页准备待办", due_time: deadline } });
    expect(taskResponse.status()).toBe(201);
    const task = await taskResponse.json();
    expect((await request.patch(tasksUrl, { data: { id: task.id, due_time: "2026-02-30T10:00:00Z" } })).status()).toBe(400);

    const firstPage = await (await request.get(`/api/applications?q=${encodeURIComponent(marker)}`)).json();
    expect(firstPage.items).toHaveLength(50);
    expect(firstPage.nextCursor).toBeTruthy();
    expect(firstPage.items.some((item: { id: number }) => item.id === first)).toBe(false);

    await page.clock.install({ time: now });
    await page.goto("/applications?view=calendar");
    await page.getByPlaceholder("搜索公司、岗位或笔记...").fill(marker);
    // 议程不依赖当前周，即使面试落在周日午夜之后也能验证完整性。
    await page.getByRole("button", { name: /议程清单/ }).click();
    await expect(page.getByText(`${marker}-0`, { exact: true })).toBeVisible();
    await expect(page.getByText(`${marker}-50`, { exact: true })).toBeVisible();
    await expect(page.getByText(/仅剩 20m/)).toHaveCount(2);
    await page.getByRole("button", { name: /导出日历/ }).click();
    const downloaded = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出全部日程 (2 场)" }).click();
    const text = await fs.readFile((await (await downloaded).path())!, "utf8");
    const unfolded = text.replace(/\r\n[ \t]/g, "");
    expect(unfolded.match(/BEGIN:VEVENT/g)).toHaveLength(3);
    expect(unfolded).toContain(`${marker}-0`);
    expect(unfolded).toContain(`${marker}-50`);
    expect(unfolded).toContain("跨页准备待办");
    await page.clock.fastForward(21 * 60_000);
    await expect(page.getByText(/仅剩 20m/)).toHaveCount(0);
    await page.clock.fastForward(121 * 60_000);
    await expect(page.getByText("待进行面试 (0)", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: /周日历/ }).click();
    await page.getByTitle("选择日期跳转到对应周").fill("2027-01-04");
    await page.getByRole("button", { name: /记排期/ }).first().click();
    const picker = page.getByRole("button", { name: "下次面试时间 (约面/待面)" });
    await expect(picker).toContainText("2027-01-04 · 请选择时间");
    await picker.click();
    await page.getByRole("button", { name: "14 点", exact: true }).click();
    await page.getByRole("button", { name: "30 分", exact: true }).click();
    await expect(picker).toContainText("2027-01-04 14:30");
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("button", { name: /登记新投递/ }).click();
    await expect(page.getByText("选择下次面试时间...", { exact: true })).toBeVisible();
  } finally {
    for (const id of ids) await request.delete(`/api/applications/${id}`);
  }
});
