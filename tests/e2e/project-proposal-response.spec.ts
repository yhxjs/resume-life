import { expect, test } from "@playwright/test";
import { emptySummary } from "../../src/lib/summary";
import { compareProjectSummaries } from "../../src/lib/project-summary-diff";

for (const width of [390, 1280]) for (const mode of ["full", "resume-only", "scan"]) {
  test(`${width}px ${mode} 拒绝坏草稿回包，保留编辑和采纳选择，正常回复可显式重试`, async ({ page, request }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width, height: 900 });
    const created = await request.post("/api/projects", { data: { name: `回包校验 ${mode}` } });
    expect(created.status()).toBe(201);
    const root = `/api/projects/${(await created.json()).id}`;
    try {
      const original = { ...emptySummary(), overview: "原项目定位，尚未上线", responsibilities: "原职责：只参与校验", brief: "原简历介绍" };
      expect((await request.patch(root, { data: { summary: original } })).status()).toBe(200);
      expect((await request.post(`${root}/materials`, { data: { title: "实际材料", content: "只参与参数校验，尚未上线" } })).status()).toBe(201);
      const detail = await (await request.get(root)).json();
      const history = await (await request.get(`${root}/summary-history`)).json();
      const generated = { ...original, overview: "草稿定位 <T> &amp;", brief: "草稿介绍：参与校验，尚未上线" };
      const valid = () => ({ summary: generated, comparison: compareProjectSummaries(original, generated, {}), materialChanges: [], materialFingerprint: "a".repeat(64), revisionId: detail.summary_revision_id });
      let reply: unknown = valid();
      let calls = 0;
      let writes = 0;
      page.on("request", req => { if (new URL(req.url()).pathname === root && req.method() === "PATCH") writes++; });
      await page.route(`**${root}/summarize*`, route => {
        calls++;
        return route.fulfill({ contentType: "text/event-stream", body: `event: done\ndata: ${JSON.stringify(reply)}\n\n` });
      });
      await page.route(`**${root}/scan-repo`, route => {
        if (route.request().method() === "GET") return route.fulfill({ json: { codex: { available: true }, claude: { available: false }, recommended: "codex" } });
        calls++;
        return route.fulfill({ contentType: "text/event-stream", body: `event: done\ndata: ${JSON.stringify(reply)}\n\n` });
      });
      await page.goto(`/knowledge/${detail.id}`);
      const overview = page.locator("#project-summary-overview");
      await expect(overview).toHaveValue(original.overview);
      const edited = "本人校正：只负责参数校验，未参与上线 <T> &amp;";
      await page.locator("#project-summary-responsibilities").fill(edited);
      const review = page.getByRole("region", { name: "本次总结差异" });
      const generate = async () => {
        const previousCalls = calls;
        if (mode === "scan") {
          if (!(await page.getByRole("dialog").count())) {
            await page.getByRole("button", { name: /扫描本地代码仓库/ }).click();
            const input = page.locator("#repo-path-input");
            if (!(await input.inputValue())) await input.fill("D:\\synthetic\\repo");
          }
          await page.getByRole("button", { name: "开始扫描并提炼" }).click();
        } else await page.getByRole("button", { name: mode === "full" ? /重新生成 STAR 总结/ : /单独提炼简历三项/ }).click();
        await expect.poll(() => calls).toBe(previousCalls + 1);
      };
      await generate();
      if (mode === "scan") await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(review).toBeVisible();
      const briefChange = review.getByRole("group", { name: "项目简要概述" });
      await briefChange.getByRole("button", { name: "采纳本段" }).click();
      await expect(page.locator("#resume-brief")).toHaveValue(generated.brief);
      const badReplies = [
        { ...valid(), summary: { overview: "残缺正文不能清空其余字段" } },
        { ...valid(), revisionId: undefined },
        { ...valid(), materialFingerprint: "bad" },
        { ...valid(), comparison: [{ ...valid().comparison[0], next: "不同于实际采纳正文的预览" }] },
        { ...valid(), materialChanges: [{ id: "1", title: "材料", status: "new" }] },
      ];
      for (const bad of badReplies) {
        reply = bad;
        await generate();
        await expect(page.getByText(/草稿响应不完整或内容不符/).last()).toBeVisible();
        if (mode === "scan") {
          await expect(page.getByRole("dialog")).toBeVisible();
          await expect(page.locator("#repo-path-input")).toHaveValue("D:\\synthetic\\repo");
        } else {
          await expect(briefChange.getByRole("button", { name: "撤销采纳" })).toBeVisible();
        }
        // 扫描弹窗会暂时隐藏背景的可访问树，仍核对原编辑和采纳正文完整保留。
        await expect(overview).toHaveValue(original.overview);
        await expect(page.locator("#project-summary-responsibilities")).toHaveValue(edited);
        await expect(page.locator("#resume-brief")).toHaveValue(generated.brief);
        expect(writes).toBe(0);
      }
      reply = valid();
      await generate();
      if (mode === "scan") await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(review).toBeVisible();
      await expect(overview).toHaveValue(original.overview);
      await expect(page.locator("#project-summary-responsibilities")).toHaveValue(edited);
      expect(writes).toBe(0);
      expect(await (await request.get(root)).json()).toEqual(detail);
      expect(await (await request.get(`${root}/summary-history`)).json()).toEqual(history);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally { expect((await request.delete(root)).status()).toBe(200); }
  });
}
