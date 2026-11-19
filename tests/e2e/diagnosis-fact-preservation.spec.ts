import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { stripRichText } from "../../src/lib/rich-text";
import { listenForFetch } from "../support/http-server";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import { publishResume } from "./resume-version-helpers";

for (const type of ["work", "projects"] as const) {
  for (const width of [390, 1280]) {
    test(`诊断事实保留 ${type}/${width}px：采纳及刷新保留标题限定和技术字面量`, async ({ page, request }, testInfo) => {
      test.setTimeout(60_000);
      const baseline = await exportEncryptedBackup(request);
      expect(baseline.response.ok()).toBe(true);
      const identity = type === "work" ? { company: "示例公司", title: "验证工程师" } : { name: "接口工具", role: "验证工程师" };
      const header = type === "work" ? "# 公司：示例公司 职位：验证工程师" : "# 项目名称：接口工具 角色：验证工程师";
      const lines = [
        "## 只参与接口校验，尚未上线。",
        "角色：在指导下验证接口，未负责架构。",
        "*ptr 仅用于校验 C#、Array<T>、<template> 与 &amp; 字面量。",
        "--dry-run 只用于测试，尚未上线。",
        "### 时间：仅测试两周，结果未统计。",
      ];
      const draft = [header, ...lines].join("\n");
      let assessed: { key: string }[] = [];
      let targetId = "";
      const provider = createServer(async (incoming, outgoing) => {
        for await (const chunk of incoming) void chunk;
        const result = {
          match: 6, summary: "请核对原始事实", modules: assessed.map(({ key }) => ({
            module_key: key, scores: { depth: 6, structure: 6, authenticity: 7, completeness: 6 }, gaps: "保留职责和进度限定",
            suggestions: key === type ? [{ item_id: targetId, field: "description", reason: "整理原始事实", draft }] : [],
          })),
        };
        outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
        outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(result) } }] })}\n\ndata: [DONE]\n\n`);
      });
      await listenForFetch(provider);
      const address = provider.address();
      if (!address || typeof address === "string") throw new Error("Missing provider address");
      try {
        expect((await request.put("/api/settings", { data: {
          base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-facts-key", api_format: "openai_chat", model_evaluate: "synthetic",
        } })).ok()).toBe(true);
        const created = await request.post("/api/resumes", { data: {
          title: `诊断事实保留 ${type}`, modules: { [type]: [
            { ...identity, description: "只参与接口校验，尚未上线。在指导下验证接口，未负责架构。维护 C# 与泛型文档，仅测试两周，结果未统计。" },
            { ...identity, description: "其他经历保持不变" },
          ] },
        } });
        expect(created.status()).toBe(201);
        const { id } = await created.json();
        const version = await publishResume(request, id, "事实保留来源版本");
        assessed = version.snapshot.modules.filter(entry => entry.type !== "basic");
        targetId = (version.snapshot.modules.find(entry => entry.key === type)!.content as { id: string }[])[0]!.id;
        const endpoint = `/api/resumes/${id}/diagnose`;
        const generated = await request.post(endpoint, { data: { jd: "接口验证岗位", resume_version_id: version.id } });
        expect(generated.status(), await generated.text()).toBe(200);
        const diagnosis = (await generated.json()).current;
        const before = await (await request.get(`/api/resumes/${id}`)).json();
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(`/resumes/${id}?diagnosisId=${diagnosis.id}`);
        const dialog = page.getByRole("dialog", { name: "对 JD 体检诊断简历" });
        for (const [index, line] of [header, ...lines].entries()) {
          await expect(dialog.getByRole("textbox", { name: `改写草稿第 ${index + 1} 行`, exact: true })).toHaveText(line);
        }
        await dialog.getByRole("button", { name: "采纳写入", exact: true }).click();
        await expect(dialog.getByText(/已采纳写入 · 当前保留/)).toBeVisible();
        const after = await (await request.get(`/api/resumes/${id}`)).json();
        const savedModule = after.modules.find((entry: { key: string }) => entry.key === type);
        expect(savedModule.content[0].descriptionItems.map(stripRichText)).toEqual(lines);
        expect(stripRichText(savedModule.content[0].description)).toBe(lines.join("\n"));
        expect(savedModule.content[1]).toEqual(before.modules.find((entry: { key: string }) => entry.key === type).content[1]);
        expect(after.modules.filter((entry: { key: string }) => entry.key !== type)).toEqual(before.modules.filter((entry: { key: string }) => entry.key !== type));
        const recorded = (await (await request.get(`${endpoint}?diagnosis_id=${diagnosis.id}`)).json()).current;
        expect(recorded.adoptions).toHaveLength(1);
        expect(stripRichText(recorded.adoptions[0].value)).toBe(lines.join("\n"));
        expect(recorded.resume_snapshot).toEqual(diagnosis.resume_snapshot);
        expect((await (await request.get(`/api/resumes/${id}/versions/${version.id}`)).json()).snapshot).toEqual(version.snapshot);
        await page.reload();
        await expect(dialog.getByText(/已采纳写入 · 当前保留/)).toBeVisible();
        const adoptedDraft = dialog.getByText("改写草稿（已采纳，显示当时写入内容）", { exact: true }).locator("..");
        for (const line of lines) await expect(adoptedDraft).toContainText(line);
        await adoptedDraft.scrollIntoViewIfNeeded();
        await page.screenshot({ path: testInfo.outputPath(`diagnosis-facts-${type}-${width}.png`), animations: "disabled" });
      } finally {
        await page.goto("/");
        provider.closeAllConnections();
        await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
        expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
      }
    });
  }
}
