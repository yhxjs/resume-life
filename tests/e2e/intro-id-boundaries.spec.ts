import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";
import { publishResume } from "./resume-version-helpers";

test("自我介绍 ID HTTP 边界：拒绝转换简历与非正安全路径，不调用模型或改变存档", async ({ request }) => {
  test.setTimeout(90_000);
  const baseline = await exportEncryptedBackup(request);
  expect(baseline.response.ok()).toBe(true);
  let calls = 0;
  const sentences = [{ text: "我只参与接口校验，尚未上线。", comment: "保留分工与状态。" }];
  const provider = createServer(async (incoming, outgoing) => {
    for await (const chunk of incoming) void chunk;
    calls++;
    outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
    const content = JSON.stringify({ versions: ["30s", "2min"].map(kind => ({ kind, sentences })) });
    outgoing.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
  });
  await listenForFetch(provider);
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("Missing provider address");
  try {
    expect((await request.put("/api/settings", { data: {
      base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-intro-id-key",
      api_format: "openai_chat", model_question: "synthetic", model_evaluate: "synthetic",
    } })).ok()).toBe(true);
    const resumeResponse = await request.post("/api/resumes", { data: { title: "ID 边界真实存档" } });
    expect(resumeResponse.status()).toBe(201);
    const resume = await resumeResponse.json();
    const version = await publishResume(request, resume.id);
    const created = await request.post("/api/intros", { data: { resume_id: resume.id, resume_version_id: version.id, jd: "接口校验" } });
    expect(created.status()).toBe(200);
    const match = (await created.text()).match(/event: done\ndata: ([^\n]+)/);
    expect(match).not.toBeNull();
    const { id } = JSON.parse(match![1]!);
    const endpoint = `/api/intros/${id}`;
    const before = await (await request.get(endpoint)).json();
    const list = await (await request.get("/api/intros?limit=50")).json();
    const selected = before.versions.find((entry: { kind: string }) => entry.kind === "30s");
    for (const resume_id of [true, false, [resume.id], [[resume.id]], [], {}, null, "", String(resume.id), 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, undefined]) {
      const response = await request.post("/api/intros", { data: { resume_id, jd: "接口校验" } });
      expect(response.status(), `resume_id=${JSON.stringify(resume_id)}`).toBe(400);
      expect(await response.json()).toEqual({ error: "请选择简历" });
      expect(response.headers()["cache-control"]).toContain("no-store");
    }
    for (const invalid of ["0", "-1", "9007199254740992", "9007199254740993", "1e100", "1.5", "NaN", "Infinity"]) {
      const root = `/api/intros/${invalid}`;
      for (const response of [
        await request.patch(`${root}/versions/30s`, { data: { sentences, baseRevision: selected.revision } }),
        await request.post(`${root}/recomment`, { data: { kind: "30s", baseRevision: selected.revision } }),
        await request.post(`${root}/regenerate`, { data: { kind: "30s", baseRevision: selected.revision } }),
      ]) {
        expect(response.status(), root).toBe(400);
        expect(await response.json()).toEqual({ error: "无效的记录 ID" });
        expect(response.headers()["cache-control"]).toContain("no-store");
      }
    }
    expect(calls).toBe(1);
    expect(await (await request.get(endpoint)).json()).toEqual(before);
    expect(await (await request.get("/api/intros?limit=50")).json()).toEqual(list);
    const saved = await request.patch(`${endpoint}/versions/30s`, { data: {
      sentences: [{ text: "完整手动稿仍可正常保存。", comment: "" }], baseRevision: selected.revision,
    } });
    expect(saved.status()).toBe(200);
    const after = await (await request.get(endpoint)).json();
    expect(after.versions.find((entry: { kind: string }) => entry.kind === "30s").sentences).toEqual([{ text: "完整手动稿仍可正常保存。", comment: "" }]);
    expect(after.versions.find((entry: { kind: string }) => entry.kind === "2min")).toEqual(before.versions.find((entry: { kind: string }) => entry.kind === "2min"));
    expect(calls).toBe(1);
  } finally {
    provider.closeAllConnections();
    await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
  }
});
