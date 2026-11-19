import { expect, test, type Locator, type Page } from "@playwright/test";
import { stripRichText } from "../../src/lib/rich-text";
import { MODULE_KEYS, normalizeContent } from "../../src/lib/modules";

async function rejectPendingCopy(page: Page, button: Locator) {
  await page.evaluate(() => {
    const state = window as Window & { rejectCopy?: () => void; copyCalls?: number };
    state.copyCalls = 0;
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
      writeText: () => {
        state.copyCalls!++;
        return new Promise<void>((_resolve, reject) => { state.rejectCopy = () => reject(new Error("denied")); });
      },
    } });
  });
  await button.click();
  await expect(button).toBeDisabled();
  expect(await page.evaluate(() => (window as Window & { copyCalls?: number }).copyCalls)).toBe(1);
}

for (const width of [390, 1280]) {
  test(`导入校对 ${width}px：指标不误认数值片段，复制与手工修正均保留原文`, async ({ page, request }, testInfo) => {
    const source = "示例科技\n历史材料 135%，另项为 1.35%。本次测试环境吞吐 -35%，未上线。\n预算 1,200.5万元；延迟 ≤0.5 ms；团队区间 10–35 人。\n原字符 <T> &amp;，以上数据口径与分工仍待核实。";
    let creates = 0;
    let resumeId: number | null = null;
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/api/import/parse", (route) => route.fulfill({ json: {
      title: "待校对的数值材料", modules: Object.fromEntries(MODULE_KEYS.map((key) => [key, normalizeContent(key, ({
        basic: { name: "合成用户", phone: "", email: "", location: "", birthday: "", links: "" },
        education: [], projects: [], skills: { items: [] }, summary: { text: "" }, custom: [],
        work: [{ id: "w1", company: "示例科技", title: "工程师", start: "", end: "",
          descriptionItems: ["待核实：改善 35%。", "测试环境吞吐 -35%，预算 1,200.5 万元；延迟 ≤0.5ms；团队 10–35 人，未上线。"] }],
      } as Record<string, unknown>)[key])])),
    } }));
    page.on("request", (incoming) => {
      if (incoming.method() === "POST" && new URL(incoming.url()).pathname === "/api/resumes") creates++;
    });
    try {
      await page.goto("/resumes/import");
      await page.getByRole("textbox", { name: "简历原文", exact: true }).fill(source);
      await page.getByRole("button", { name: "开始智能解析 →", exact: true }).click();
      const proofing = page.getByRole("region", { name: "原文校对区", exact: true });
      const metrics = page.getByRole("button", { name: "定位原文：工作 1 · 指标", exact: true });
      await metrics.filter({ has: page.getByText("35%", { exact: true }) }).click();
      const location = page.getByRole("status", { name: "原文定位状态", exact: true });
      await expect(location).toContainText("原文未找到");
      await expect(page.locator("mark")).toHaveCount(0);
      for (const [value, matched] of [["-35%", "-35%"], ["1,200.5 万元", "1,200.5万元"], ["≤0.5ms", "≤0.5 ms"], ["10–35 人", "10–35 人"]]) {
        await metrics.filter({ has: page.getByText(value!, { exact: true }) }).click();
        await expect(location).toContainText("第 1 / 1 处");
        await expect(page.locator('mark[aria-current="location"]')).toHaveText(matched!);
      }
      const replacement = "只参与测试环境的参数校验，吞吐 -35%，尚未上线，收益未统计。";
      const draft = page.getByRole("textbox", { name: "工作经历描述第 1 行", exact: true });
      await draft.fill(replacement);
      const copy = proofing.getByRole("button", { name: "复制原文", exact: true });
      await copy.click();
      await expect(page.getByRole("status", { name: "原文复制状态", exact: true })).toHaveText("原文已复制");
      await expect.poll(() => page.evaluate(async () => (await navigator.clipboard.readText()).replace(/\r\n/g, "\n"))).toBe(source);
      await rejectPendingCopy(page, copy);
      await expect(page.getByRole("status", { name: "原文复制状态", exact: true })).toHaveCount(0);
      await page.evaluate(() => (window as Window & { rejectCopy?: () => void }).rejectCopy?.());
      await expect(proofing.getByRole("alert")).toContainText("手动复制");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await proofing.screenshot({ path: testInfo.outputPath(`source-copy-error-${width}.png`) });
      await page.evaluate(() => Reflect.deleteProperty(navigator, "clipboard"));
      await copy.click();
      await expect(proofing.getByRole("alert")).toHaveCount(0);
      await expect(draft).toHaveText(replacement);
      await expect(page.getByLabel("导入原文", { exact: true })).toHaveText(source);
      expect(creates).toBe(0);
      await page.getByRole("button", { name: "确认导入", exact: true }).click();
      await expect(page).toHaveURL(/\/resumes\/\d+$/);
      resumeId = Number(new URL(page.url()).pathname.split("/").at(-1));
      expect(creates).toBe(1);
      const savedResponse = await request.get(`/api/resumes/${resumeId}`);
      expect(savedResponse.ok()).toBe(true);
      const saved = await savedResponse.json();
      const work = saved.modules.find((module: { key: string }) => module.key === "work").content[0];
      expect(stripRichText(work.descriptionItems[0])).toBe(replacement);
      expect(stripRichText(work.descriptionItems[1])).toBe("测试环境吞吐 -35%，预算 1,200.5 万元；延迟 ≤0.5ms；团队 10–35 人，未上线。");
      await page.reload();
      await page.getByRole("tab", { name: "工作经历", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "工作经历描述第 1 行", exact: true })).toHaveText(replacement);
    } finally {
      if (resumeId !== null) expect((await request.delete(`/api/resumes/${resumeId}`)).ok()).toBe(true);
    }
  });

  test(`会议链接 ${width}px：复制拒绝显示完整原链接，重试不修改排期`, async ({ page, request }, testInfo) => {
    const meetingUrl = "https://meeting.example/join?token=A%2BB&mode=guest#room-with-a-long-identifier";
    const created = await request.post("/api/applications", { data: { company: `复制校验${width}`, role: "前端", stage: "interview" } });
    expect(created.status()).toBe(201);
    const applicationId = (await created.json()).id;
    try {
      const roundsUrl = `/api/applications/${applicationId}/interviews`;
      const round = await request.post(roundsUrl, { data: { round_name: "复制核对轮", interview_time: new Date(Date.now() + 3_600_000).toISOString(), meeting_url: meetingUrl } });
      expect(round.status()).toBe(201);
      const original = await (await request.get(roundsUrl)).json();
      const writes: string[] = [];
      page.on("request", (incoming) => {
        const path = new URL(incoming.url()).pathname;
        if (incoming.method() !== "GET" && path.startsWith(`/api/applications/${applicationId}`)) writes.push(path);
      });
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/applications?view=calendar");
      await page.getByPlaceholder("搜索公司、岗位或笔记...").fill(`复制校验${width}`);
      await page.getByRole("button", { name: /议程清单/ }).click();
      const meeting = page.getByRole("group", { name: "会议地点与链接", exact: true });
      const copy = meeting.getByTitle("复制会议链接");
      await copy.click();
      await expect(copy).toHaveText("已复制 ✓");
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(meetingUrl);
      await rejectPendingCopy(page, copy);
      await expect(copy).toHaveText("复制链接");
      await page.evaluate(() => (window as Window & { rejectCopy?: () => void }).rejectCopy?.());
      await expect(meeting.getByRole("alert")).toContainText("手动复制");
      await expect(meeting.getByRole("alert").getByText(meetingUrl, { exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await meeting.screenshot({ path: testInfo.outputPath(`meeting-copy-error-${width}.png`) });
      await page.evaluate(() => Reflect.deleteProperty(navigator, "clipboard"));
      await copy.click();
      await expect(meeting.getByRole("alert")).toHaveCount(0);
      await expect(meeting.getByRole("link", { name: /进入会议/ })).toHaveAttribute("href", meetingUrl);
      await page.reload();
      await page.getByPlaceholder("搜索公司、岗位或笔记...").fill(`复制校验${width}`);
      await page.getByRole("button", { name: /议程清单/ }).click();
      await expect(page.getByRole("group", { name: "会议地点与链接", exact: true }).getByRole("link", { name: /进入会议/ })).toHaveAttribute("href", meetingUrl);
      expect(await (await request.get(roundsUrl)).json()).toEqual(original);
      expect(writes).toEqual([]);
    } finally {
      expect((await request.delete(`/api/applications/${applicationId}`)).ok()).toBe(true);
    }
  });
}
