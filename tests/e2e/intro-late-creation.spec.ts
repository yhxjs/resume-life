import { listenForFetch } from "../support/http-server";
import { expect, test, type APIResponse } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import { publishResume } from "./resume-version-helpers";
import { gate } from "./synthetic-api";

for (const width of [390, 1280]) for (const failReads of [false, true]) {
  test(`自我介绍晚到存档 ${width}px：${failReads ? "连续读失败" : "暂未保存"}后主动重读，不重发创建或丢草稿`, async ({ page, request }, info) => {
    test.setTimeout(90_000);
    const baseline = await exportEncryptedBackup(request);
    expect(baseline.response.ok()).toBe(true);
    const modelEntered = gate(); const modelRelease = gate(); const historyRelease = gate();
    const originalDraft = "  原请求 <T> &amp;\n尚未上线  ";
    const nextDraft = "  核对期间继续修改的新稿 <T> &amp;\n不可清空  ";
    const text = "我仅参与接口校验，尚未上线。";
    let modelCalls = 0;
    let backend: Promise<{ response?: APIResponse; error?: unknown }> | undefined;
    const provider = createServer(async (incoming, outgoing) => {
      for await (const chunk of incoming) void chunk;
      if (++modelCalls === 2) { modelEntered.release(); await modelRelease.promise; }
      const content = JSON.stringify({ versions: ["30s", "2min"].map(kind => ({ kind, sentences: [{ text, comment: "保留职责与状态限定。" }] })) });
      outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
      outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
    });
    await listenForFetch(provider);
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("Missing provider address");
    try {
      expect((await request.put("/api/settings", { data: {
        base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-intro-late-key",
        api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic",
      } })).ok()).toBe(true);
      const created = await request.post("/api/resumes", { data: { title: "晚到结果核对" } });
      expect(created.status()).toBe(201);
      const resume = await created.json(); const version = await publishResume(request, resume.id);
      const oldCreation = await request.post("/api/intros", { data: { resume_id: resume.id, resume_version_id: version.id, jd: "原有另一份记录" } });
      const oldMatch = (await oldCreation.text()).match(/event: done\ndata: ([^\n]+)/);
      expect(oldMatch).not.toBeNull();
      const oldId = JSON.parse(oldMatch![1]!).id;
      const old = await (await request.get(`/api/intros/${oldId}`)).json();
      let posts = 0; let reads = 0;
      await page.route("**/api/intros**", async route => {
        const path = new URL(route.request().url()).pathname;
        if (path !== "/api/intros") return route.continue();
        if (route.request().method() === "POST") {
          posts++;
          expect(route.request().postDataJSON()).toEqual({ resume_id: resume.id, resume_version_id: version.id, jd: originalDraft.trim() });
          // 独立的实际请求继续等模型；浏览器先收到 408，首次核对还读不到新记录。
          backend = route.fetch({ timeout: 60_000 }).then(response => ({ response }), error => ({ error }));
          await modelEntered.promise;
          return route.fulfill({ status: 408, json: { error: "创建响应等待超时" } });
        }
        if (posts && route.request().method() === "GET") {
          const attempt = ++reads;
          if (attempt === 2) {
            await historyRelease.promise;
            if (failReads) return route.fulfill({ status: 503, json: { error: "历史暂不可读" } });
          }
          if (failReads && attempt === 3) return route.fulfill({ json: { items: [{ ...old, resume_version: null }], nextCursor: null, total: 1 } });
        }
        return route.continue();
      });
      await page.setViewportSize({ width, height: 900 }); await page.goto("/intros");
      await page.getByRole("combobox", { name: "选择参考简历", exact: true }).selectOption(String(resume.id));
      await page.getByRole("combobox", { name: "已发布版本", exact: true }).selectOption(String(version.id));
      const jd = page.getByRole("textbox", { name: "目标岗位要求（JD / 职位描述）", exact: true });
      await jd.fill(originalDraft);
      await page.getByRole("button", { name: "立即生成两版自我介绍", exact: true }).click();
      const feedback = page.getByRole("alert").filter({ hasText: "创建响应等待超时" });
      await expect(feedback).toContainText("仍可能已保存");
      await expect.poll(() => reads).toBe(1);
      const history = page.getByRole("region", { name: "自我介绍历史", exact: true });
      await expect(history.getByRole("article")).toHaveCount(1);
      const reread = feedback.getByRole("button", { name: "重新读取历史", exact: true });
      await expect(reread).toBeVisible();
      await reread.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
      await expect.poll(() => reads).toBe(2);
      await expect(feedback.getByRole("button", { name: "正在读取历史…", exact: true })).toBeDisabled();
      await expect(jd).toBeEnabled(); await jd.fill(nextDraft);
      historyRelease.release();
      if (failReads) {
        const loadError = page.getByRole("alert").filter({ hasText: "自我介绍历史加载失败" });
        await expect(loadError).toContainText("历史暂不可读");
        await reread.click(); await expect(loadError).toContainText("自我介绍历史响应不完整");
        expect(reads).toBe(3);
      } else await expect(history.getByRole("article")).toHaveCount(1);
      await expect(reread).toBeEnabled();
      await expect(feedback).toContainText("即使当前历史没有新记录，也不代表原请求不会稍后保存");
      await expect(page).toHaveURL(/\/intros$/);
      expect(posts).toBe(1); expect(modelCalls).toBe(2);
      modelRelease.release();
      const outcome = await backend!;
      expect(outcome.error).toBeUndefined();
      const match = (await outcome.response!.text()).match(/event: done\ndata: ([^\n]+)/);
      expect(match).not.toBeNull(); const id = JSON.parse(match![1]!).id;
      await reread.click();
      await expect(history.getByRole("article")).toHaveCount(2);
      await expect(history.getByRole("article", { name: `自我介绍 #${id}`, exact: true })).toContainText(originalDraft.trim());
      await expect(jd).toHaveValue(nextDraft);
      await expect(page.getByRole("combobox", { name: "选择参考简历", exact: true })).toHaveValue(String(resume.id));
      await expect(page.getByRole("combobox", { name: "已发布版本", exact: true })).toHaveValue(String(version.id));
      expect(reads).toBe(failReads ? 4 : 3); expect(posts).toBe(1); expect(modelCalls).toBe(2);
      expect(await (await request.get(`/api/intros/${oldId}`)).json()).toEqual(old);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await feedback.scrollIntoViewIfNeeded();
      await page.screenshot({ path: info.outputPath(`intro-late-${width}-${failReads ? "read-failures" : "pending"}.png`), animations: "disabled" });
      await history.getByRole("article", { name: `自我介绍 #${id}`, exact: true }).getByRole("link", { name: "查看演练", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/intros/${id}$`));
      await expect(page.getByText(text, { exact: true })).toBeVisible();
      expect(posts).toBe(1); expect(modelCalls).toBe(2);
    } finally {
      modelRelease.release(); historyRelease.release();
      await backend;
      provider.closeAllConnections();
      await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
      expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
    }
  });
}
