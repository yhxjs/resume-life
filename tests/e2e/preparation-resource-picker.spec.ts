import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import type { ApplicationPreparation } from "../../src/lib/application-preparation-types";

for (const width of [390, 1280]) {
  test(`关联资料 ${width}px：分页与关联分别重试，等待中不重复写入或提前关闭`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 900 });
    const baseline = await exportEncryptedBackup(request);
    expect(baseline.response.ok()).toBe(true);
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    let providerCalls = 0;
    const report = {
      role: "合成前端开发",
      must_skills: [{ name: "React", weight: 9, why: "岗位要求" }, { name: "TypeScript", weight: 8, why: "岗位要求" }, { name: "测试", weight: 7, why: "岗位要求" }],
      followups: [{ topic: "组件设计", questions: ["如何划分组件职责？"] }],
      company_style: { style: "工程导向", signals: ["要求自动化测试"] },
    };
    const provider = createServer(async (incoming, outgoing) => {
      let raw = "";
      for await (const chunk of incoming) raw += chunk;
      const body = JSON.parse(raw);
      providerCalls++;
      if (body.stream) {
        outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
        outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(report) } }] })}\n\ndata: [DONE]\n\n`);
      } else {
        outgoing.writeHead(200, { "Content-Type": "application/json" });
        outgoing.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify(report) } }] }));
      }
    });
    await listenForFetch(provider);
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("Missing synthetic provider address");
    const releaseWrite = Promise.withResolvers<void>();
    try {
      expect((await request.put("/api/settings", { data: {
        base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-picker-key", api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic",
      } })).ok()).toBe(true);
      const titles = ["合成候选甲 Array<T>、<template>、&amp;：React、TypeScript 与测试。", "合成候选乙：React、TypeScript 与测试。"];
      const ids: number[] = [];
      for (const jd of titles) {
        const response = await request.post("/api/tools/jd-portraits", { data: { jd } });
        expect(response.status()).toBe(201);
        ids.push((await response.json()).id as number);
      }
      const createApplication = async (company: string) => {
        const response = await request.post("/api/applications", { data: { company, role: "接口开发" } });
        expect(response.status()).toBe(201);
        return (await response.json()).id as number;
      };
      const applicationId = await createApplication(`关联验证${width}`);
      const peerId = await createApplication(`其他投递${width}`);
      const base = `/api/applications/${applicationId}/preparation`;
      let overviewReads = 0;
      page.on("request", (incoming) => {
        const url = new URL(incoming.url());
        if (incoming.method() === "GET" && url.pathname === base) overviewReads++;
      });
      const read = async (id = applicationId) => {
        const response = await request.get(`/api/applications/${id}/preparation`);
        expect(response.ok()).toBe(true);
        return await response.json() as ApplicationPreparation;
      };
      let initialReads = 0;
      const cursors: string[] = [];
      const writes: { kind: string; id: number }[] = [];
      const writeStarted = Promise.withResolvers<void>();
      await page.route(`**${base}/resources**`, async (route) => {
        const incoming = route.request();
        const url = new URL(incoming.url());
        if (incoming.method() === "GET" && url.searchParams.get("candidates") === "true") {
          const cursor = url.searchParams.get("cursor");
          if (cursor) {
            cursors.push(cursor);
            if (cursors.length === 1) return route.fulfill({ status: 503, json: { error: "候选下一页暂不可用" } });
          } else initialReads++;
          // 缩小实际 API 的分页规模，用两份真实记录覆盖下一页恢复。
          url.searchParams.set("limit", "1");
          const response = await route.fetch({ url: url.toString() });
          return route.fulfill({ response });
        }
        if (incoming.method() === "POST") {
          writes.push(incoming.postDataJSON() as { kind: string; id: number });
          // 明确拒绝写入才可直接重试；5xx 的提交结果未知，需要先刷新核对。
          if (writes.length === 1) return route.fulfill({ status: 400, json: { error: "本次关联写入失败" } });
          const response = await route.fetch();
          writeStarted.resolve();
          await releaseWrite.promise;
          return route.fulfill({ response });
        }
        return route.continue();
      });
      await page.goto(`/applications/${applicationId}/prepare`);
      await page.getByRole("button", { name: "关联已有JD 考点画像", exact: true }).click();
      const picker = page.getByRole("dialog", { name: "关联已有JD 考点画像", exact: true });
      await expect(picker.getByRole("heading", { name: titles[1], exact: true })).toBeVisible();
      await picker.getByRole("button", { name: "加载更多", exact: true }).click();
      await expect(picker.getByRole("alert")).toContainText("候选下一页暂不可用");
      await expect(picker.getByRole("alert")).toBeInViewport();
      await picker.getByRole("button", { name: "重试加载更多", exact: true }).click();
      await expect(picker.getByRole("heading", { name: titles[0], exact: true })).toBeVisible();
      await expect(picker.getByRole("heading", { name: titles[1], exact: true })).toBeVisible();
      expect(initialReads).toBe(1);
      expect(overviewReads).toBe(1);
      expect(cursors).toEqual([String(ids[1]), String(ids[1])]);
      expect(writes).toEqual([]);
      const candidate = picker.getByRole("listitem").filter({ has: page.getByRole("heading", { name: titles[0], exact: true }) });
      await candidate.getByRole("button", { name: "关联", exact: true }).click();
      await expect(picker.getByRole("alert")).toContainText("关联失败");
      await expect(picker.getByRole("alert")).toBeFocused();
      await expect(picker.getByRole("alert")).toBeInViewport();
      expect(writes).toEqual([{ kind: "portrait", id: ids[0] }]);
      expect((await read()).resources.portrait.total).toBe(0);
      await page.screenshot({ path: testInfo.outputPath(`picker-link-failure-${width}.png`) });
      await picker.getByRole("button", { name: "重试关联", exact: true }).click();
      await writeStarted.promise;
      await expect(picker.getByRole("button", { name: "关闭", exact: true })).toBeDisabled();
      await expect(candidate.getByRole("button", { name: "关联中…", exact: true })).toBeDisabled();
      await expect(picker.getByRole("status")).toHaveText("正在关联资料，请稍候…");
      await page.keyboard.press("Escape");
      await page.mouse.click(2, 2);
      await expect(picker).toBeVisible();
      expect(writes).toEqual([{ kind: "portrait", id: ids[0] }, { kind: "portrait", id: ids[0] }]);
      expect(initialReads).toBe(1);
      expect(cursors).toHaveLength(2);
      releaseWrite.resolve();
      await expect(picker).toHaveCount(0);
      const associated = page.getByRole("region", { name: "JD 考点画像", exact: true });
      await expect(associated.getByRole("heading", { name: titles[0], exact: true })).toBeVisible();
      expect(overviewReads).toBe(1);
      await associated.scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`picker-linked-${width}.png`) });
      expect((await read()).resources.portrait.items.map((item) => item.id)).toEqual([ids[0]]);
      expect((await read(peerId)).resources.portrait.total).toBe(0);
      await associated.getByRole("button", { name: "取消关联", exact: true }).click();
      await expect(associated).toContainText("暂无JD 考点画像");
      expect(overviewReads).toBe(1);
      expect((await read()).resources.portrait.total).toBe(0);
      const portraits = await request.get("/api/tools/jd-portraits?limit=50");
      expect(portraits.ok()).toBe(true);
      expect((await portraits.json()).items.map((item: { id: number }) => item.id)).toEqual(expect.arrayContaining(ids));
      expect(providerCalls).toBe(2);
      expect(pageErrors).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally {
      releaseWrite.resolve();
      try {
        if (!page.isClosed()) await page.unrouteAll({ behavior: "wait" });
      } finally {
        try { expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true); }
        finally { await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve())); }
      }
    }
  });
}
