import { createServer } from "node:http";
import { expect, test } from "@playwright/test";
import { listenForFetch } from "../support/http-server";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import { publishResume } from "./resume-version-helpers";

const scenario = (question: string) => ({
  label: "细节待核实", predicted_answer: "我参与了接口校验，具体检查内容仍需核对记录。", followup_question: question,
});
const initial = {
  question: "请说明你参与接口校验时的实际职责。",
  branches: [scenario("你检查了哪些输入条件？"), scenario("你能回忆一次具体的联调操作吗？")],
};
const expand = (questionId: string, questions: string[]) => ({
  expansions: [{ question_id: questionId, branches: questions.map(scenario) }],
});
const predict = (questionId: string) => ({ predictions: [{ question_id: questionId, answers: [
  { label: "回答具体且有依据", predicted_answer: "我会依据当时的检查记录说明步骤，具体范围待核实。" },
  { label: "回答概括或信息不足", predicted_answer: "我需要先核对记录，再补充实际细节。" },
] }] });

for (const width of [390, 1280]) {
  test(`题目图谱 ${width}px：预测第三层回答、拒绝重复并保留历史回退`, async ({ page, request }, info) => {
    test.setTimeout(90_000);
    const baseline = await exportEncryptedBackup(request);
    expect(baseline.response.ok()).toBe(true);
    const regenerated = { ...initial, question: "请介绍你在接口联调中负责的一项任务。" };
    const replies = [
      initial,
      expand("q2-1", [initial.branches[1]!.followup_question, "检查输入来自哪里？"]),
      expand("q2-1", ["你如何选择检查输入？", "你在哪里记录检查结果？"]),
      expand("q2-2", ["这次联调的目标是什么？", "你如何核对联调的实际状态？"]),
      predict("q3-q2-1-1"),
      { ...initial, branches: [initial.branches[0], initial.branches[0]] },
      regenerated,
      expand("q2-1", ["你会如何验证这项工作的结果？", "哪些记录可以说明实际范围？"]),
    ];
    let calls = 0;
    const provider = createServer(async (incoming, outgoing) => {
      for await (const chunk of incoming) void chunk;
      const reply = replies[calls++];
      outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
      outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(reply ?? {}) } }] })}\n\ndata: [DONE]\n\n`);
    });
    await listenForFetch(provider);
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("Missing provider address");
    try {
      expect((await request.put("/api/settings", { data: {
        base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-question-graph-key",
        api_format: "openai_chat", model_question: "synthetic",
      } })).ok()).toBe(true);
      const created = await request.post("/api/resumes", { data: {
        title: "图谱合成简历", modules: { summary: { text: "参与接口校验和联调，尚未上线。" } },
      } });
      expect(created.status()).toBe(201);
      const resume = await created.json();
      const version = await publishResume(request, resume.id);
      const jd = "接口校验岗位，实际职责与结果待确认。";
      const applicationResponse = await request.post("/api/applications", { data: {
        company: "图谱合成公司", role: "接口校验", resume_id: resume.id, resume_version_id: version.id, jd,
      } });
      expect(applicationResponse.status()).toBe(201);
      const application = await applicationResponse.json();
      const beforeSingles = await (await request.get("/api/interviews")).json();
      const beforeSeries = await (await request.get("/api/interviews/series")).json();
      const bodies: Record<string, unknown>[] = [];
      await page.route("**/api/interviews/question-graph", route => {
        bodies.push(route.request().postDataJSON());
        return route.continue();
      });
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/interviews?applicationId=${application.id}`);
      await expect(page.getByText(/结果会自动加入投递准备页/)).toBeVisible();
      await page.getByRole("button", { name: "面试官视角", exact: true }).click();
      await page.waitForURL("**/interviews/question-graphs");
      await expect(page.getByRole("heading", { name: "面试题目图谱", exact: true }).first()).toBeVisible();
      await expect(page.getByLabel("参考简历")).toHaveValue(String(resume.id));
      await expect(page.getByLabel("岗位要求（JD）")).toHaveValue(jd);
      await expect(page.getByLabel("总题数")).toHaveCount(0);
      await page.getByRole("button", { name: "一键生成题目图谱", exact: true }).click();
      const graph = page.getByRole("region", { name: "面试题目图谱", exact: true });
      const alert = graph.getByRole("alert");
      const region = page.getByRole("region", { name: "模拟面试问题图谱", exact: true });
      await expect(region.locator("[data-graph-question]")).toHaveCount(3);
      expect(bodies[0]).toEqual({ action: "start", resume_id: resume.id, resume_version_id: version.id, jd, style: "gentle" });

      const firstBranch = page.getByRole("button", { name: `为“${initial.branches[0]!.followup_question}”生成分支`, exact: true });
      await firstBranch.click();
      await expect(region.locator("[data-graph-question]")).toHaveCount(5);
      await expect(alert).toHaveCount(0);
      await expect(region.getByText(initial.branches[1]!.followup_question, { exact: true })).toHaveCount(1);
      await page.getByRole("button", { name: `为“${initial.branches[1]!.followup_question}”生成分支`, exact: true }).click();
      await expect(region.locator("[data-graph-question]")).toHaveCount(7);
      await expect(region.getByRole("button", { name: /生成预测回答/ })).toHaveCount(4);
      await expect(alert).toHaveCount(0);
      await page.getByRole("button", { name: '为“你如何选择检查输入？”生成预测回答', exact: true }).click();
      await expect(region.getByText("我会依据当时的检查记录说明步骤，具体范围待核实。", { exact: true })).toBeVisible();
      await expect(region.getByText("预测回答已生成 · 可重新生成", { exact: true })).toBeVisible();
      expect(calls).toBe(5);
      await region.scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`question-graph-${width}.png`), fullPage: true, animations: "disabled" });
      await page.getByRole("button", { name: "撤销上一步", exact: true }).click();
      await expect(region.getByRole("button", { name: /生成预测回答/ })).toHaveCount(4);
      await expect(region.getByText("我会依据当时的检查记录说明步骤，具体范围待核实。", { exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "撤销上一步", exact: true }).click();
      await expect(region.locator("[data-graph-question]")).toHaveCount(5);
      await expect(page.getByRole("button", { name: "撤销上一步", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "撤销上一步", exact: true }).click();
      await expect(region.locator("[data-graph-question]")).toHaveCount(3);

      await page.getByLabel("考官风格").selectOption("deep");
      await expect(page.getByRole("status").filter({ hasText: "当前简历、JD 或面试官风格已变化" })).toBeVisible();
      const regenerate = page.getByRole("button", { name: "重新生成图谱", exact: true });
      await regenerate.click();
      await expect(region.locator("[data-graph-question]")).toHaveCount(3);
      await expect(region.getByText(regenerated.question, { exact: true })).toBeVisible();
      await expect(alert).toHaveCount(0);
      await expect(page.getByRole("status").filter({ hasText: "当前简历、JD 或面试官风格已变化" })).toHaveCount(0);
      expect(calls).toBe(7);
      expect(await (await request.get("/api/interviews")).json()).toEqual(beforeSingles);
      expect(await (await request.get("/api/interviews/series")).json()).toEqual(beforeSeries);

      const savedGraphs = await (await request.get("/api/interviews/question-graphs?limit=10")).json();
      expect(savedGraphs.total).toBe(2);
      expect(savedGraphs.items[0]?.question).toBe(regenerated.question);
      await page.goto("/interviews/question-graphs");
      await expect(page.getByRole("heading", { name: "面试题目图谱", exact: true }).first()).toBeVisible();
      const history = page.getByRole("complementary", { name: "历史记录" });
      await expect(history.getByText(regenerated.question, { exact: true })).toBeVisible();
      await history.getByRole("button", { name: "载入此图谱", exact: true }).first().click();
      const savedGraphRegion = page.getByRole("region", { name: "模拟面试问题图谱", exact: true });
      await expect(savedGraphRegion.getByText(regenerated.question, { exact: true })).toBeVisible();
      await page.getByRole("button", { name: `为“${initial.branches[0]!.followup_question}”生成分支`, exact: true }).click();
      await expect(savedGraphRegion.locator("[data-graph-question]")).toHaveCount(5);
      await expect(savedGraphRegion.getByText("你会如何验证这项工作的结果？", { exact: true })).toBeVisible();
      expect(calls).toBe(8);
    } finally {
      provider.closeAllConnections();
      await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
      expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
    }
  });
}
