import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import { publishResume } from "./resume-version-helpers";
import { gate } from "./synthetic-api";

for (const width of [390, 1280]) {
  for (const { command, timeout } of (["save", "comment", "regen"] as const).flatMap(command =>
    [false, true].map(timeout => ({ command, timeout })))) {
    test(`自我介绍 ${command} ${width}px：${timeout ? "408 超时" : "响应丢失"}与连续读取失败后只读恢复，保留草稿与另一版本`, async ({ page, request }, testInfo) => {
      test.setTimeout(90_000);
      const baseline = await exportEncryptedBackup(request);
      expect(baseline.response.ok()).toBe(true);
      const release = gate();
      const original = "我在指导下参与接口校验，尚未上线。";
      const savedText = command === "save" ? "已提交：我仅参与参数校验，结果待验证。" : command === "regen" ? "重新构思：只参与参数校验，尚未上线。" : original;
      const newComment = command === "save" ? "" : "保留个人分工与待验证状态。";
      const replies: unknown[] = [{ versions: [
        { kind: "30s", sentences: [{ text: original, comment: "原点评" }] },
        { kind: "2min", sentences: [{ text: "另一版本保持不变。", comment: "长版点评" }] },
      ] }];
      if (command === "comment") replies.push({ comments: [newComment] });
      if (command === "regen") replies.push({ versions: [{ kind: "30s", sentences: [{ text: savedText, comment: newComment }] }] });
      let modelCalls = 0;
      const provider = createServer(async (incoming, outgoing) => {
        for await (const chunk of incoming) void chunk;
        modelCalls += 1;
        const reply = replies.shift();
        outgoing.writeHead(reply ? 200 : 500, { "Content-Type": "text/event-stream" });
        outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(reply) } }] })}\n\ndata: [DONE]\n\n`);
      });
      await listenForFetch(provider);
      const address = provider.address();
      if (!address || typeof address === "string") throw new Error("Missing provider address");
      try {
        expect((await request.put("/api/settings", { data: {
          base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-intro-recovery-key",
          api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic",
        } })).ok()).toBe(true);
        const resumeResponse = await request.post("/api/resumes", { data: { title: "保存恢复验证" } });
        expect(resumeResponse.status()).toBe(201);
        const resume = await resumeResponse.json();
        const published = await publishResume(request, resume.id);
        const created = await request.post("/api/intros", { data: { resume_id: resume.id, resume_version_id: published.id, jd: "接口校验" } });
        expect(created.status()).toBe(200);
        const match = (await created.text()).match(/event: done\ndata: ([^\n]+)/);
        expect(match).not.toBeNull();
        const { id } = JSON.parse(match![1]!);
        const endpoint = `/api/intros/${id}`;
        const before = await (await request.get(endpoint)).json();
        let saved = false;
        let writes = 0;
        let reads = 0;
        let failures = 2;
        await page.route(`**${endpoint}`, async (route) => {
          if (saved && route.request().method() === "GET") {
            reads += 1;
            if (failures > 0) {
              failures -= 1;
              return route.fulfill({ status: 503, json: { error: "保存结果读取暂时失败" } });
            }
          }
          return route.continue();
        });
        const writePath = command === "save" ? `${endpoint}/versions/30s` : `${endpoint}/${command === "comment" ? "recomment" : "regenerate"}`;
        await page.route(`**${writePath}`, async (route) => {
          writes += 1;
          expect(route.request().method()).toBe(command === "save" ? "PATCH" : "POST");
          const response = await route.fetch();
          expect(response.status()).toBe(200);
          saved = true;
          await release.promise;
          if (timeout) return route.fulfill({ status: 408, json: { error: "写入响应等待超时" } });
          if (command === "comment") return route.fulfill({ status: 200, json: { kind: "2min", revision: "f".repeat(64), sentences: [{ text: "错误版本不能采用", comment: "错误点评" }] } });
          return route.fulfill({ status: 200, contentType: "application/json", body: "{broken" });
        });
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/intros/${id}`);
        await expect(page.getByText(original, { exact: true })).toBeVisible();
        if (command === "save") {
          await page.getByRole("button", { name: "微调", exact: true }).click();
          await page.getByRole("textbox").fill(savedText);
          await page.getByRole("button", { name: "保存修改", exact: true }).click();
          await page.getByRole("textbox").fill("保存期间继续输入的未提交草稿。");
        } else {
          await page.getByRole("button", { name: command === "comment" ? "重新点评整篇" : "重新构思本版", exact: true }).click();
          if (command === "regen") await page.getByRole("dialog").getByRole("button", { name: "确定", exact: true }).click();
        }
        await expect.poll(() => saved).toBe(true);
        expect(writes).toBe(1);
        release.release();
        const error = page.getByRole("alert").filter({ hasText: "保存状态暂无法确认" });
        await expect(error).toContainText("保存结果读取暂时失败");
        if (command === "save") await expect(page.getByRole("textbox")).toHaveValue("保存期间继续输入的未提交草稿。");
        await expect(page.getByRole("button", { name: "重新构思本版", exact: true })).toBeDisabled();
        await expect(page.getByRole("button", { name: "重新点评整篇", exact: true })).toBeDisabled();
        await page.getByRole("button", { name: "2 分钟版", exact: true }).click();
        await expect(error).toBeVisible();
        await page.getByRole("button", { name: "微调", exact: true }).click();
        await page.getByRole("textbox").fill("另一版本尚未提交的新草稿。");
        await expect(page.getByRole("button", { name: "保存修改", exact: true })).toBeDisabled();
        const retry = page.getByRole("button", { name: "重新读取保存状态", exact: true });
        await retry.click();
        await expect(error).toContainText("保存结果读取暂时失败");
        await expect(retry).toBeEnabled();
        expect(reads).toBe(2);
        expect(writes).toBe(1);
        await error.scrollIntoViewIfNeeded();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`intro-${command}-recovery-${width}.png`) });
        await retry.click();
        await expect(page.getByRole("status").filter({ hasText: "已读取30 秒版的最新保存版本" })).toBeVisible();
        await expect(page.getByRole("textbox")).toHaveValue("另一版本尚未提交的新草稿。");
        await expect(page.getByRole("button", { name: "保存修改", exact: true })).toBeEnabled();
        await page.getByRole("button", { name: "30 秒版", exact: true }).click();
        await expect(page.getByText(savedText, { exact: true })).toBeVisible();
        await expect(page.getByText("错误版本不能采用", { exact: true })).toHaveCount(0);
        const after = await (await request.get(endpoint)).json();
        expect(after.versions.find((v: { kind: string }) => v.kind === "30s").sentences).toEqual([{ text: savedText, comment: newComment }]);
        expect(after.versions.find((v: { kind: string }) => v.kind === "2min"))
          .toEqual(before.versions.find((v: { kind: string }) => v.kind === "2min"));
        expect(writes).toBe(1);
        expect(reads).toBe(3);
        expect(modelCalls).toBe(command === "save" ? 1 : 2);
        expect(replies).toHaveLength(0);
        await page.reload();
        await expect(page.getByText(savedText, { exact: true })).toBeVisible();
      } finally {
        release.release();
        provider.closeAllConnections();
        await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
        expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
      }
    });
  }
}
