import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import { stripRichText } from "../../src/lib/rich-text";
import { wrapUntrustedData } from "../../src/lib/prompt-safety";

for (const width of [390, 1280]) {
  test(`导入字面量 ${width}px：模型 ID 拒绝后显式重试，证书日期与正文经校对保存仍完整`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000);
    const baseline = await exportEncryptedBackup(request);
    expect(baseline.response.ok()).toBe(true);
    const text = String.raw`维护 Array<T>、<template>、<strong>标签</strong>、&amp; 与 C:\new\resume，未上线。`;
    const raw = {
      title: "技术文本导入核对",
      basic: { name: "合成人物", birthday: "2001.05", age: "" },
      education: [{ school: "合成大学", start: "2023", end: "预计2027", description: text }],
      work: [
        { company: "甲公司", start: "2025.03", end: "至今", descriptionItems: [text], subItems: [
          { label: "技术栈", value: "Map<K, V> &amp;" },
          { label: "团队", value: "仅参与验证" },
        ] },
        { company: "乙公司", descriptionItems: ["乙任务不随甲任务改写"] },
      ],
      projects: [{ name: "合成项目", descriptionItems: [text] }],
      custom: [
        { title: "合成云平台基础认证", subTitle: "示例认证中心", start: "2023年6月", end: "",
          subItems: [{ label: "编号", value: "SYN-001" }], descriptionItems: [text, "仅有证书，未提供熟练程度。"] },
        { title: "合成校园开发赛", subTitle: "团队二等奖", start: "2024年", end: "", descriptionItems: ["本人负责测试。"] },
      ],
      summary: { text }, skills: { items: ["Map<K, V> &amp;"] },
    };
    const source = [text, "出生年月：2001.05，未提供年龄。", "合成大学：2023—预计2027。",
      "甲公司：2025.03—至今，仅参与验证。乙公司：乙任务不随甲任务改写。",
      "2023年6月取得合成云平台基础认证，示例认证中心，编号 SYN-001；仅有证书，未提供熟练程度。",
      "2024年合成校园开发赛，团队二等奖，本人负责测试。"].join("\n");
    let calls = 0;
    const messages: { role: string; content: string }[][] = [];
    const provider = createServer(async (incoming, outgoing) => {
      let body = "";
      for await (const chunk of incoming) body += chunk;
      messages.push(JSON.parse(body).messages);
      calls++;
      // 首次故意违反机器字段协议，不能靠服务端过滤后交付部分草稿。
      const reply = calls === 1 ? { ...raw, education: raw.education.map(entry => ({ ...entry, id: "model-id" })) } : raw;
      outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
      outgoing.write(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(reply) } }] })}\n\n`);
      outgoing.end("data: [DONE]\n\n");
    });
    await listenForFetch(provider);
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("Missing provider address");
    try {
      expect((await request.put("/api/settings", { data: {
        base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-import-key",
        api_format: "openai_chat", model_parse: "synthetic",
      } })).ok()).toBe(true);
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/resumes/import");
      const before = await (await request.get("/api/resumes")).json();
      await page.getByRole("textbox", { name: "简历原文", exact: true }).fill(source);
      const rejectedResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/import/parse");
      await page.getByRole("button", { name: "开始智能解析 →", exact: true }).click();
      const rejected = await rejectedResponse;
      expect(rejected.status()).toBe(502);
      expect((await rejected.json()).extractedText).toBe(source);
      await expect(page.getByRole("main").getByRole("alert")).toContainText("教育经历结构无效");
      await expect(page.getByRole("heading", { name: "确认解析草稿" })).toHaveCount(0);
      await expect(page.getByRole("textbox", { name: "已保留的原文，可直接修改", exact: true })).toHaveValue(source);
      expect(await (await request.get("/api/resumes")).json()).toEqual(before);
      expect(calls).toBe(1);
      const parsedResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/import/parse");
      await page.getByRole("button", { name: "开始智能解析 →", exact: true }).click();
      const response = await parsedResponse;
      const parsed = await response.json();
      expect(response.status(), parsed.error).toBe(200);
      expect(new Set(parsed.modules.work.map((entry: { id: string }) => entry.id)).size).toBe(2);
      expect(parsed.modules.work[0].id).not.toBe("model-id");
      expect(new Set(parsed.modules.work[0].subItems.map((entry: { id: string }) => entry.id)).size).toBe(2);
      expect(new Set(parsed.modules.custom.map((entry: { id: string }) => entry.id)).size).toBe(2);
      expect(parsed.modules.basic).toMatchObject({ birthday: "2001.05", age: "" });
      expect(parsed.modules.education[0]).toMatchObject({ start: "2023", end: "预计2027" });
      expect(parsed.modules.work[0]).toMatchObject({ start: "2025.03", end: "至今" });
      expect(parsed.modules.custom[0]).toMatchObject({ title: "合成云平台基础认证", start: "2023年6月", end: "", subItems: [{ label: "编号", value: "SYN-001" }] });
      expect(parsed.modules.custom[1]).toMatchObject({ title: "合成校园开发赛", subTitle: "团队二等奖", start: "2024年", end: "" });
      for (const name of ["备注", "工作经历描述第 1 行", "项目经历描述第 1 行", "条目描述第 1 行", "自我评价第 1 行"]) {
        const editor = page.getByRole("textbox", { name, exact: true }).first();
        await expect(editor).toHaveText(text);
        await expect(editor.locator("template, strong")).toHaveCount(0);
      }
      const education = page.getByRole("textbox", { name: "备注", exact: true });
      const edited = `${text} 已核对教育备注。`;
      await education.fill(edited);
      await expect(page.getByLabel("导入原文", { exact: true })).toHaveText(source);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await education.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`import-text-${width}.png`) });
      await page.getByRole("button", { name: "确认导入", exact: true }).click();
      await expect(page).toHaveURL(/\/resumes\/\d+$/);
      const id = Number(new URL(page.url()).pathname.split("/").at(-1));
      const savedResponse = await request.get(`/api/resumes/${id}`);
      expect(savedResponse.ok()).toBe(true);
      const saved = await savedResponse.json();
      const content = (type: string) => saved.modules.find((section: { type: string }) => section.type === type).content;
      expect(stripRichText(content("education")[0].description)).toBe(edited);
      expect(content("work")).toEqual(parsed.modules.work);
      expect(content("custom")).toEqual(parsed.modules.custom);
      expect(content("basic")).toMatchObject({ birthday: "2001.05", age: "" });
      expect(content("education")[0]).toMatchObject({ start: "2023", end: "预计2027" });
      expect(stripRichText(content("custom")[0].descriptionItems[1])).toBe("仅有证书，未提供熟练程度。");
      expect(stripRichText(content("custom")[1].descriptionItems[0])).toBe("本人负责测试。");
      expect(content("skills").items).toEqual(raw.skills.items);
      expect(stripRichText(content("projects")[0].description)).toBe(text);
      expect(stripRichText(content("custom")[0].descriptionItems[0])).toBe(text);
      expect(stripRichText(content("summary").text)).toBe(text);
      await page.reload();
      await page.getByRole("tab", { name: "教育经历", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "备注（成绩、荣誉、课程等）", exact: true })).toHaveText(edited);
      await page.getByRole("tab", { name: "工作经历", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "工作经历描述第 1 行", exact: true }).first()).toHaveText(text);
      expect(calls).toBe(2);
      expect(messages).toHaveLength(2);
      for (const input of messages) {
        expect(input[1]!.content).toContain(wrapUntrustedData("resume_source", source));
        expect(input[0]!.content).not.toContain(source);
      }
    } finally {
      provider.closeAllConnections();
      await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
      expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
    }
  });
}
