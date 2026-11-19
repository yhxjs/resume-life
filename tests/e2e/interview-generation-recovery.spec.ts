import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import { publishResume } from "./resume-version-helpers";
import { gate } from "./synthetic-api";

for (const width of [390, 1280]) {
  for (const loseDone of [false, true]) {
    const mode = loseDone ? "series" : "single";
    test(`面试创建 ${width}px ${mode}：等待锁定原稿，无效输出重试${loseDone ? "后从历史恢复已保存首轮" : "后进入已保存首题"}`, async ({ page, request }, testInfo) => {
      test.setTimeout(90_000);
      const baseline = await exportEncryptedBackup(request);
      expect(baseline.response.ok()).toBe(true);
      const release = gate();
      const question = "请说明你实际负责的接口联调范围。" + "API_".repeat(100);
      const jd = "只参与接口校验 <T> &amp;\n尚未上线，Java 或 Go 任选其一。";
      let calls = 0;
      let entered = false;
      const provider = createServer(async (incoming, outgoing) => {
        for await (const chunk of incoming) void chunk;
        calls += 1;
        const current = calls;
        outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
        const delta = (content: string) => outgoing.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
        if (current === 1) {
          delta('{"question":');
          entered = true;
          await release.promise;
          delta("null}");
        } else delta(JSON.stringify({ question }));
        outgoing.end("data: [DONE]\n\n");
      });
      await listenForFetch(provider);
      const address = provider.address();
      if (!address || typeof address === "string") throw new Error("Missing provider address");
      try {
        expect((await request.put("/api/settings", { data: {
          base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-interview-create-key",
          api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic",
        } })).ok()).toBe(true);
        const created = await request.post("/api/resumes", { data: { title: "材料_".repeat(30) } });
        expect(created.status()).toBe(201);
        const resume = await created.json();
        const published = await publishResume(request, resume.id);
        const beforeSingles = await (await request.get("/api/interviews")).json();
        const beforeSeries = await (await request.get("/api/interviews/series")).json();
        let writes = 0;
        let saved: { id: number; series_id: number | null } | undefined;
        await page.route("**/api/interviews", async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          writes += 1;
          expect(route.request().postDataJSON()).toEqual({ resume_id: resume.id, resume_version_id: published.id, jd, rounds: 3, style: "gentle", mode });
          if (writes === 1) return route.continue();
          const response = await route.fetch();
          const events = await response.text();
          const match = events.match(/event: done\ndata: ([^\n]+)/);
          expect(match, events).not.toBeNull();
          saved = JSON.parse(match![1]!);
          if (loseDone) return route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: done\ndata: {}\n\n" });
          return route.fulfill({ response });
        });
        await page.setViewportSize({ width, height: 900 });
        await page.goto("/interviews");
        await page.getByLabel("关联简历").selectOption(String(resume.id));
        await page.getByRole("combobox", { name: "已发布版本", exact: true }).selectOption(String(published.id));
        if (mode === "series") await page.getByRole("button", { name: "进阶三轮连打", exact: true }).click();
        const rounds = page.getByRole("spinbutton", { name: mode === "series" ? "每轮题数" : "总题数", exact: true });
        await rounds.fill("3");
        const input = page.getByRole("textbox", { name: "目标岗位要求（JD / 职位描述）" });
        await input.fill(jd);
        const start = page.getByRole("button", { name: mode === "series" ? "开启进阶三轮连打" : "立即开启模拟实战", exact: true });
        await start.click();
        await expect.poll(() => entered).toBe(true);
        for (const control of [input, rounds, page.getByLabel("关联简历"), page.getByRole("combobox", { name: "已发布版本", exact: true }), page.getByRole("button", { name: "单轮模考", exact: true }), page.getByRole("button", { name: "进阶三轮连打", exact: true })]) await expect(control).toBeDisabled();
        if (mode === "single") await expect(page.getByLabel("考官风格")).toBeDisabled();
        await expect(page.getByRole("button", { name: "取消", exact: true })).toBeEnabled();
        await expect(input).toHaveValue(jd);
        const waiting = page.getByRole("status").filter({ hasText: "首题拟定中" });
        await expect(waiting).toBeVisible();
        await expect(waiting).not.toContainText('{"question":');
        expect(writes).toBe(1);
        expect(calls).toBe(1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        const firstMarker = page.getByText("01.", { exact: true });
        expect(await firstMarker.evaluate((element) => element.getBoundingClientRect().height <= Number.parseFloat(getComputedStyle(element).lineHeight) + 1)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`interview-create-wait-${width}-${mode}.png`) });
        release.release();
        const rejected = page.getByRole("alert").filter({ hasText: "核对材料或配置" });
        await expect(rejected).toBeVisible(); await expect(rejected).not.toContainText("仍可能已保存");
        await rejected.scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath(`interview-create-rejected-${width}-${mode}.png`), animations: "disabled" });
        await expect(input).toHaveValue(jd);
        await expect(start).toBeEnabled();
        expect(await (await request.get("/api/interviews")).json()).toEqual(beforeSingles);
        expect(await (await request.get("/api/interviews/series")).json()).toEqual(beforeSeries);
        await start.click();
        await expect.poll(() => saved?.id ?? 0).toBeGreaterThan(0);
        if (loseDone) {
          await expect(page.getByRole("alert").filter({ hasText: "创建完成响应不完整" })).toBeVisible();
          await expect(page.getByRole("alert").filter({ hasText: "创建完成响应不完整" })).toContainText("仍可能已保存");
          await expect(input).toHaveValue(jd);
          await expect(start).toBeEnabled();
          const history = page.getByRole("link", { name: "继续晋级", exact: true });
          await expect(history).toHaveAttribute("href", `/interviews/series/${saved!.series_id}`);
          expect(writes).toBe(2);
          await history.click();
          await expect(page).toHaveURL(new RegExp(`/interviews/series/${saved!.series_id}$`));
          await page.goto(`/interviews/${saved!.id}`);
        }
        await expect(page).toHaveURL(new RegExp(`/interviews/${saved!.id}$`));
        await expect(page.getByText(question, { exact: true })).toBeVisible();
        const stored = await (await request.get(`/api/interviews/${saved!.id}`)).json();
        expect(stored).toMatchObject({ jd, resume_id: resume.id, resume_version_id: published.id, rounds: 3, series_id: saved!.series_id });
        expect(stored.turns).toHaveLength(1);
        expect(stored.turns[0].question).toBe(question);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        expect(writes).toBe(2);
        expect(calls).toBe(2);
      } finally {
        release.release();
        provider.closeAllConnections();
        await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
        expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
      }
    });
  }
}
