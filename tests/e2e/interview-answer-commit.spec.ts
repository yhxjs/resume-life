import { listenForFetch } from "../support/http-server";
import { expect, test, type APIResponse } from "@playwright/test";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { exportEncryptedBackup, postEncryptedBackup, rewriteEncryptedBackup } from "./backup-helpers";
import { publishResume } from "./resume-version-helpers";
import { gate } from "./synthetic-api";

const conflict = "面试资料、当前题目或上下文已变化，请重新读取面试状态后再提交";
async function done(response: APIResponse) {
  expect(response.status()).toBe(200);
  const events = await response.text(); expect(events).not.toContain("event: error");
  const match = events.match(/event: done\ndata: ([^\n]+)/); expect(match, events).not.toBeNull();
  return JSON.parse(match![1]!);
}
for (const width of [390, 1280]) for (const finalTurn of [false, true]) test(`作答材料复核 ${width}px ${finalTurn ? "末题" : "续题"}：旧场次草稿变化拒绝旧评分，保留回答及收藏复习，显式重试用新材料`, async ({ page, request }, info) => {
  test.setTimeout(90_000);
  const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
  const entered = gate(); const release = gate(); let hold = false; let calls = 0; let posts = 0; let reply: unknown; const inputs: string[] = [];
  const provider = createServer(async (incoming, outgoing) => {
    let raw = ""; for await (const chunk of incoming) raw += chunk; inputs.push(raw); calls++;
    if (hold) { hold = false; entered.release(); await release.promise; }
    outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
    outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(reply) } }] })}\n\ndata: [DONE]\n\n`);
  });
  await listenForFetch(provider);
  const address = provider.address(); if (!address || typeof address === "string") throw new Error("Missing provider address");
  const get = async (url: string) => { const response = await request.get(url); expect(response.status(), await response.text()).toBe(200); return response.json(); };
  try {
    expect((await request.put("/api/settings", { data: {
      base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-answer-commit-key", api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic",
    } })).ok()).toBe(true);
    const makeResume = async (title: string) => {
      const response = await request.post("/api/resumes", { data: { title, modules: { summary: { text: `${title}：仅参与接口校验。` } } } });
      expect(response.status()).toBe(201); const resume = await response.json(); return { ...resume, version: await publishResume(request, resume.id) };
    };
    const source = await makeResume("原职业材料"); const otherResume = await makeResume("另一场次材料");
    reply = { question: "请说明另一项实际参与的任务。" };
    const other = await done(await request.post("/api/interviews", { data: { resume_id: otherResume.id, resume_version_id: otherResume.version.id, jd: "另一岗位", rounds: 1 } }));
    reply = { question: "请说明你实际负责的接口工作。" };
    const interview = await done(await request.post("/api/interviews", { data: { resume_id: source.id, resume_version_id: source.version.id, jd: "接口校验", rounds: finalTurn ? 2 : 3 } }));
    const endpoint = `/api/interviews/${interview.id}`;
    const firstId = (await get(endpoint)).turns[0].id;
    const scores = { depth: 7, structure: 7, authenticity: 8, completeness: 7 };
    reply = { ...scores, comment: "第一题原点评。", next_kind: "question", next_question: "你如何核对验证范围？" };
    await done(await request.post(`${endpoint}/answer`, { data: { turn_id: firstId, answer: "第一题原答：仅参与参数校验。" } }));
    const seed = await exportEncryptedBackup(request); expect(seed.response.ok()).toBe(true);
    const legacy = await rewriteEncryptedBackup(seed.bytes, records => {
      for (const row of records) if (row.kind === "row" && row.table === "interviews" && row.data.id === interview.id) row.data.resume_version_id = null;
    });
    expect((await postEncryptedBackup(request, "/api/backup/restore", legacy, { preserveAiConfig: true })).status()).toBe(200);
    const currentId = (await get(endpoint)).turns[1].id;
    const favoriteResponse = await request.post("/api/notebook", { data: { source: "interview", source_id: currentId } });
    expect(favoriteResponse.status()).toBe(201); const favorite = await favoriteResponse.json(); const cardId = favorite.review.review_card_id;
    expect((await request.post(`/api/reviews/${cardId}`, { data: { answer: "独立复习原答", grade: "good", expected_review_count: 0, request_id: randomUUID() } })).status()).toBe(200);
    const urls = [endpoint, `/api/interviews/${other.id}`, `/api/notebook/${favorite.id}`, `/api/reviews/${cardId}`];
    const before = await Promise.all(urls.map(get));
    await page.route(`**${endpoint}/answer`, route => { posts++; return route.continue(); });
    await page.setViewportSize({ width, height: 900 }); await page.goto(`/interviews/${interview.id}`);
    const answer = "本人仅负责参数校验 <T> &amp;。\n验收结论待确认。";
    const input = page.getByRole("textbox", { name: "以候选人身份组织作答：", exact: true }); await input.fill(answer);
    reply = { ...scores, comment: "过期评分_不能展示", next_kind: "question", next_question: finalTurn ? "" : "假设出现字段不兼容，你会如何排查？" }; hold = true;
    await input.press("Control+Enter"); await entered.promise;
    const resume = await get(`/api/resumes/${source.id}`); const summary = resume.modules.find((module: { type: string }) => module.type === "summary");
    expect(summary).toBeDefined();
    expect((await request.patch(`/api/resumes/${source.id}`, { data: { modules: { [summary.key]: { text: "更正后的职业材料：仅参与测试，尚未交付。" } }, moduleRevisions: { [summary.key]: summary.revision } } })).status()).toBe(200);
    release.release();
    const error = page.getByRole("alert").filter({ hasText: conflict }); await expect(error).toBeVisible();
    await expect(input).toHaveValue(answer); await expect(input).toBeEnabled();
    await expect(page.getByText("过期评分_不能展示", { exact: true })).toHaveCount(0);
    expect(await Promise.all(urls.map(get))).toEqual(before); expect(posts).toBe(1); expect(calls).toBe(4);
    await error.scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath(`answer-conflict-${finalTurn ? "final" : "next"}-${width}.png`), animations: "disabled" });
    const comment = "依据更正后材料保存，保留待验收状态。";
    reply = { ...scores, comment, next_kind: "question", next_question: finalTurn ? "" : "假设出现字段不兼容，你会如何排查？" };
    await input.press("Control+Enter"); await expect(error).toHaveCount(0);
    await expect.poll(async () => (await get(endpoint)).turns[1].answer).toBe(answer.trim());
    const stored = await get(endpoint); expect(stored.turns[0]).toEqual(before[0].turns[0]);
    expect(stored.turns[1]).toMatchObject({ id: currentId, answer: answer.trim(), comment, scores });
    expect(stored.turns[1].answered_at).toBeTruthy();
    expect(stored.status).toBe(finalTurn ? "finished" : "ongoing"); expect(stored.turns).toHaveLength(finalTurn ? 2 : 3);
    if (!finalTurn) expect(stored.turns[2]).toMatchObject({ question: "假设出现字段不兼容，你会如何排查？", answer: "", answered_at: "" });
    expect(await get(urls[1]!)).toEqual(before[1]);
    expect(await get(urls[2]!)).toEqual({ ...before[2], answer: answer.trim(), comment });
    expect(await get(urls[3]!)).toEqual({ ...before[3], answer: answer.trim(), comment });
    expect(posts).toBe(2); expect(calls).toBe(5); expect(inputs[4]).toContain("更正后的职业材料：仅参与测试，尚未交付。");
    expect(inputs[4]).toContain("第一题原答：仅参与参数校验。");
  } finally {
    release.release(); provider.closeAllConnections();
    await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
  }
});
