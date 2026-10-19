import { expect, test, type APIResponse } from "@playwright/test";
import { createServer } from "node:http";
import {
  exportEncryptedBackup,
  postEncryptedBackup,
  rewriteEncryptedBackup,
} from "./backup-helpers";
import { gate } from "./synthetic-api";
import { publishResume } from "./resume-version-helpers";

/** 真实 Next HTTP + 隔离 SQLite + 本地可控模型；不拦截应用 API。 */
test("production routes enforce report integrity, backup validation and model input boundaries", async ({ request }) => {
  const baseline = await exportEncryptedBackup(request);
  if (!baseline.response.ok()) {
    throw new Error(`导出 model-boundaries E2E baseline 失败 (${baseline.response.status()})`);
  }

  let reply: unknown = {};
  let hold: ReturnType<typeof gate> | null = null;
  let calls = 0;
  const provider = createServer(async (incoming, outgoing) => {
    for await (const chunk of incoming) void chunk;
    calls++;
    const value = JSON.stringify(reply);
    const currentHold = hold;
    if (currentHold) await currentHold.promise;
    outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
    outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: value } }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("Missing local provider address");
  const done = async (response: APIResponse) => {
    expect(response.status()).toBe(200);
    const events = await response.text();
    const result = events.match(/event: done\ndata: ([^\n]+)/);
    expect(result, events).not.toBeNull();
    if (!result) throw new Error("响应里没有 event: done 记录");
    return JSON.parse(result[1]!);
  };
  const evaluator = { recommendation: "Lean No", level: "P5", level_justification: "系统设计需验证", summary_for_hr: "建议追加考察", hire_reasons: [], concerns_and_risks: ["证据不足"], placement_suggestion: "补充技术面" };
  try {
    expect((await request.put("/api/settings", { data: {
      base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-e2e-key", api_format: "openai_chat", model_parse: "synthetic",
    } })).ok()).toBe(true);
    const resume = await (await request.post("/api/resumes", { data: { title: "边界验收合成简历" } })).json();
    const version = await publishResume(request, resume.id);
    async function answeredInterview() {
      reply = { question: "合成第一题" };
      const interview = await done(await request.post("/api/interviews", { data: { resume_id: resume.id, resume_version_id: version.id, jd: "合成岗位", rounds: 3 } }));
      const detail = await (await request.get(`/api/interviews/${interview.id}`)).json();
      reply = { depth: 9, structure: 9, authenticity: 9, completeness: 9, comment: "合成点评", next_question: "合成下一题", next_kind: "question" };
      await done(await request.post(`/api/interviews/${interview.id}/answer`, { data: { turn_id: detail.turns[0].id, answer: "合成回答" } }));
      return interview.id as number;
    }
    const id = await answeredInterview();
    reply = { jd_match: 9, strengths: "保留候选人优势", weaknesses: "保留短板", suggestions: "保留建议" };
    hold = gate();
    const beforeFinishCalls = calls;
    const finishing = request.post(`/api/interviews/${id}/finish`);
    await expect.poll(() => calls).toBe(beforeFinishCalls + 1);
    const detail = await (await request.get(`/api/interviews/${id}`)).json();
    expect((await request.post(`/api/interviews/${id}/answer`, { data: { turn_id: detail.turns[1].id, answer: "竞争回答" } })).status()).toBe(409);
    expect((await request.post(`/api/interviews/${id}/finish`)).status()).toBe(409);
    hold.release(); hold = null;
    const finished = await finishing;
    expect(finished.status()).toBe(200);
    const result = await finished.json();
    expect(result.evaluator_report).toBeNull();
    expect(result.report).toMatchObject({ overall: 9, strengths: "保留候选人优势" });
    reply = evaluator;
    expect((await request.post(`/api/interviews/${id}/evaluator-report`)).status()).toBe(200);
    const afterRetry = await (await request.get(`/api/interviews/${id}`)).json();
    expect(afterRetry.report).toEqual(result.report);
    expect(afterRetry.finished_at).toBe(result.finished_at);
    expect(afterRetry.evaluator_report).toEqual(evaluator);

    const invalidId = await answeredInterview();
    reply = { jd_match: null, strengths: "不应保存" };
    expect((await request.post(`/api/interviews/${invalidId}/finish`)).status()).toBe(502);
    expect((await (await request.get(`/api/interviews/${invalidId}`)).json()).report).toBeNull();

    const beforeInvalidCalls = calls;
    for (const action of ["models", "test"]) {
      for (const body of ["null", '{"base_url":42}', "{broken"]) {
        const response = await request.post(`/api/settings/${action}`, { data: body, headers: { "Content-Type": "application/json" } });
        expect(response.status()).toBe(400);
        expect((await response.json()).error).toBeTruthy();
      }
    }
    for (const action of ["intros", "interviews"]) {
      expect((await request.post(`/api/${action}`, { data: { resume_id: resume.id, jd: "字".repeat(70000) } })).status()).toBe(413);
    }
    expect(calls).toBe(beforeInvalidCalls);

    const project = await (await request.post("/api/projects", { data: { name: "原项目" } })).json();
    const beforeInvalidBackup = await (await request.get(`/api/projects/${project.id}`)).json();
    const exported = await exportEncryptedBackup(request);
    expect(exported.response.ok()).toBe(true);
    const invalidContainer = await rewriteEncryptedBackup(exported.bytes, (records) => {
      const projectRow = records.find((record) =>
        record.kind === "row" && record.table === "projects" && record.data.id === project.id
      );
      if (!projectRow || projectRow.kind !== "row") throw new Error("备份中缺少目标项目");
      projectRow.data.summary = '{"overview":42}';
    });
    for (const endpoint of ["/api/backup/validate", "/api/backup/restore"] as const) {
      const response = await postEncryptedBackup(request, endpoint, invalidContainer, {
        preserveAiConfig: true,
      });
      expect(response.status()).toBe(400);
      const failure = await response.json();
      expect(failure.error).toMatch(/projects/);
      expect(failure.error).toMatch(/summary/);
    }
    expect(await (await request.get(`/api/projects/${project.id}`)).json()).toEqual(beforeInvalidBackup);
  } finally {
    hold?.release();
    try {
      provider.closeAllConnections();
      await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
    } finally {
      const cleanup = await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes, {
        preserveAiConfig: false,
      });
      if (!cleanup.ok()) {
        throw new Error(`恢复 model-boundaries E2E baseline 失败 (${cleanup.status()}): ${await cleanup.text()}`);
      }
    }
  }
});
