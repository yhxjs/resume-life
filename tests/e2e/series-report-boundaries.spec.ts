import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup, rewriteEncryptedBackup } from "./backup-helpers";
import { publishResume } from "./resume-version-helpers";
import { SERIES_REPORT_TEXT_LIMIT } from "../../src/lib/series";

for (const width of [390, 1280]) {
  test(`跨轮总评 ${width}px：超限拒绝、边界全文展示与历史损坏重生成`, async ({ page, request }, testInfo) => {
    test.setTimeout(120_000);
    const baseline = await exportEncryptedBackup(request);
    expect(baseline.response.ok()).toBe(true);
    const suffix = "\n尚未上线<T>&amp;";
    const verdict = "V".repeat(SERIES_REPORT_TEXT_LIMIT - suffix.length) + suffix;
    const finalReport = { verdict, strengths: "只说明了个人实际参与的接口校验", weaknesses: "上线结果尚待核实", suggestions: "核实验证范围" };
    const repaired = { ...finalReport, verdict: "修复后的总评：依据三轮报告整理，尚未上线。" };
    const replies: unknown[] = [];
    for (let round = 1; round <= 3; round += 1) {
      replies.push(
        { question: `第${round}轮：请说明本次任务的一个实际参与环节。` },
        { depth: 7, structure: 8, authenticity: 8, completeness: 7, comment: "分工明确", next_question: "", next_kind: "question" },
        { jd_match: 7, strengths: "职责明确", weaknesses: "上线结果尚待核实", suggestions: "核实验证范围" },
      );
    }
    replies.push({ ...finalReport, verdict: "X".repeat(SERIES_REPORT_TEXT_LIMIT + 1) }, finalReport, repaired);
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
        base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-series-boundaries-key",
        api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic",
      } })).ok()).toBe(true);
      const resumeResponse = await request.post("/api/resumes", { data: { title: "履历".repeat(60) } });
      expect(resumeResponse.status()).toBe(201);
      const resume = await resumeResponse.json();
      const version = await publishResume(request, resume.id);
      const created = await request.post("/api/interviews", { data: {
        resume_id: resume.id, resume_version_id: version.id, jd: "接口维护", mode: "series", rounds: 1,
      } });
      expect(created.status()).toBe(200);
      const match = (await created.text()).match(/event: done\ndata: ([^\n]+)/);
      expect(match).not.toBeNull();
      const interview = JSON.parse(match![1]!);
      const endpoint = `/api/interviews/series/${interview.series_id}`;
      let interviewId = interview.id;
      for (let round = 1; round <= 3; round += 1) {
        const initial = await (await request.get(`/api/interviews/${interviewId}`)).json();
        const answer = await request.post(`/api/interviews/${interviewId}/answer`, { data: { turn_id: initial.turns[0].id, answer: "只参与参数校验，尚未上线。" } });
        expect(await answer.text()).toContain("event: done");
        expect((await request.post(`/api/interviews/${interviewId}/finish`)).status()).toBe(200);
        if (round < 3) {
          const advance = await request.post(`${endpoint}/advance`, { data: { from_interview_id: interviewId } });
          expect(advance.status()).toBe(201);
          interviewId = (await advance.json()).id;
        }
      }
      const before = await (await request.get(endpoint)).json();
      expect(before.entries).toHaveLength(3);
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/interviews/series/${interview.series_id}`);
      const generate = page.getByRole("button", { name: "一键生成跨轮总评 🏆", exact: true });
      await generate.click();
      const error = page.getByRole("alert").filter({ hasText: "AI 总评结果异常" });
      await expect(error).toContainText(`各不超过 ${SERIES_REPORT_TEXT_LIMIT} 字符`);
      const rejected = await (await request.get(endpoint)).json();
      expect(rejected.final_report).toBeNull();
      expect(rejected.status).toBe("ongoing");
      expect(rejected.entries).toEqual(before.entries);
      await generate.click();
      const output = page.getByText(verdict, { exact: true });
      await expect(output).toBeVisible();
      expect(await output.evaluate((element) => element.textContent)).toBe(verdict);
      expect(await output.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
      await expect(page.getByText(/模拟练习完成 \/ 已出跨轮总评/)).toBeVisible();
      await expect(page.getByText(/各轮题目和侧重点不同，分数不宜直接比较/)).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`series-report-${width}.png`), fullPage: true });
      const saved = await (await request.get(endpoint)).json();
      expect(saved.final_report).toEqual({ ...finalReport, overall: 7.4 });
      expect(saved.entries).toEqual(before.entries);

      // 模拟存储结构合法、正文不完整的历史备份；恢复到本次测试独立数据库。
      const exported = await exportEncryptedBackup(request);
      expect(exported.response.ok()).toBe(true);
      const damaged = await rewriteEncryptedBackup(exported.bytes, (records) => {
        const row = records.find((record) => record.kind === "row" && record.table === "interview_series" && record.data.id === interview.series_id);
        expect(row?.kind).toBe("row");
        if (row?.kind === "row") row.data.final_report = JSON.stringify({ ...finalReport, overall: 7.4, verdict: "" });
      });
      const restored = await postEncryptedBackup(request, "/api/backup/restore", damaged, { preserveAiConfig: true });
      expect(restored.status(), await restored.text()).toBe(200);
      await page.reload();
      await expect(page.getByText("● 跨轮总评待补全", { exact: true })).toBeVisible();
      await expect(page.getByText(/连打通关/)).toHaveCount(0);
      await expect(generate).toBeEnabled();
      await generate.click();
      await expect(page.getByText(repaired.verdict, { exact: true })).toBeVisible();
      await page.reload();
      await expect(page.getByText(repaired.verdict, { exact: true })).toBeVisible();
      const after = await (await request.get(endpoint)).json();
      expect(after.final_report).toEqual({ ...repaired, overall: 7.4 });
      expect(after.entries).toEqual(before.entries);
      expect(modelCalls).toBe(12);
      expect(replies).toHaveLength(0);
    } finally {
      provider.closeAllConnections();
      await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
      expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
    }
  });
}
