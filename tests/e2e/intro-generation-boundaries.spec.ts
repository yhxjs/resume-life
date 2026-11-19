import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import { publishResume } from "./resume-version-helpers";
import { gate } from "./synthetic-api";

for (const width of [390, 1280]) {
  for (const completion of ["valid", "broken-done", "408", "broken-error"] as const) {
    const scenario = { valid: "正常完成", "broken-done": "损坏完成事件", "408": "响应超时", "broken-error": "损坏错误事件" }[completion];
    test(`自我介绍生成 ${width}px：明确拒绝后显式重试，${scenario}核对实际存档`, async ({ page, request }, testInfo) => {
      test.setTimeout(90_000);
      const baseline = await exportEncryptedBackup(request);
      expect(baseline.response.ok()).toBe(true);
      const release = gate();
      const text = "我在指导下参与接口校验，尚未上线。";
      const long = "API_".repeat(55) + "仅测试标识，不代表上线成果。";
      let calls = 0;
      let entered = false;
      const provider = createServer(async (incoming, outgoing) => {
        for await (const chunk of incoming) void chunk;
        calls += 1;
        outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
        const delta = (content: string) => outgoing.write(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`);
        if (calls === 1) {
          delta('{"versions":[{"text":"未校验临时正文不得显示"');
          entered = true;
          await release.promise;
          // JSON 可解析但版本结构无效，避免触发 LLM 层既有的 JSON 语法自动重试。
          delta("}]}");
        } else delta(JSON.stringify({ versions: [
          { kind: "30s", sentences: [{ text, comment: "保留参与范围与验证状态。" }] },
          { kind: "2min", sentences: [{ text: long, comment: "长标识原样保留。" }] },
        ] }));
        outgoing.end("data: [DONE]\n\n");
      });
      await listenForFetch(provider);
      const address = provider.address();
      if (!address || typeof address === "string") throw new Error("Missing provider address");
      try {
        expect((await request.put("/api/settings", { data: {
          base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-intro-generation-key",
          api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic",
        } })).ok()).toBe(true);
        const created = await request.post("/api/resumes", { data: { title: "履历_".repeat(50) } });
        expect(created.status()).toBe(201);
        const resume = await created.json();
        const published = await publishResume(request, resume.id);
        const before = await (await request.get("/api/intros")).json();
        let writes = 0;
        let completedId = 0;
        await page.route("**/api/intros", async (route) => {
          if (route.request().method() !== "POST") return route.continue();
          writes += 1;
          expect(route.request().postDataJSON()).toEqual({ resume_id: resume.id, resume_version_id: published.id, jd: "参数校验 <T> &amp;\n未上线" });
          // 第一轮直接透传，以验证上游已发片段时浏览器仍只显示等待状态。
          if (writes === 1) return route.continue();
          const response = await route.fetch();
          const events = await response.text();
          expect(events).not.toContain("event: delta");
          const match = events.match(/event: done\ndata: ([^\n]+)/);
          expect(match, events).not.toBeNull();
          completedId = JSON.parse(match![1]!).id;
          if (completion === "broken-done") return route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: done\ndata: {}\n\n" });
          if (completion === "408") return route.fulfill({ status: 408, contentType: "application/json", body: JSON.stringify({ error: "生成响应等待超时" }) });
          if (completion === "broken-error") return route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: error\ndata: {\"error\":null}\n\n" });
          return route.fulfill({ response });
        });
        await page.setViewportSize({ width, height: 900 });
        await page.goto("/intros");
        await page.getByRole("combobox", { name: "选择参考简历" }).selectOption(String(resume.id));
        await page.getByRole("combobox", { name: "已发布版本", exact: true }).selectOption(String(published.id));
        const jd = page.getByRole("textbox", { name: "目标岗位要求（JD / 职位描述）" });
        await jd.fill("参数校验 <T> &amp;\n未上线");
        const generate = page.getByRole("button", { name: "立即生成两版自我介绍", exact: true });
        await generate.click();
        await expect.poll(() => entered).toBe(true);
        const waiting = page.getByRole("status").filter({ hasText: "完整校验并保存后进入演练页" });
        await expect(waiting).toBeVisible();
        await expect(page.getByText(/未校验临时正文不得显示/)).toHaveCount(0);
        await expect(jd).toBeDisabled();
        await expect(page.getByText(/没有量化结果时保留定性描述/)).toBeVisible();
        expect(calls).toBe(1);
        expect(writes).toBe(1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await waiting.scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath(`intro-generation-${width}.png`) });
        release.release();
        const rejected = page.getByRole("alert").filter({ hasText: "AI 生成结果异常" });
        await expect(rejected).toBeVisible();
        await expect(rejected).toContainText("请按上方提示处理后再生成");
        await expect(rejected).not.toContainText("仍可能已保存");
        await expect(jd).toHaveValue("参数校验 <T> &amp;\n未上线");
        expect(await (await request.get("/api/intros")).json()).toEqual(before);
        await rejected.scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath(`intro-rejected-${width}.png`) });
        await generate.click();
        await expect.poll(() => completedId).toBeGreaterThan(0);
        if (completion !== "valid") {
          const reason = { "broken-done": "生成完成响应不完整", "408": "生成响应等待超时", "broken-error": "流式响应错误事件格式无效" }[completion];
          const uncertain = page.getByRole("alert").filter({ hasText: reason });
          await expect(uncertain).toBeVisible();
          await expect(uncertain).toContainText("仍可能已保存");
          await expect(uncertain).not.toContainText("请按上方提示处理后再生成");
          await expect(jd).toHaveValue("参数校验 <T> &amp;\n未上线");
          await expect(page).toHaveURL(/\/intros$/);
          await uncertain.scrollIntoViewIfNeeded();
          await page.screenshot({ path: testInfo.outputPath(`intro-uncertain-${completion}-${width}.png`) });
          await page.locator(`a[href="/intros/${completedId}"]`).filter({ hasText: "查看演练" }).click();
        }
        await expect(page).toHaveURL(new RegExp(`/intros/${completedId}$`));
        await expect(page.getByText(text, { exact: true })).toBeVisible();
        const saved = await (await request.get(`/api/intros/${completedId}`)).json();
        expect(saved.resume_version_id).toBe(published.id);
        expect(saved.versions.find((v: { kind: string }) => v.kind === "30s").sentences[0].text).toBe(text);
        await page.getByRole("button", { name: "2 分钟版", exact: true }).click();
        await expect(page.getByText(long, { exact: true })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        expect(calls).toBe(2);
        expect(writes).toBe(2);
      } finally {
        release.release();
        provider.closeAllConnections();
        await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
        expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
      }
    });
  }
}
