import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { exportEncryptedBackup, postEncryptedBackup, rewriteEncryptedBackup } from "./backup-helpers";
import { publishResume } from "./resume-version-helpers";

test("练习 ID HTTP 边界：不转换来源，不评分非法或串练习路径，保留收藏复习", async ({ request }) => {
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
  try {
    expect((await request.put("/api/settings", { data: {
      base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-drill-id-key",
      api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic",
    } })).ok()).toBe(true);
    const projectResponse = await request.post("/api/projects", { data: { name: "ID 来源项目" } });
    expect(projectResponse.status()).toBe(201); const projectId = (await projectResponse.json()).id;
    const resumeResponse = await request.post("/api/resumes", { data: { title: "面试来源材料" } });
    expect(resumeResponse.status()).toBe(201); const resumeId = (await resumeResponse.json()).id;
    const version = await publishResume(request, resumeId);
    const seed = await exportEncryptedBackup(request); expect(seed.response.ok()).toBe(true);
    let interviewId = 0;
    const seeded = await rewriteEncryptedBackup(seed.bytes, records => {
      interviewId = Math.max(0, ...records.flatMap(row => row.kind === "row" && row.table === "interviews" ? [Number(row.data.id)] : [])) + 1;
      records.splice(records.findIndex(row => row.kind === "end"), 0, { kind: "row", table: "interviews", data: {
        id: interviewId, resume_id: resumeId, jd: "接口校验岗位", rounds: 8, style: "gentle", series_id: null, round_no: 0,
        status: "finished", report: JSON.stringify({ depth: 5, structure: 6, authenticity: 6, completeness: 5, jd_match: 6, overall: 5.6,
          strengths: "说明职责", weaknesses: "验证待补充", suggestions: "练习解释边界" }), reverse_interview: "", evaluator_report: "",
        created_at: "2026-10-29T00:00:00Z", finished_at: "2026-10-29T00:00:00Z", resume_version_id: version.id,
      } });
      const manifest = records.find(row => row.kind === "manifest"); const end = records.find(row => row.kind === "end");
      if (manifest?.kind !== "manifest" || end?.kind !== "end") throw new Error("Missing backup envelope");
      manifest.sequences = { ...manifest.sequences, interviews: interviewId };
      end.stats = Object.fromEntries(manifest.tables.map(table => [table, records.filter(row => row.kind === "row" && row.table === table).length]));
      end.totalRecords = Object.values(end.stats).reduce((sum, count) => sum + count, 0);
    });
    const restored = await postEncryptedBackup(request, "/api/backup/restore", seeded, { preserveAiConfig: true });
    expect(restored.status(), await restored.text()).toBe(200);
    const ids: number[] = [];
    for (const source of ["project", "interview", "bank"] as const) {
      reply = { questions: source === "project" ? ["请说明参数校验的个人分工", "你如何验证错误参数？"]
        : [{ question: "假设出现字段不兼容，你会如何排查？", kind: "tech" }] };
      const response = await request.post("/api/drills", { data: { source, project_id: projectId, interview_id: interviewId, direction: "接口校验", count: 2 } });
      expect(response.status(), await response.text()).toBe(201);
      const result = await response.json(); ids.push(result.id);
      expect(result.count).toBe(source === "project" ? 2 : 1);
    }
    const endpoint = `/api/drills/${ids[0]}`;
    const initial = await (await request.get(endpoint)).json(); const questionId = initial.questions[0].id;
    const otherQuestionId = (await (await request.get(`/api/drills/${ids[1]}`)).json()).questions[0].id;
    const favorite = await request.post("/api/notebook", { data: { source: "drill", source_id: questionId } });
    expect(favorite.status()).toBe(201); const favoriteId = (await favorite.json()).id;
    const withFavorite = await (await request.get(endpoint)).json(); const cardId = withFavorite.questions[0].review_card_id;
    expect(cardId).toBeGreaterThan(0);
    expect((await request.post(`/api/reviews/${cardId}`, { data: { answer: "原复习作答", grade: "good", expected_review_count: 0, request_id: randomUUID() } })).status()).toBe(200);
    const before = await (await request.get(endpoint)).json();
    const other = await (await request.get(`/api/drills/${ids[1]}`)).json();
    const bank = await (await request.get(`/api/drills/${ids[2]}`)).json();
    const categoryResponse = await request.post("/api/notebook/categories", { data: { name: "ID 边界分类" } });
    expect(categoryResponse.status()).toBe(201);
    const categoryId = (await categoryResponse.json()).id as number;
    expect((await request.patch(`/api/notebook/${favoriteId}`, { data: { category_id: categoryId } })).status()).toBe(200);
    const notebook = await (await request.get(`/api/notebook/${favoriteId}`)).json();
    const review = await (await request.get(`/api/reviews/${cardId}`)).json();
    const list = await (await request.get("/api/drills?limit=50")).json();
    expect(calls).toBe(3);
    const projectList = await request.get(`/api/drills?project_id=${projectId}&limit=50`);
    expect(projectList.status()).toBe(200);
    expect((await projectList.json()).items.map((item: { id: number }) => item.id)).toEqual([ids[0]]);
    const lookup = `/api/notebook/lookup?source=drill&source_id=${questionId}`;
    expect((await request.get(lookup)).status()).toBe(200);
    const categoryList = await request.get(`/api/notebook?category_id=${categoryId}`);
    expect(categoryList.status()).toBe(200);
    expect((await categoryList.json()).items.map((item: { id: number }) => item.id)).toEqual([favoriteId]);
    for (const [field, target, endpoint, message] of [
      ["project_id", projectId, "/api/drills", "无效的项目筛选"],
      ["source_id", questionId, "/api/notebook/lookup?source=drill", "无效的收藏来源"],
      ["category_id", categoryId, "/api/notebook", "无效的分类筛选"],
    ] as const) {
      for (const value of [`${target}e0`, `0x${target.toString(16)}`, `+${target}`, `0${target}`, ` ${target}`]) {
        const response = await request.get(`${endpoint}${endpoint.includes("?") ? "&" : "?"}${field}=${encodeURIComponent(value)}`);
        expect(response.status(), `${field}=${value}`).toBe(400);
        expect(await response.json()).toEqual({ error: message });
        expect(response.headers()["cache-control"]).toContain("no-store");
      }
    }
    for (const source of ["project", "interview"] as const) {
      const field = source === "project" ? "project_id" : "interview_id";
      const id = source === "project" ? projectId : interviewId;
      for (const value of [true, false, [id], [[id]], [], {}, null, "", String(id), 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined]) {
        const response = await request.post("/api/drills", { data: { source, [field]: value, count: 1 } });
        expect(response.status(), `${source} ${JSON.stringify(value)}`).toBe(400);
        expect(await response.json()).toEqual({ error: source === "project" ? "请选择项目" : "请选择面试记录" });
        expect(response.headers()["cache-control"]).toContain("no-store");
      }
      expect((await request.post("/api/drills", { data: { source, [field]: Number.MAX_SAFE_INTEGER, count: 1 } })).status()).toBe(404);
    }
    for (const invalid of ["0", "-1", "1.5", "9007199254740992", "9007199254740993", "1e100", "1e0", "0x1", "+1", "01", "NaN", "Infinity"]) {
      for (const path of [`/api/drills/${invalid}/questions/${questionId}`, `${endpoint}/questions/${invalid}`]) {
        const response = await request.post(path, { data: { answer: "不得写入的原答" } });
        expect(response.status(), path).toBe(400);
        expect(await response.json()).toEqual({ error: "无效的 ID" });
        expect(response.headers()["cache-control"]).toContain("no-store");
      }
    }
    expect((await request.post(`${endpoint}/questions/${otherQuestionId}`, { data: { answer: "不得跨练习评分" } })).status()).toBe(404);
    expect(calls).toBe(3);
    expect(await (await request.get(endpoint)).json()).toEqual(before);
    expect(await (await request.get("/api/drills?limit=50")).json()).toEqual(list);
    expect(await (await request.get(`/api/notebook/${favoriteId}`)).json()).toEqual(notebook);
    expect(await (await request.get(`/api/reviews/${cardId}`)).json()).toEqual(review);
    reply = { depth: 7, structure: 7, authenticity: 8, completeness: 7, comment: "保留职责边界。", reference: "仅描述已知任务。" };
    const graded = await request.post(`${endpoint}/questions/${questionId}`, { data: { answer: "我仅参与参数校验，验收待确认。" } });
    expect(graded.status(), await graded.text()).toBe(200);
    const after = await (await request.get(endpoint)).json();
    expect(after.questions[0]).toMatchObject({ answer: "我仅参与参数校验，验收待确认。", comment: "保留职责边界。", reference: "仅描述已知任务。" });
    expect(after.questions[1]).toEqual(before.questions[1]);
    expect(await (await request.get(`/api/drills/${ids[1]}`)).json()).toEqual(other);
    expect(await (await request.get(`/api/drills/${ids[2]}`)).json()).toEqual(bank);
    expect(await (await request.get(`/api/reviews/${cardId}`)).json()).toEqual({
      ...review, answer: "我仅参与参数校验，验收待确认。", comment: "保留职责边界。", reference: "仅描述已知任务。",
    });
    expect(calls).toBe(4);
  } finally {
    provider.closeAllConnections();
    await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
  }
});
