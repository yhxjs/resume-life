import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import { publishResume } from "./resume-version-helpers";

for (const width of [390, 1280]) {
  test(`模拟报告 ${width}px：提前结束按已答题统计，评估与挖掘保留事实局限`, async ({ page, request }, testInfo) => {
    test.setTimeout(90_000);
    const baseline = await exportEncryptedBackup(request);
    expect(baseline.response.ok()).toBe(true);
    const longText = "Unverified".repeat(90);
    const level = "Unknown".repeat(14);
    const projectName = "InterfaceValidation".repeat(10);
    const replies: unknown[] = [
      { question: "你实际参与了哪些工作？" },
      { depth: 7, structure: 8, authenticity: 8, completeness: 7, comment: "职责范围明确", next_question: "目前如何验证结果？", next_kind: "question" },
      { jd_match: 7, strengths: "只参与参数校验", weaknesses: "设计能力未考察", suggestions: longText,
        mining_summary: { project_name: projectName, background: "维护已有接口", actions: "参与参数校验", tradeoffs: "未参与选型",
          results: "尚未上线，未统计收益", contribution: "仅负责校验", pending_confirmations: [], resume_bullets: ["参与接口参数校验，尚未上线。"] },
        evaluator_report: { recommendation: "Lean No", level, level_justification: "证据不足，暂无法判断；非官方定级。",
          summary_for_hr: longText, hire_reasons: [], concerns_and_risks: [], placement_suggestion: "进一步考察设计能力", evidence_quotes: [] } },
    ];
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
    if (!address || typeof address === "string") throw new Error("Missing synthetic provider address");
    try {
      expect((await request.put("/api/settings", { data: {
        base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-report-boundaries-key",
        api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic",
      } })).ok()).toBe(true);
      const resumeResponse = await request.post("/api/resumes", { data: { title: "模拟报告边界合成简历" } });
      expect(resumeResponse.status()).toBe(201);
      const resume = await resumeResponse.json();
      const version = await publishResume(request, resume.id);
      const created = await request.post("/api/interviews", { data: {
        resume_id: resume.id, resume_version_id: version.id, jd: "接口维护与校验", style: "mining", rounds: 30,
      } });
      expect(created.status()).toBe(200);
      const match = (await created.text()).match(/event: done\ndata: ([^\n]+)/);
      expect(match).not.toBeNull();
      const interview = JSON.parse(match![1]!);
      const endpoint = `/api/interviews/${interview.id}`;
      const initial = await (await request.get(endpoint)).json();
      const answer = await request.post(`${endpoint}/answer`, { data: { turn_id: initial.turns[0].id, answer: "仅参与校验，尚未上线。" } });
      expect(await answer.text()).toContain("event: done");
      const finish = await request.post(`${endpoint}/finish`);
      expect(finish.status(), await finish.text()).toBe(200);
      const saved = await (await request.get(endpoint)).json();
      expect(saved.turns.filter((turn: { answered_at: string }) => turn.answered_at)).toHaveLength(1);
      expect(saved.turns).toHaveLength(2);
      expect(saved.evaluator_report.level).toBe(level);
      expect(saved.report.mining_summary.results).toBe("尚未上线，未统计收益");

      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/interviews/${interview.id}`);
      await expect(page.getByText(/根据本场已作答的 1 题/)).toBeVisible();
      const noOverflow = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await noOverflow();
      const evaluatorTab = page.getByRole("button", { name: /面试官模拟评估/ });
      await expect(evaluatorTab).toBeInViewport();
      await evaluatorTab.click();
      await expect(evaluatorTab).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByText(/不代表真实公司的录用决定或官方职级认定/)).toBeVisible();
      await expect(page.getByText("本报告未提供具体风险观察，仍需进一步考察")).toBeVisible();
      const summary = page.getByText(longText, { exact: true });
      await expect(summary).toBeVisible();
      expect(await summary.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await noOverflow();
      await page.getByText("面试官模拟评估与职级参考", { exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`evaluator-${width}.png`), fullPage: true });
      await page.getByRole("button", { name: /经历挖掘全景与产物/ }).click();
      await expect(page.getByText("尚未上线，未统计收益", { exact: true })).toBeVisible();
      await expect(page.getByText("📈 已知结果与验证状态 (Result)", { exact: true })).toBeVisible();
      await expect(page.getByText("👤 个人分工与参与范围 (Personal Contribution)", { exact: true })).toBeVisible();
      await noOverflow();
      await page.getByText("经历深度挖掘档案", { exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`mining-${width}.png`), fullPage: true });
      expect(modelCalls).toBe(3);
      expect(replies).toHaveLength(0);
    } finally {
      provider.closeAllConnections();
      await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
      expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
    }
  });
}
