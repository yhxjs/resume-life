import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { listenForFetch } from "../support/http-server";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import { emptySummary } from "../../src/lib/summary";

const questions = [
  "同步写入的成功响应应该对应什么状态，你会如何验证这一点？",
  "假设请求量增加十倍，如何判断同步写入最先遇到的瓶颈？",
  "假设写入超时但数据库已经提交，如何处理客户端重试？",
  "假设改为异步写入，需要重新约定哪些成功响应的含义？",
  "当前容量尚未验证，你会如何设计一次有代表性的验证？",
];

for (const width of [390, 1280]) test(`摘录下智能推荐选择五题并保存回看 ${width}px`, async ({ page, request }, testInfo) => {
  test.setTimeout(90_000);
  const baseline = await exportEncryptedBackup(request);
  expect(baseline.response.ok()).toBe(true);
  const pending = Promise.withResolvers<void>();
  let modelCalls = 0, modelInput = "";
  const provider = createServer(async (incoming, outgoing) => {
    let body = ""; for await (const chunk of incoming) body += chunk;
    modelCalls++; modelInput = body;
    await pending.promise;
    const raw = JSON.stringify({ questions });
    if (JSON.parse(body).stream) {
      outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
      outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: raw } }] })}\n\ndata: [DONE]\n\n`);
    } else {
      outgoing.writeHead(200, { "Content-Type": "application/json" });
      outgoing.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: raw } }] }));
    }
  });
  await listenForFetch(provider);
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("Missing provider address");
  try {
    expect((await request.put("/api/settings", { data: {
      base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-evidence-recommendation",
      api_format: "openai_chat", model_question: "synthetic",
    } })).ok()).toBe(true);
    const created = await request.post("/api/projects", { data: { name: "订单处理 · 推荐依据深挖" } });
    expect(created.status()).toBe(201);
    const { id } = await created.json();
    const architecture = "订单采用同步写入，数据库提交后返回成功。当前容量尚未验证。";
    expect((await request.patch(`/api/projects/${id}`, { data: { summary: { ...emptySummary(), architecture }, expectedRevisionId: 0 } })).ok()).toBe(true);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/knowledge/${id}`);
    await page.getByLabel("依据来源").selectOption("summary:architecture");
    const panel = page.locator("section").filter({ has: page.getByRole("heading", { name: "指着材料追问" }) });
    const manual = panel.getByRole("button", { name: "手动", exact: true });
    const smart = panel.getByRole("button", { name: "智能推荐", exact: true });
    await expect(manual).toHaveAttribute("aria-pressed", "true");
    await expect(panel.getByLabel("追问方式")).toBeVisible();
    await smart.click();
    await expect(smart).toHaveAttribute("aria-pressed", "true");
    await expect(panel.getByLabel("追问方式")).toHaveCount(0);
    await expect(panel.getByRole("radio")).toHaveCount(5);
    await expect(panel.getByRole("radio", { name: "3 题" })).toBeChecked();
    await panel.getByRole("radio", { name: "5 题" }).locator("..").click();
    const card = panel.locator("div.relative.overflow-hidden");
    await card.scrollIntoViewIfNeeded();
    await card.screenshot({ path: testInfo.outputPath(`smart-recommendation-${width}.png`), animations: "disabled" });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width === 1280) {
      await page.emulateMedia({ colorScheme: "dark" });
      await card.screenshot({ path: testInfo.outputPath("smart-recommendation-dark.png"), animations: "disabled" });
      await page.emulateMedia({ colorScheme: "light" });
    }
    const payload = page.waitForRequest(req => req.url().endsWith(`/projects/${id}/evidence-drill/recommend`) && req.method() === "POST");
    await panel.getByRole("button", { name: "一键生成推荐题" }).click();
    expect((await payload).postDataJSON()).toEqual({ count: 5, startLine: 1, endLine: 1, summaryKey: "architecture", summaryContent: architecture, summaryQuote: architecture });
    await expect.poll(() => modelCalls).toBe(1);
    await expect(manual).toBeDisabled();
    await expect(panel.getByRole("radio", { name: "1 题" })).toBeDisabled();
    await expect(panel.getByRole("button", { name: "正在生成推荐题…" })).toBeDisabled();
    pending.resolve();
    await expect(panel.getByRole("status")).toContainText("已生成并保存 5 道推荐题");
    await expect(panel.getByRole("list", { name: "推荐题目" }).getByRole("listitem")).toHaveCount(5);
    expect(modelInput).toContain(architecture);
    const link = panel.getByRole("link", { name: "开始答辩练习 →" });
    const url = await link.getAttribute("href");
    const detail = await (await request.get(`/api${url}`)).json();
    expect(detail.questions).toHaveLength(5);
    for (const [index, item] of detail.questions.entries()) {
      expect(item.kind).toBe("evidence");
      expect(item.question).toContain("已保存项目档案 · 架构设计");
      expect(item.question).toContain(architecture);
      expect(item.question).toContain(questions[index]);
    }
    await link.click();
    await page.reload();
    await expect(page.getByText(/智能推荐追问/).first()).toBeVisible();
    expect(modelCalls).toBe(1);
  } finally {
    pending.resolve();
    await page.goto("/");
    provider.closeAllConnections();
    await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
  }
});
