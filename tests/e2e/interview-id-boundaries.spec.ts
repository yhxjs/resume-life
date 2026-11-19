import { listenForFetch } from "../support/http-server";
import { expect, test, type APIResponse } from "@playwright/test";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import { publishResume } from "./resume-version-helpers";

test("面试 ID HTTP 边界：来源与轮次不强转，单轮与系列路径拒绝非法 ID，收藏复习保留", async ({ request }) => {
  test.setTimeout(90_000);
  const baseline = await exportEncryptedBackup(request); expect(baseline.response.ok()).toBe(true);
  let calls = 0; let reply: unknown;
  const provider = createServer(async (incoming, outgoing) => {
    for await (const chunk of incoming) void chunk;
    calls++;
    outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
    outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(reply) } }] })}\n\ndata: [DONE]\n\n`);
  });
  await listenForFetch(provider);
  const address = provider.address(); if (!address || typeof address === "string") throw new Error("Missing provider address");
  async function done(response: APIResponse) {
    expect(response.status()).toBe(200);
    const events = await response.text(); expect(events).not.toContain("event: error");
    const match = events.match(/event: done\ndata: ([^\n]+)/); expect(match, events).not.toBeNull();
    return JSON.parse(match![1]!);
  }
  async function rejected(response: APIResponse, status: number, message?: string) {
    expect(response.status(), await response.text()).toBe(status);
    if (message) expect(await response.json()).toEqual({ error: message });
    expect(response.headers()["cache-control"]).toContain("no-store");
  }
  async function get(url: string) {
    const response = await request.get(url); expect(response.status(), await response.text()).toBe(200);
    return response.json();
  }
  try {
    expect((await request.put("/api/settings", { data: {
      base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-interview-id-key",
      api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic",
    } })).ok()).toBe(true);
    const resumeResponse = await request.post("/api/resumes", { data: { title: "面试 ID 合成材料" } });
    expect(resumeResponse.status()).toBe(201); const resumeId = (await resumeResponse.json()).id;
    const version = await publishResume(request, resumeId);
    const interviews: { id: number; series_id: number | null }[] = [];
    for (const mode of ["single", "single", "series"]) {
      reply = { question: "请说明你实际参与的一项任务。" };
      const created = await done(await request.post("/api/interviews", { data: {
        resume_id: resumeId, resume_version_id: version.id, jd: "接口参数校验", rounds: 1, mode,
      } }));
      interviews.push(created);
    }
    const [interview, other, seriesRound] = interviews;
    const endpoint = `/api/interviews/${interview!.id}`;
    const seriesEndpoint = `/api/interviews/series/${seriesRound!.series_id}`;
    const initial = await get(endpoint); const turnId = initial.turns[0].id;
    const otherTurnId = (await get(`/api/interviews/${other!.id}`)).turns[0].id;
    const favorite = await request.post("/api/notebook", { data: { source: "interview", source_id: turnId } });
    expect(favorite.status()).toBe(201); const notebook = await favorite.json(); const favoriteId = notebook.id;
    const cardId = notebook.review.review_card_id; expect(cardId).toBeGreaterThan(0);
    expect((await request.post(`/api/reviews/${cardId}`, { data: {
      answer: "原复习作答", grade: "good", expected_review_count: 0, request_id: randomUUID(),
    } })).status()).toBe(200);
    const snapshotUrls = [endpoint, `/api/interviews/${other!.id}`, `/api/interviews/${seriesRound!.id}`, seriesEndpoint,
      "/api/interviews?limit=50", "/api/interviews/series?limit=50", `/api/notebook/${favoriteId}`, `/api/reviews/${cardId}`];
    const before = await Promise.all(snapshotUrls.map(get));
    expect(calls).toBe(3);
    const badIds = [true, false, [resumeId], [[resumeId]], [], {}, null, "", String(resumeId), 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined];
    for (const mode of ["single", "series"]) {
      for (const value of badIds) {
        await rejected(await request.post("/api/interviews", { data: {
          resume_id: value, resume_version_id: version.id, jd: "接口参数校验", mode,
        } }), 400, "请选择简历");
      }
      await rejected(await request.post("/api/interviews", { data: { resume_id: Number.MAX_SAFE_INTEGER, jd: "接口参数校验", mode } }), 404, "简历不存在");
    }
    for (const value of [true, false, [turnId], [[turnId]], [], {}, null, "", String(turnId), 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined]) {
      await rejected(await request.post(`${endpoint}/answer`, { data: { turn_id: value, answer: "不得保存的原答" } }), 400, "无效的轮次 ID");
    }
    const body = { turn_id: turnId, answer: "不得保存的原答", question: "你们如何验证字段？", from_interview_id: seriesRound!.id };
    const paths = (value: string) => [
      { method: "get", url: `/api/interviews/${value}` },
      { method: "delete", url: `/api/interviews/${value}` },
      ...["answer", "finish", "evaluator-report", "reverse"].map(action => ({ method: "post", url: `/api/interviews/${value}/${action}` })),
      ...["reference", "retry"].flatMap(action => [
        { method: "post", url: `/api/interviews/${value}/turns/${turnId}/${action}` },
        { method: "post", url: `${endpoint}/turns/${value}/${action}` },
      ]),
      { method: "get", url: `/api/interviews/series/${value}` },
      { method: "delete", url: `/api/interviews/series/${value}` },
      ...["finalize", "advance"].map(action => ({ method: "post", url: `/api/interviews/series/${value}/${action}` })),
    ];
    for (const invalid of ["0", "-1", "1.5", "9007199254740992", "9007199254740993", "1e100", "NaN", "Infinity"]) {
      for (const route of paths(invalid)) await rejected(await request.fetch(route.url, { method: route.method, ...(route.method === "post" ? { data: body } : {}) }), 400);
    }
    for (const route of paths(String(Number.MAX_SAFE_INTEGER))) {
      await rejected(await request.fetch(route.url, { method: route.method, ...(route.method === "post" ? { data: body } : {}) }), 404);
    }
    await rejected(await request.post(`${endpoint}/answer`, { data: { turn_id: otherTurnId, answer: "不得跨场写入" } }), 400, "该题已作答或不存在");
    for (const action of ["reference", "retry"]) await rejected(await request.post(`${endpoint}/turns/${otherTurnId}/${action}`, { data: body }), 404, "题目不存在");
    expect(calls).toBe(3);
    expect(await Promise.all(snapshotUrls.map(get))).toEqual(before);
    reply = { depth: 7, structure: 7, authenticity: 8, completeness: 7, comment: "保留实际分工与待确认状态。", next_kind: "question", next_question: "" };
    const answer = "我仅负责参数校验，验收结论待确认。";
    const graded = await done(await request.post(`${endpoint}/answer`, { data: { turn_id: turnId, answer } }));
    expect(graded.finished).toBe(true);
    const after = await get(endpoint);
    expect(after.status).toBe("finished"); expect(after.turns).toHaveLength(1);
    expect(after.turns[0]).toMatchObject({ id: turnId, answer, comment: "保留实际分工与待确认状态。", scores: { depth: 7, structure: 7, authenticity: 8, completeness: 7 } });
    expect(await get(`/api/interviews/${other!.id}`)).toEqual(before[1]);
    expect(await get(`/api/interviews/${seriesRound!.id}`)).toEqual(before[2]);
    expect(await get(seriesEndpoint)).toEqual(before[3]);
    expect(await get(`/api/notebook/${favoriteId}`)).toEqual({ ...before[6], answer, comment: "保留实际分工与待确认状态。" });
    expect(await get(`/api/reviews/${cardId}`)).toEqual({ ...before[7], answer, comment: "保留实际分工与待确认状态。" });
    await rejected(await request.post(`${endpoint}/answer`, { data: { turn_id: turnId, answer } }), 400, "面试已结束");
    expect(await get(endpoint)).toEqual(after); expect(calls).toBe(4);
    const savedNotebook = await get(`/api/notebook/${favoriteId}`); const savedReview = await get(`/api/reviews/${cardId}`);
    const deletedOther = await request.delete(`/api/interviews/${other!.id}`);
    expect(deletedOther.status()).toBe(200); expect(await deletedOther.json()).toEqual({ ok: true });
    await rejected(await request.get(`/api/interviews/${other!.id}`), 404);
    expect(await get(seriesEndpoint)).toEqual(before[3]);
    const deletedSeries = await request.delete(seriesEndpoint);
    expect(deletedSeries.status()).toBe(200); expect(await deletedSeries.json()).toEqual({ ok: true });
    await rejected(await request.get(seriesEndpoint), 404);
    await rejected(await request.get(`/api/interviews/${seriesRound!.id}`), 404);
    expect(await get(endpoint)).toEqual(after);
    expect(await get(`/api/notebook/${favoriteId}`)).toEqual(savedNotebook);
    expect(await get(`/api/reviews/${cardId}`)).toEqual(savedReview); expect(calls).toBe(4);
  } finally {
    provider.closeAllConnections();
    await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
  }
});
