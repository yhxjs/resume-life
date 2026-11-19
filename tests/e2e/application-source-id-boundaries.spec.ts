import { listenForFetch } from "../support/http-server";
import { expect, test, type APIResponse } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import { publishResume } from "./resume-version-helpers";

test("投递关联与排雷来源的 HTTP 类型边界：非法值不借用材料，合法数字与清空关联保留", async ({ request }) => {
  test.setTimeout(90_000);
  const baseline = await exportEncryptedBackup(request);
  expect(baseline.response.ok()).toBe(true);
  let calls = 0;
  let reply: unknown = { question: "请说明一项实际参与的任务。" };
  const provider = createServer(async (incoming, outgoing) => {
    for await (const chunk of incoming) void chunk;
    calls++;
    outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
    outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify(reply) } }] })}\n\ndata: [DONE]\n\n`);
  });
  await listenForFetch(provider);
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("Missing provider address");
  async function get(url: string) {
    const response = await request.get(url);
    expect(response.status(), await response.text()).toBe(200);
    return response.json();
  }
  async function done(response: APIResponse) {
    expect(response.status()).toBe(200);
    const text = await response.text();
    const match = text.match(/event: done\ndata: ([^\n]+)/);
    expect(match, text).not.toBeNull();
    return JSON.parse(match![1]!);
  }
  try {
    expect((await request.put("/api/settings", { data: {
      base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-source-id-key",
      api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic",
    } })).ok()).toBe(true);
    const sources: { resume_id: number; resume_version_id: number; interview_id: number; interview_series_id: number }[] = [];
    for (const title of ["目标来源", "另一份来源"]) {
      const resume = await request.post("/api/resumes", { data: { title, modules: { summary: { text: `${title}：仅参与接口校验，尚未上线。` } } } });
      expect(resume.status()).toBe(201);
      const resume_id = (await resume.json()).id;
      const version = await publishResume(request, resume_id);
      const data = { resume_id, resume_version_id: version.id, jd: "接口校验岗位", rounds: 1 };
      const single = await done(await request.post("/api/interviews", { data: { ...data, mode: "single" } }));
      const series = await done(await request.post("/api/interviews", { data: { ...data, mode: "series" } }));
      sources.push({ resume_id, resume_version_id: version.id, interview_id: single.id, interview_series_id: series.series_id });
    }
    const original = sources[0]!;
    const other = sources[1]!;
    const create = await request.post("/api/applications", { data: { company: "原公司", role: "原岗位", ...original } });
    const createOther = await request.post("/api/applications", { data: { company: "另一公司", role: "另一岗位", ...other } });
    expect(create.status()).toBe(201); expect(createOther.status()).toBe(201);
    const id = (await create.json()).id;
    const otherId = (await createOther.json()).id;
    const endpoints = [
      "/api/applications?limit=50", `/api/applications/${id}`, `/api/applications/${otherId}`,
      `/api/applications/${id}/preparation`, `/api/applications/${otherId}/preparation`,
      `/api/resumes/${original.resume_id}`, `/api/resumes/${other.resume_id}`,
      "/api/interviews?limit=50", "/api/interviews/series?limit=50", "/api/tools/resume-defenses",
    ];
    const before = await Promise.all(endpoints.map(get));
    const modelCalls = calls;
    async function reject(response: APIResponse, message: string) {
      expect(response.status(), await response.text()).toBe(400);
      expect(await response.json()).toEqual({ error: message });
      expect(response.headers()["cache-control"]).toContain("no-store");
    }
    for (const field of ["resume_id", "resume_version_id", "interview_id", "interview_series_id"] as const) {
      for (const value of [true, false, [original[field]], [[original[field]]], [], {}, String(original[field]), "1e0", " ", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        const data = { company: "不得新增", role: "不得覆盖", ...original, [field]: value, stage: "applied" };
        await reject(await request.post("/api/applications", { data }), "关联记录 ID 无效");
        await reject(await request.patch(`/api/applications/${id}`, { data }), "关联记录 ID 无效");
      }
    }
    for (const resumeId of [true, false, [original.resume_id], [[original.resume_id]], [], {}, String(original.resume_id), "1e0", " ", 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await reject(await request.post("/api/tools/resume-defenses", { data: {
        resumeId, resumeContent: "粘贴原文不能掩盖非法简历 ID",
      } }), "请选择有效的简历");
    }
    expect(calls).toBe(modelCalls);
    expect(await Promise.all(endpoints.map(get))).toEqual(before);

    const patch = await request.patch(`/api/applications/${id}`, { data: { notes: "仅修改备注" } });
    expect(patch.status()).toBe(200);
    expect(await patch.json()).toMatchObject({ ...original, notes: "仅修改备注" });
    for (const value of [null, ""]) {
      const data = Object.fromEntries(Object.keys(original).map(field => [field, value]));
      const cleared = await request.patch(`/api/applications/${id}`, { data });
      expect(cleared.status()).toBe(200);
      expect(await cleared.json()).toMatchObject({ resume_id: null, resume_version_id: null, interview_id: null, interview_series_id: null });
      const restored = await request.patch(`/api/applications/${id}`, { data: original });
      expect(restored.status()).toBe(200); expect(await restored.json()).toMatchObject(original);
    }
    const rebind = await request.patch(`/api/applications/${id}`, { data: other });
    expect(rebind.status()).toBe(200); expect(await rebind.json()).toMatchObject(other);
    expect(await get(`/api/applications/${otherId}`)).toEqual(before[2]);

    reply = { risk_level: "low", overall_roast: "现有表述保留了参与范围与验证状态。", items: [] };
    const defense = await request.post("/api/tools/resume-defenses", { data: {
      resumeId: original.resume_id, resume_version_id: original.resume_version_id,
    } });
    expect(defense.status(), await defense.text()).toBe(200);
    expect(await defense.json()).toMatchObject({ resumeId: original.resume_id, resumeVersionId: original.resume_version_id });
    expect(calls).toBe(modelCalls + 1);
  } finally {
    provider.closeAllConnections();
    await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
  }
});
