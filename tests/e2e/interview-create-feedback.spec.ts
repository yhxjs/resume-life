import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import { publishResume } from "./resume-version-helpers";

for (const width of [390, 1280]) for (const mode of ["single", "series"] as const) for (const failure of ["408", "bad-error"] as const) {
  test(`面试创建未知结果 ${width}px ${mode} ${failure}：真实保存后保留配置，从历史找回且不重提`, async ({ page, request }, info) => {
    test.setTimeout(90_000);
    const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
    const question = "你实际负责的参数校验范围是什么？"; let calls = 0; let posts = 0; let reads = 0;
    let saved: { id: number; series_id: number | null } | undefined;
    const provider = createServer(async (incoming, outgoing) => {
      for await (const chunk of incoming) void chunk; calls++;
      outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
      outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ question }) } }] })}\n\ndata: [DONE]\n\n`);
    });
    await listenForFetch(provider);
    const address = provider.address(); if (!address || typeof address === "string") throw new Error("Missing provider address");
    try {
      expect((await request.put("/api/settings", { data: { base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-create-feedback", api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic" } })).ok()).toBe(true);
      const sourceResponse = await request.post("/api/resumes", { data: { title: "未知创建结果材料" } }); expect(sourceResponse.status()).toBe(201);
      const source = await sourceResponse.json(); const version = await publishResume(request, source.id);
      const oldResponse = await request.post("/api/interviews", { data: { resume_id: source.id, resume_version_id: version.id, jd: "另一存档", rounds: 1 } });
      const oldMatch = (await oldResponse.text()).match(/event: done\ndata: ([^\n]+)/); expect(oldMatch).not.toBeNull(); const oldId = JSON.parse(oldMatch![1]!).id;
      const old = await (await request.get(`/api/interviews/${oldId}`)).json();
      const jd = "  仅参与参数校验 <T> &amp;\n尚未交付  ";
      await page.route("**/api/interviews**", async route => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/interviews" && route.request().method() === "POST") {
          posts++; const response = await route.fetch(); expect(response.status()).toBe(200);
          const events = await response.text(); expect(events).not.toContain("event: error");
          const match = events.match(/event: done\ndata: ([^\n]+)/); expect(match, events).not.toBeNull(); saved = JSON.parse(match![1]!);
          if (failure === "408") return route.fulfill({ status: 408, json: { error: "创建响应等待超时" } });
          return route.fulfill({ status: 200, contentType: "text/event-stream", body: 'event: error\ndata: {"error":{}}\n\n' });
        }
        if (posts && route.request().method() === "GET" && ["/api/interviews", "/api/interviews/series"].includes(path)) reads++;
        return route.continue();
      });
      const initialHistory = Promise.all(["/api/interviews", "/api/interviews/series"].map(path => page.waitForResponse(response =>
        response.request().method() === "GET" && new URL(response.url()).pathname === path && response.status() === 200)));
      await page.setViewportSize({ width, height: 900 }); await page.goto(`/interviews?resumeId=${source.id}&resumeVersionId=${version.id}`);
      // 首次列表带 250ms 防抖，不能让尚未发出的首读混入创建异常后的刷新计数。
      await initialHistory;
      await expect(page.getByRole("status", { name: "面试记录加载中", exact: true })).toHaveCount(0);
      if (mode === "series") await page.getByRole("button", { name: "进阶三轮连打", exact: true }).click();
      const rounds = page.getByRole("spinbutton", { name: mode === "series" ? "每轮题数" : "总题数", exact: true }); await rounds.fill("3");
      const input = page.getByRole("textbox", { name: "目标岗位要求（JD / 职位描述）", exact: true }); await input.fill(jd);
      if (mode === "single") await page.getByLabel("考官风格").selectOption("deep");
      const start = page.getByRole("button", { name: mode === "single" ? "立即开启模拟实战" : "开启进阶三轮连打", exact: true }); await start.click();
      const feedback = page.getByRole("alert").filter({ hasText: failure === "408" ? "创建响应等待超时" : "流式响应错误事件格式无效" });
      await expect(feedback).toBeVisible(); await expect(feedback).toContainText("仍可能已保存"); await expect(feedback).not.toContainText("核对材料或配置");
      await expect(start).toBeEnabled(); await expect(input).toHaveValue(jd); await expect(rounds).toHaveValue("3");
      await expect(page.getByLabel("关联简历")).toHaveValue(String(source.id));
      await expect(page.getByRole("combobox", { name: "已发布版本", exact: true })).toHaveValue(String(version.id));
      if (mode === "single") await expect(page.getByLabel("考官风格")).toHaveValue("deep");
      await expect(page).toHaveURL(/\/interviews\?resumeId=/);
      await expect.poll(() => reads).toBe(2); expect(posts).toBe(1); expect(calls).toBe(2);
      // 按真实存档 ID 定位，不能用相同 JD 认领原请求。
      const savedPath = mode === "single" ? `/interviews/${saved!.id}` : `/interviews/series/${saved!.series_id}`;
      const savedLink = page.locator(`a[href="${savedPath}"]`).filter({ hasText: mode === "single" ? "继续作答" : "继续晋级" });
      await expect(savedLink).toBeVisible();
      const stored = await (await request.get(`/api/interviews/${saved!.id}`)).json();
      expect(stored).toMatchObject({ jd: jd.trim(), resume_id: source.id, resume_version_id: version.id, rounds: 3, series_id: saved!.series_id });
      expect(stored.turns).toHaveLength(1); expect(stored.turns[0].question).toBe(question);
      expect(await (await request.get(`/api/interviews/${oldId}`)).json()).toEqual(old);
      await feedback.scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`create-unknown-${width}-${mode}-${failure}.png`), animations: "disabled" });
      await savedLink.click(); await expect(page).toHaveURL(new RegExp(`/interviews/${mode === "single" ? saved!.id : `series/${saved!.series_id}`}$`));
      if (mode === "series") await page.goto(`/interviews/${saved!.id}`);
      await expect(page.getByText(question, { exact: true })).toBeVisible(); expect(posts).toBe(1); expect(calls).toBe(2);
    } finally {
      provider.closeAllConnections(); await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
      expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
    }
  });
}
