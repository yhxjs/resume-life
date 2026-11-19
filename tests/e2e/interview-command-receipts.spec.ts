import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { listenForFetch } from "../support/http-server";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import { publishResume } from "./resume-version-helpers";

for (const width of [390, 1280]) for (const kind of ["report", "reverse"] as const) for (const damage of ["incomplete", "wrong-owner"] as const) {
  test(`保存回执 ${width}px ${kind} ${damage}：实际保存后坏回包不冒充确认，只读恢复不重复生成`, async ({ page, request }, testInfo) => {
    test.setTimeout(75_000);
    const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
    const question = "  如何核实接口 <T> &amp;\n尚未验证的验收范围？  ";
    const answer = "只负责接口校验，尚未上线。";
    const resultText = kind === "report" ? "回执验证报告：只依据已保存作答" : "模拟答复：实际验收范围仍需核实。";
    const replies: unknown[] = [
      { question: "你个人负责哪些工作？" },
      { depth: 7, structure: 8, authenticity: 8, completeness: 7, comment: "职责明确", next_question: "", next_kind: "question" },
      kind === "report" ? { jd_match: 7, strengths: resultText, weaknesses: "结果待核实", suggestions: "补充依据" }
        : { answer: resultText, evaluation: { score: 8, insight: "关注依据", feedback: "提问具体", suggestions: "向招聘方核实" } },
    ];
    let modelCalls = 0;
    const provider = createServer(async (incoming, outgoing) => {
      for await (const chunk of incoming) void chunk;
      modelCalls++; const reply = replies.shift();
      outgoing.writeHead(reply ? 200 : 500, { "Content-Type": "text/event-stream" });
      outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(reply) } }] })}\n\ndata: [DONE]\n\n`);
    });
    await listenForFetch(provider);
    const address = provider.address(); if (!address || typeof address === "string") throw new Error("Missing provider address");
    try {
      expect((await request.put("/api/settings", { data: { base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-command-receipt-key", api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic" } })).ok()).toBe(true);
      const createdResume = await request.post("/api/resumes", { data: { title: "保存回执验证合成简历" } }); expect(createdResume.status()).toBe(201);
      const resume = await createdResume.json(); const version = await publishResume(request, resume.id);
      const created = await request.post("/api/interviews", { data: { resume_id: resume.id, resume_version_id: version.id, jd: "接口开发", rounds: 1 } });
      const match = (await created.text()).match(/event: done\ndata: ([^\n]+)/); expect(match).not.toBeNull();
      const interview = JSON.parse(match![1]!); const endpoint = `/api/interviews/${interview.id}`;
      const initial = await (await request.get(endpoint)).json();
      const answered = await request.post(`${endpoint}/answer`, { data: { turn_id: initial.turns[0].id, answer } }); expect(await answered.text()).toContain("event: done");
      let posts = 0; let reads = 0; let failures = 0; let saved: unknown;
      await page.route(`**${endpoint}`, async route => {
        reads++;
        if (failures > 0) { failures--; await route.fulfill({ status: 503, json: { error: "回执核对读取暂时失败" } }); }
        else await route.continue();
      });
      await page.route(`**${endpoint}/${kind === "report" ? "finish" : "reverse"}`, async route => {
        posts++;
        if (kind === "reverse") expect(route.request().postDataJSON()).toEqual({ question: question.trim() });
        const response = await route.fetch(); expect(response.status()).toBe(200);
        const receipt = await response.json(); saved = await (await request.get(endpoint)).json(); failures = 2;
        const broken = damage === "wrong-owner" ? { ...receipt, interview_id: interview.id + 1000 }
          : kind === "report" ? { interview_id: interview.id, finished_at: receipt.finished_at, report: {}, evaluator_report: null }
          : { interview_id: interview.id, ok: true, reverse: { question: question.trim() } };
        await route.fulfill({ status: 200, json: broken });
      });
      await page.setViewportSize({ width, height: 900 }); await page.goto(`/interviews/${interview.id}`);
      if (kind === "report") await page.getByRole("button", { name: "立即生成全景报告", exact: true }).click();
      else {
        await page.getByRole("button", { name: /进入反问环节/ }).click();
        const modal = page.getByRole("dialog", { name: "向面试官提问", exact: true });
        await modal.getByRole("textbox", { name: "我的反问问题", exact: true }).fill(question);
        await modal.getByRole("button", { name: "向面试官提问", exact: true }).click();
      }
      const region = kind === "report" ? page.getByRole("main") : page.getByRole("dialog", { name: "向面试官提问", exact: true });
      await expect(region.getByRole("alert")).toContainText("保存状态暂无法确认");
      await expect(region.getByRole("alert")).not.toContainText("已保存，读取结果失败");
      const retry = region.getByRole("button", { name: kind === "report" ? "重新读取面试状态" : "重新读取反问状态", exact: true });
      await expect(retry).toBeEnabled();
      if (kind === "reverse") { await expect(region.getByRole("textbox")).toHaveValue(question); await expect(region.getByRole("textbox")).toBeDisabled(); }
      else await expect(page.getByText(answer, { exact: true })).toBeVisible();
      if (damage === "wrong-owner") {
        await retry.scrollIntoViewIfNeeded();
        const screenshot = { path: testInfo.outputPath(`receipt-unknown-${kind}-${width}.png`) };
        if (kind === "reverse") await region.screenshot(screenshot); else await page.screenshot(screenshot);
      }
      await retry.evaluate(node => { (node as HTMLButtonElement).click(); (node as HTMLButtonElement).click(); });
      await expect(region.getByRole("alert")).toContainText("回执核对读取暂时失败"); await expect(retry).toBeEnabled();
      expect(reads).toBe(3); expect(posts).toBe(1); expect(modelCalls).toBe(3);
      await retry.click(); await expect(page.getByText(resultText, { exact: true })).toBeVisible();
      if (kind === "reverse") await expect(region).toHaveCount(0);
      expect(reads).toBe(4); expect(posts).toBe(1); expect(modelCalls).toBe(3);
      expect(await (await request.get(endpoint)).json()).toEqual(saved);
      await page.reload(); await expect(page.getByText(resultText, { exact: true })).toBeVisible();
      expect(posts).toBe(1); expect(modelCalls).toBe(3); expect(replies).toHaveLength(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    } finally {
      await page.goto("/"); provider.closeAllConnections(); await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
      expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
    }
  });
}
