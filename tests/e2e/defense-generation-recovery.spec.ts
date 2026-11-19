import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import { gate, mockApi } from "./synthetic-api";
import { publishResume } from "./resume-version-helpers";

const quote = "参与接口校验 <T> &amp;\n尚未上线，不是独立负责。";
const role = "岗位_".repeat(65) + " <T> &amp;";

for (const width of [390, 1280]) {
  for (const loseResponse of [false, true]) {
    test(`排雷生成 ${width}px：${loseResponse ? "旧发布版已存档后响应损坏，从历史恢复" : "粘贴原文等待保护，无效输出后显式重试"}`, async ({ page, request }, testInfo) => {
      test.setTimeout(90_000);
      const baseline = await exportEncryptedBackup(request);
      expect(baseline.response.ok()).toBe(true);
      const waiting = gate();
      const result = { risk_level: "medium", overall_roast: "仅凭原文不能确认验证结果，需核对分工与验证范围。", items: [{
        original_text: quote, section_hint: "项目经历", risk_level: "medium", risk_type: "scope_ambiguity",
        interviewer_roast: "请核对个人负责范围和验证情况。", deadly_questions: ["你负责哪些部分？", "如何验证结果？"],
        defense_plan: { interviewer_intent: "核对个人分工", standard_defense: "我参与接口校验，尚未上线，结果待验证。", taboo_mistakes: ["编造职责和数据"] },
      }] };
      let calls = 0;
      let entered = false;
      const provider = createServer(async (incoming, outgoing) => {
        for await (const chunk of incoming) void chunk;
        calls += 1;
        const current = calls;
        entered = true;
        if (current === 1) await waiting.promise;
        const reply = current === 1 && !loseResponse ? { risk_level: "medium", overall_roast: "残缺报告不能存档", items: [] } : result;
        outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
        outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(reply) } }] })}\n\ndata: [DONE]\n\n`);
      });
      await listenForFetch(provider);
      const address = provider.address();
      if (!address || typeof address === "string") throw new Error("Missing provider address");
      try {
        expect((await request.put("/api/settings", { data: {
          base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-defense-generation-key",
          api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic",
        } })).ok()).toBe(true);
        let resumeId: number | null = null;
        let versionId: number | null = null;
        if (loseResponse) {
          const created = await request.post("/api/resumes", { data: { title: "原始履历_".repeat(40), modules: { summary: { text: quote } } } });
          expect(created.status()).toBe(201);
          resumeId = (await created.json()).id;
          versionId = (await publishResume(request, resumeId!, "指定的旧发布版")).id;
          const current = await (await request.get(`/api/resumes/${resumeId}`)).json();
          const summary = current.modules.find((module: { key: string }) => module.key === "summary");
          const changed = await request.patch(`/api/resumes/${resumeId}`, { data: {
            modules: { summary: { text: "不可替代旧版的后发草稿" } }, moduleRevisions: { summary: summary.revision },
            dataGeneration: current.resume.dataGeneration,
          } });
          expect(changed.status(), await changed.text()).toBe(200);
          await publishResume(request, resumeId!, "不能替代的后发版");
        }
        const before = await (await request.get("/api/tools/resume-defenses")).json();
        let writes = 0;
        let savedId = 0;
        let failedRefresh = false;
        await page.route("**/api/tools/resume-defenses", async (route) => {
          if (route.request().method() === "GET") {
            if (loseResponse && savedId > 0 && !failedRefresh) {
              failedRefresh = true;
              return route.fulfill({ status: 503, json: { error: "合成历史读取失败" } });
            }
            return route.continue();
          }
          writes += 1;
          expect(route.request().postDataJSON()).toEqual(loseResponse
            ? { targetRole: role, resumeId, resume_version_id: versionId }
            : { targetRole: role, resumeContent: quote });
          const response = await route.fetch();
          if (response.ok()) {
            savedId = (await response.json()).id;
            if (loseResponse) return route.fulfill({ status: response.status(), json: { id: "损坏的完成 ID" } });
          }
          return route.fulfill({ response });
        });
        await page.setViewportSize({ width, height: 900 });
        await page.goto(loseResponse ? `/tools/defense?resumeId=${resumeId}&resumeVersionId=${versionId}` : "/tools/defense");
        if (!loseResponse) await page.getByRole("button", { name: "自由粘贴文本", exact: true }).click();
        const source = page.getByRole("textbox", { name: "粘贴简历内容或项目片段：", exact: true });
        if (!loseResponse) await source.fill(quote);
        const roleInput = page.getByRole("textbox", { name: "目标应聘岗位 / 级别定位（选填）：", exact: true });
        await roleInput.fill(role);
        if (loseResponse) await expect(page.getByRole("combobox", { name: "已发布版本", exact: true })).toHaveValue(String(versionId));
        await page.getByRole("button", { name: "开始简历排雷扫描", exact: true }).click();
        await expect.poll(() => entered).toBe(true);
        await expect(roleInput).toBeDisabled(); await expect(roleInput).toHaveValue(role);
        for (const name of ["已有简历", "自由粘贴文本", "填入练习样例"]) {
          await expect(page.getByRole("button", { name, exact: true })).toBeDisabled();
        }
        if (loseResponse) {
          await expect(page.getByRole("combobox", { name: "选择要体检排雷的简历", exact: true })).toBeDisabled();
          await expect(page.getByRole("combobox", { name: "已发布版本", exact: true })).toBeDisabled();
        } else { await expect(source).toBeDisabled(); await expect(source).toHaveValue(quote); }
        const status = page.getByRole("status").filter({ hasText: "正在结合全文核对表述依据" });
        await expect(status).toBeVisible();
        await status.scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath(`defense-generation-${width}-${loseResponse}.png`) });
        expect(writes).toBe(1); expect(calls).toBe(1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        waiting.release();
        const error = page.getByRole("alert").filter({ hasText: loseResponse ? "生成响应不完整" : "AI 排雷结果异常" });
        await expect(error).toBeVisible();
        await expect(roleInput).toBeEnabled(); await expect(roleInput).toHaveValue(role);
        await expect(page.getByText(/响应异常时仍可能已保存/)).toBeVisible();
        if (loseResponse) {
          const historyError = page.getByRole("alert").filter({ hasText: "合成历史读取失败" });
          await expect(historyError).toBeVisible();
          await expect(page.getByRole("combobox", { name: "已发布版本", exact: true })).toHaveValue(String(versionId));
          await historyError.getByRole("button", { name: "点击重试", exact: true }).click();
          const history = page.locator(`a[href="/tools/defense/${savedId}"]`);
          await expect(history).toBeVisible();
          const badge = history.getByText("局部表述待补充", { exact: true });
          const positioning = history.getByText("目标定位:", { exact: true });
          const badgeBox = await badge.boundingBox();
          const positioningBox = await positioning.boundingBox();
          const targetBox = await history.getByText(role, { exact: true }).boundingBox();
          expect(badgeBox).not.toBeNull(); expect(positioningBox).not.toBeNull();
          expect(targetBox).not.toBeNull();
          expect(badgeBox!.height).toBeLessThan(36); expect(badgeBox!.width).toBeGreaterThan(60);
          expect(positioningBox!.height).toBeLessThan(30); expect(positioningBox!.width).toBeGreaterThan(40);
          expect(Math.abs(positioningBox!.y - targetBox!.y)).toBeLessThan(4);
          expect(writes).toBe(1); expect(calls).toBe(1);
          await expect(historyError).toHaveCount(0);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          await history.scrollIntoViewIfNeeded();
          await page.screenshot({ path: testInfo.outputPath(`defense-generation-history-${width}.png`) });
          await history.click();
        } else {
          expect(await (await request.get("/api/tools/resume-defenses")).json()).toEqual(before);
          await expect(source).toHaveValue(quote);
          await page.getByRole("button", { name: "开始简历排雷扫描", exact: true }).click();
          await expect.poll(() => savedId).toBeGreaterThan(0);
        }
        await expect(page).toHaveURL(new RegExp(`/tools/defense/${savedId}$`));
        const stored = await request.get(`/api/tools/resume-defenses/${savedId}`);
        expect(stored.status()).toBe(200);
        const { report } = await stored.json();
        expect(report.resumeId).toBe(resumeId); expect(report.resumeVersionId).toBe(versionId);
        expect(report.sourceContent).toContain(quote); expect(report.sourceContent).not.toContain("不可替代旧版的后发草稿");
        if (!loseResponse) expect(report.sourceContent).toBe(quote);
        expect(report.targetRole).toBe(role); expect(report.items[0].originalText).toBe(quote);
        await page.getByText("核对原始引用", { exact: true }).click();
        await expect(page.getByLabel("原始引用", { exact: true })).toHaveText(quote);
        expect(writes).toBe(loseResponse ? 1 : 2); expect(calls).toBe(loseResponse ? 1 : 2);
      } finally {
        waiting.release(); provider.closeAllConnections();
        await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
        expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
      }
    });
  }

  for (const missing of ["resume", "version"]) {
    test(`排雷材料 ${width}px ${missing}：指定材料缺失不替换，晚到重读不覆盖粘贴草稿`, async ({ page }, testInfo) => {
      await mockApi(page);
      const first = { id: 1, title: "不能替代的首份简历", versions: [{ id: 11, version: 1, name: "其他版本" }] };
      const bound = { id: 2, title: "原本指定的简历", versions: [{ id: 21, version: 1, name: "指定旧版" }, { id: 22, version: 2, name: "后发新版" }] };
      const waiting = gate();
      let reads = 0;
      let writes = 0;
      await page.route("**/api/resumes", async (route) => {
        reads += 1;
        if (reads > 1) { await waiting.promise; return route.fulfill({ json: [first, bound] }); }
        return route.fulfill({ json: missing === "resume" ? [first] : [first, { ...bound, versions: [bound.versions[1]] }] });
      });
      await page.route("**/api/tools/resume-defenses", (route) => {
        if (route.request().method() !== "GET") writes += 1;
        return route.fulfill({ json: { items: [] } });
      });
      try {
        await page.setViewportSize({ width, height: 900 });
        await page.goto("/tools/defense?resumeId=2&resumeVersionId=21");
        const warning = page.getByRole("alert").filter({ hasText: missing === "resume" ? "指定或已选的简历不在当前列表中" : "指定或已选的发布版不可用" });
        await expect(warning).toBeVisible();
        await expect(page.getByRole("combobox", { name: "选择要体检排雷的简历", exact: true })).toHaveValue(missing === "resume" ? "" : "2");
        await expect(page.getByRole("button", { name: "开始简历排雷扫描", exact: true })).toBeDisabled();
        if (missing === "version") await expect(page.getByRole("combobox", { name: "已发布版本", exact: true })).toHaveValue("");
        await warning.scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath(`defense-missing-${width}-${missing}.png`) });
        await warning.getByRole("button", { name: "重新读取简历列表", exact: true }).click();
        await expect.poll(() => reads).toBe(2);
        await page.getByRole("button", { name: "自由粘贴文本", exact: true }).click();
        const source = page.getByRole("textbox", { name: "粘贴简历内容或项目片段：", exact: true });
        await source.fill(quote);
        const reloaded = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/resumes");
        waiting.release();
        await (await reloaded).finished();
        // 重读响应到达后仍在粘贴模式，不被 URL 材料强制切回。
        await expect(source).toHaveValue(quote);
        await page.getByRole("button", { name: "已有简历", exact: true }).click();
        await expect(page.getByRole("combobox", { name: "选择要体检排雷的简历", exact: true })).toHaveValue("2");
        await expect(page.getByRole("combobox", { name: "已发布版本", exact: true })).toHaveValue("21");
        await expect(warning).toHaveCount(0);
        await expect(page.getByRole("button", { name: "开始简历排雷扫描", exact: true })).toBeEnabled();
        await page.getByRole("button", { name: "自由粘贴文本", exact: true }).click();
        await expect(source).toHaveValue(quote);
        expect(writes).toBe(0); expect(reads).toBe(2);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      } finally { waiting.release(); }
    });
  }
}
