import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { listenForFetch } from "../support/http-server";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import { publishResume } from "./resume-version-helpers";

for (const width of [390, 1280]) test(`提前结束确认 ${width}px：离页清理、重复点击、焦点和真实报告范围`, async ({ page, request }, testInfo) => {
  test.setTimeout(75_000);
  const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
  const resumeTitle = "完整简历 <T> &amp; " + "后端研发_".repeat(12);
  const draft = "  未提交的结束确认草稿 <T> &amp;\n尚未上线  ";
  const replies: unknown[] = [
    { question: "你实际负责了哪些工作？" },
    { depth: 7, structure: 8, authenticity: 8, completeness: 7, comment: "实际分工明确", next_question: "还有哪些结果待核实？", next_kind: "question" },
    { jd_match: 7, strengths: "仅依据已保存的一题生成报告", weaknesses: "其余问题未考察", suggestions: "补充真实验证记录" },
  ];
  let modelCalls = 0;
  const modelRequests: string[] = [];
  const provider = createServer(async (incoming, outgoing) => {
    let body = ""; for await (const chunk of incoming) body += chunk;
    modelRequests.push(body); modelCalls++;
    const reply = replies.shift();
    outgoing.writeHead(reply ? 200 : 500, { "Content-Type": "text/event-stream" });
    outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(reply) } }] })}\n\ndata: [DONE]\n\n`);
  });
  await listenForFetch(provider);
  const address = provider.address(); if (!address || typeof address === "string") throw new Error("Missing provider address");
  try {
    expect((await request.put("/api/settings", { data: { base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-finish-confirmation-key", api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic" } })).ok()).toBe(true);
    const resumeResponse = await request.post("/api/resumes", { data: { title: resumeTitle } }); expect(resumeResponse.status()).toBe(201);
    const resume = await resumeResponse.json(); const version = await publishResume(request, resume.id);
    const created = await request.post("/api/interviews", { data: { resume_id: resume.id, resume_version_id: version.id, jd: "后端开发", rounds: 4 } });
    const match = (await created.text()).match(/event: done\ndata: ([^\n]+)/); expect(match).not.toBeNull();
    const interview = JSON.parse(match![1]!); const endpoint = `/api/interviews/${interview.id}`;
    const initial = await (await request.get(endpoint)).json();
    const answered = await request.post(`${endpoint}/answer`, { data: { turn_id: initial.turns[0].id, answer: "本人负责接口校验，尚未上线。" } });
    expect(await answered.text()).toContain("event: done");
    const before = await (await request.get(endpoint)).json();
    let writes = 0;
    await page.route(`**${endpoint}**`, async route => { if (route.request().method() === "POST") { writes++; expect(route.request().url()).toMatch(/\/finish$/); } await route.continue(); });
    await page.setViewportSize({ width, height: 900 }); await page.goto(`/interviews/${interview.id}`);
    const trigger = page.getByRole("button", { name: "提前结束并生成总结", exact: true });
    await expect(trigger).toBeEnabled();
    await page.locator('a[href="/"]').first().click(); await expect(page).toHaveURL(/\/$/); await page.goBack();
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "提前结束", exact: true }); await expect(dialog).toBeVisible();
    await page.goForward(); await expect(page).toHaveURL(/\/$/); await expect(dialog).toHaveCount(0);
    expect(writes).toBe(0);
    await page.goBack(); await expect(trigger).toBeEnabled();
    const input = page.getByRole("textbox", { name: "以候选人身份组织作答：", exact: true }); await input.fill(draft);
    // 同步 DOM click 不执行鼠标点击的聚焦步骤，先建立真实触发按钮焦点。
    await trigger.focus();
    await trigger.evaluate(node => { (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click(); });
    await expect(dialog).toBeVisible(); await expect(trigger).toBeEnabled(); await expect(input).toBeDisabled();
    await expect(page.getByRole("button", { name: "提交回答", exact: true })).toBeDisabled();
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
    await expect(input).toHaveValue(draft); await expect(input).toBeEnabled();
    await trigger.click(); await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused(); await expect(input).toHaveValue(draft);
    expect(writes).toBe(0); expect(modelCalls).toBe(2); expect(await (await request.get(endpoint)).json()).toEqual(before);
    await trigger.click();
    for (const text of [`面试 #${interview.id}`, resumeTitle, before.created_at, "已保存 1 题", "未提交草稿", "不会提交或计分"]) await expect(dialog).toContainText(text);
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`finish-confirmation-${width}.png`), animations: "disabled" });
    await dialog.getByRole("button", { name: "结束并生成报告", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("仅依据已保存的一题生成报告", { exact: true })).toBeVisible();
    const after = await (await request.get(endpoint)).json();
    expect(after.status).toBe("finished"); expect(after.turns).toEqual(before.turns);
    expect(after.turns.filter((turn: { answered_at: string }) => turn.answered_at)).toHaveLength(1);
    expect(after.turns[1].answer).toBe(""); expect(after.turns[1].answered_at).toBe("");
    expect(after.resume_version_id).toBe(version.id); expect(after.reverse_interview).toBeNull();
    expect(writes).toBe(1); expect(modelCalls).toBe(3); expect(replies).toHaveLength(0);
    expect(modelRequests[2]).not.toContain("未提交的结束确认草稿");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    await page.goto("/"); provider.closeAllConnections(); await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
  }
});
