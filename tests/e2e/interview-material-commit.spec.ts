import { listenForFetch } from "../support/http-server";
import { expect, test, type APIResponse } from "@playwright/test";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { exportEncryptedBackup, postEncryptedBackup, rewriteEncryptedBackup } from "./backup-helpers";
import { publishResume } from "./resume-version-helpers";
import { gate } from "./synthetic-api";

async function done(response: APIResponse) {
  expect(response.status()).toBe(200); const text = await response.text(); expect(text).not.toContain("event: error");
  const match = text.match(/event: done\ndata: ([^\n]+)/); expect(match, text).not.toBeNull(); return JSON.parse(match![1]!);
}
const scores = { depth: 7, structure: 7, authenticity: 8, completeness: 7 };
const summary = { jd_match: 7, strengths: "原候选人总结保留", weaknesses: "结果待核实", suggestions: "核对原始记录" };
const evaluator = {
  recommendation: "Hire", level: "暂无法判断", level_justification: "尚未验证实际交付范围。", summary_for_hr: "依据更正后材料的评估",
  hire_reasons: ["职责边界清楚"], concerns_and_risks: ["验收结果待确认"], placement_suggestion: "进一步核对任务范围。", evidence_quotes: [],
};
for (const width of [390, 1280]) for (const operation of ["retry", "reference", "finish", "evaluator"] as const) {
  test(`面试材料提交 ${operation} ${width}px：拒绝旧结果，保留存档及重答草稿，显式重试读取新材料`, async ({ page, request }, info) => {
    test.setTimeout(90_000);
    const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
    const entered = gate(); const release = gate(); let hold = false; let reply: unknown; let posts = 0; const inputs: string[] = []; const keys: string[] = [];
    const provider = createServer(async (incoming, outgoing) => {
      let raw = ""; for await (const chunk of incoming) raw += chunk; inputs.push(raw);
      if (hold) { hold = false; entered.release(); await release.promise; }
      outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
      outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(reply) } }] })}\n\ndata: [DONE]\n\n`);
    });
    await listenForFetch(provider);
    const address = provider.address(); if (!address || typeof address === "string") throw new Error("Missing provider address");
    const get = async (url: string) => { const response = await request.get(url); expect(response.status(), await response.text()).toBe(200); return response.json(); };
    try {
      expect((await request.put("/api/settings", { data: { base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-material-key", api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic" } })).ok()).toBe(true);
      const sourceResponse = await request.post("/api/resumes", { data: { title: "职业材料", modules: { summary: { text: "原职业材料：仅参与参数校验。" } } } });
      expect(sourceResponse.status()).toBe(201); const source = await sourceResponse.json(); const version = await publishResume(request, source.id);
      reply = { question: "你实际负责哪些校验工作？" };
      const other = await done(await request.post("/api/interviews", { data: { resume_id: source.id, resume_version_id: version.id, jd: "另一岗位", rounds: 1 } }));
      const interview = await done(await request.post("/api/interviews", { data: { resume_id: source.id, resume_version_id: version.id, jd: "参数校验", rounds: 1 } }));
      const endpoint = `/api/interviews/${interview.id}`; const turnId = (await get(endpoint)).turns[0].id;
      reply = { ...scores, comment: "原点评保留", next_kind: "question", next_question: "" };
      await done(await request.post(`${endpoint}/answer`, { data: { turn_id: turnId, answer: "原答：只参与参数校验，尚未上线。" } }));
      if (operation !== "finish") {
        reply = summary; expect((await request.post(`${endpoint}/finish`)).status()).toBe(200);
      }
      if (operation === "retry" || operation === "reference") {
        reply = { reference: "旧原题参考保留" }; expect((await request.post(`${endpoint}/turns/${turnId}/reference`)).status()).toBe(200);
      }
      const seed = await exportEncryptedBackup(request); expect(seed.response.ok()).toBe(true);
      const legacy = await rewriteEncryptedBackup(seed.bytes, records => {
        for (const row of records) if (row.kind === "row" && row.table === "interviews" && row.data.id === interview.id) row.data.resume_version_id = null;
      });
      expect((await postEncryptedBackup(request, "/api/backup/restore", legacy, { preserveAiConfig: true })).status()).toBe(200);
      const favoriteResponse = await request.post("/api/notebook", { data: { source: "interview", source_id: turnId } });
      expect(favoriteResponse.status()).toBe(201); const favorite = await favoriteResponse.json(); const cardId = favorite.review.review_card_id;
      expect((await request.post(`/api/reviews/${cardId}`, { data: { answer: "独立复习原答", grade: "good", expected_review_count: 0, request_id: randomUUID() } })).status()).toBe(200);
      const urls = [endpoint, `/api/interviews/${other.id}`, `/api/notebook/${favorite.id}`, `/api/reviews/${cardId}`]; const before = await Promise.all(urls.map(get));
      const target = operation === "retry" || operation === "reference" ? `${endpoint}/turns/${turnId}/${operation}` : `${endpoint}/${operation === "evaluator" ? "evaluator-report" : "finish"}`;
      await page.route(`**${target}`, route => { posts++; keys.push(route.request().headers()["idempotency-key"] ?? ""); return route.continue(); });
      await page.setViewportSize({ width, height: 900 }); await page.goto(`/interviews/${interview.id}`);
      const card = page.locator(`#turn-${turnId}`); const input = card.getByRole("textbox", { name: /重新作答此题/ });
      const retryAnswer = "本次重答：只参与测试 <T> &amp;。\n尚未交付，验收结果待确认。";
      const action = operation === "retry" ? card.getByRole("button", { name: "提交并重新评分", exact: true })
        : operation === "reference" ? card.getByRole("button", { name: "重新生成", exact: true })
          : operation === "finish" ? page.getByRole("button", { name: "立即生成全景报告", exact: true })
            : page.getByRole("button", { name: "重试生成面试官评估", exact: true });
      if (operation === "retry") { await card.getByRole("button", { name: /重答这一题/ }).click(); await input.fill(retryAnswer); }
      if (operation === "evaluator") await page.getByRole("button", { name: /面试官模拟评估/ }).click();
      const result = operation === "retry" ? { ...scores, comment: "更正材料后的重答点评", reference: "本次重答独立参考" }
        : operation === "reference" ? { reference: "更正材料后的原题参考" }
          : operation === "finish" ? { ...summary, strengths: "更正材料后的候选人总结", evaluator_report: evaluator } : evaluator;
      const seedCalls = inputs.length; reply = result; hold = true;
      const failedResponse = page.waitForResponse(response => response.url().endsWith(target) && response.request().method() === "POST");
      await action.click(); await entered.promise;
      const resume = await get(`/api/resumes/${source.id}`); const summaryModule = resume.modules.find((item: { type: string }) => item.type === "summary"); expect(summaryModule).toBeDefined();
      expect((await request.patch(`/api/resumes/${source.id}`, { data: { modules: { [summaryModule.key]: { text: "更正后的职业材料：仅参与测试，尚未交付。" } }, moduleRevisions: { [summaryModule.key]: summaryModule.revision } } })).status()).toBe(200);
      release.release(); expect((await failedResponse).status()).toBe(409);
      const error = page.getByRole("alert").filter({ hasText: /面试资料|面试状态/ }); await expect(error).toBeVisible(); await expect(action).toBeEnabled();
      if (operation === "retry") { await expect(input).toHaveValue(retryAnswer); await expect(input).toBeEnabled(); }
      expect(await Promise.all(urls.map(get))).toEqual(before); expect(posts).toBe(1); expect(inputs).toHaveLength(seedCalls + 1);
      await error.scrollIntoViewIfNeeded(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`material-conflict-${operation}-${width}.png`), animations: "disabled" });
      const savedResponse = page.waitForResponse(response => response.url().endsWith(target) && response.request().method() === "POST");
      await action.click(); expect((await savedResponse).status()).toBe(200); await expect(error).toHaveCount(0);
      const stored = await get(endpoint); const original = before[0];
      expect(stored.turns).toHaveLength(original.turns.length);
      expect(stored.turns[0]).toEqual({ ...original.turns[0],
        ...(operation === "reference" ? { reference: "更正材料后的原题参考" } : {}),
        ...(operation === "retry" ? { retries: [expect.objectContaining({ answer: retryAnswer, scores, comment: "更正材料后的重答点评", reference: "本次重答独立参考" })] } : {}),
      });
      if (operation === "retry" || operation === "reference") expect({ ...stored, turns: original.turns }).toEqual(original);
      if (operation === "evaluator") expect(stored).toEqual({ ...original, evaluator_report: evaluator });
      if (operation === "finish") { expect(stored.report.strengths).toBe("更正材料后的候选人总结"); expect(stored.evaluator_report).toEqual(evaluator); expect(stored.finished_at).toBeTruthy(); }
      expect(await Promise.all(urls.slice(1).map(get))).toEqual(before.slice(1));
      expect(posts).toBe(2); expect(inputs).toHaveLength(seedCalls + 2); expect(inputs.at(-1)).toContain("更正后的职业材料：仅参与测试，尚未交付。");
      if (operation === "retry") expect(keys[1]).toBe(keys[0]);
    } finally {
      release.release(); provider.closeAllConnections(); await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
      expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
    }
  });
}
