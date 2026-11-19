import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";

for (const width of [390, 1280]) {
  test(`文件解析恢复 ${width}px：坏成功响应保留原文，重试使用修改稿且只提取一次文件`, async ({ page, request }, testInfo) => {
    const baseline = await exportEncryptedBackup(request);
    expect(baseline.response.ok()).toBe(true);
    let calls = 0;
    const provider = createServer(async (incoming, outgoing) => {
      for await (const chunk of incoming) void chunk;
      calls++;
      outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
      outgoing.write(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify({
        title: "解析恢复核对", basic: { name: "合成人物" },
      }) } }] })}\n\n`);
      outgoing.end("data: [DONE]\n\n");
    });
    await listenForFetch(provider);
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("Missing provider address");
    try {
      expect((await request.put("/api/settings", { data: {
        base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-import-recovery-key",
        api_format: "openai_chat", model_parse: "synthetic",
      } })).ok()).toBe(true);
      const before = await (await request.get("/api/resumes")).json();
      let extracts = 0;
      const submitted: string[] = [];
      await page.route("**/api/import/parse", async (route) => {
        if (route.request().headers()["content-type"]?.startsWith("multipart/form-data")) {
          extracts++;
          return route.continue();
        }
        submitted.push(route.request().postDataJSON().text);
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        if (submitted.length === 1) {
          const data = await response.json();
          return route.fulfill({ response, json: { ...data, modules: { ...data.modules, skills: { items: "错误列表" } } } });
        }
        return route.fulfill({ response });
      });
      const original = String.raw`旧文件原文 Array<T> &amp; C:\new\resume，未上线。`;
      const edited = `${original}\n已修改：只参与验证，尚未统计收益。`;
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/resumes/import");
      await page.getByRole("tab", { name: /上传文件/ }).click();
      await page.locator('input[type="file"]').setInputFiles({ name: "resume.txt", mimeType: "text/plain", buffer: Buffer.from(original) });
      await page.getByRole("button", { name: "开始智能解析 →", exact: true }).click();
      await expect(page.getByRole("main").getByRole("alert")).toContainText("AI 解析响应不完整");
      await expect(page.getByRole("heading", { name: "确认解析草稿" })).toHaveCount(0);
      const recovered = page.getByRole("textbox", { name: "已保留的原文，可直接修改", exact: true });
      await expect(recovered).toHaveValue(original);
      await recovered.fill("");
      await expect(page.getByRole("button", { name: "开始智能解析 →", exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: "手工整理并继续导入", exact: true })).toBeDisabled();
      await recovered.fill(edited);
      await page.getByRole("tab", { name: /上传文件/ }).click();
      await expect(recovered).toHaveValue(edited);
      await page.reload();
      await expect(recovered).toHaveValue(edited);
      await expect(page.getByRole("status").filter({ hasText: "已恢复当前标签页的导入草稿" })).toBeVisible();
      expect(extracts).toBe(1); expect(calls).toBe(1);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await recovered.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`import-parse-recovery-${width}.png`) });
      await page.getByRole("button", { name: "开始智能解析 →", exact: true }).click();
      await expect(page.getByRole("heading", { name: "确认解析草稿" })).toBeVisible();
      await expect(page.getByLabel("导入原文", { exact: true })).toHaveText(edited);
      expect(submitted).toEqual([original, edited]);
      expect(extracts).toBe(1);
      expect(calls).toBe(2);
      expect(await (await request.get("/api/resumes")).json()).toEqual(before);
      await page.getByRole("button", { name: "返回重新解析", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "已保留的原文，可直接修改", exact: true })).toHaveValue(edited);
    } finally {
      provider.closeAllConnections();
      await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
      expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
    }
  });
}
