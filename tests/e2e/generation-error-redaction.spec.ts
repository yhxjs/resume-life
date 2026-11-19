import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";

test("模型坏 JSON 的错误不带原文，耗尽重试不写业务记录，正常结果可显式重试", async ({ request }) => {
  test.setTimeout(90_000);
  const baseline = await exportEncryptedBackup(request);
  expect(baseline.response.ok()).toBe(true);
  const marker = "SYNTHETIC_PRIVATE_MARKER";
  const questions = { questions: [1, 2, 3].map(index => ({ question: `合成考点 ${index}`, kind: "tech" })) };
  let raw = JSON.stringify(questions);
  let fallback = false;
  let calls = 0;
  const provider = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    calls += 1;
    if (fallback && body.stream) {
      outgoing.writeHead(400).end();
      return;
    }
    const usage = { prompt_tokens: 7, completion_tokens: 3 };
    if (fallback) {
      outgoing.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ choices: [{ message: { content: raw } }], usage }));
      return;
    }
    const event = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
    outgoing.end(event({ choices: [{ delta: { content: raw } }] }) + event({ choices: [], usage }) + "data: [DONE]\n\n");
  });
  await listenForFetch(provider);
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("Missing provider address");
  try {
    expect((await request.put("/api/settings", { data: {
      base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-json-error-key", api_format: "openai_chat",
      model_summary: "synthetic", model_question: "synthetic",
    } })).ok()).toBe(true);
    const created = await request.post("/api/resumes", { data: { title: "错误响应校验" } });
    expect(created.status()).toBe(201);
    const resumePath = `/api/resumes/${(await created.json()).id}`;
    const resume = await (await request.get(resumePath)).json();
    const drillInput = { source: "bank", direction: "前端", count: 3 };
    const seed = await request.post("/api/drills", { data: drillInput });
    expect(seed.status(), await seed.text()).toBe(201);
    const seedPath = `/api/drills/${(await seed.json()).id}`;
    const seedDrill = await (await request.get(seedPath)).json();
    const drills = await (await request.get("/api/drills?limit=50")).json();
    for (const useFallback of [false, true]) {
      fallback = useFallback;
      raw = `{"${marker}":敏感原文，未完成有效 JSON}`;
      for (const endpoint of ["drill", "polish"]) {
        const callsBefore = calls;
        const rejected = endpoint === "drill"
          ? await request.post("/api/drills", { data: { ...drillInput, direction: marker } })
          : await request.post(`${resumePath}/polish`, { data: { text: marker } });
        expect(rejected.status(), await rejected.text()).toBe(502);
        expect((await rejected.json()).error).toContain("不是有效 JSON");
        expect(await rejected.text()).not.toContain(marker);
        expect(rejected.headers()["cache-control"]).toContain("no-store");
        expect(calls).toBe(callsBefore + (fallback ? 4 : 3));
        expect(await (await request.get("/api/drills?limit=50")).json()).toEqual(drills);
        expect(await (await request.get(seedPath)).json()).toEqual(seedDrill);
        expect(await (await request.get(resumePath)).json()).toEqual(resume);
        const logsResponse = await request.get("/api/settings/llm-logs?limit=50");
        expect(logsResponse.ok()).toBe(true);
        const logs = await logsResponse.json();
        expect(logs.items[0]).toMatchObject({ status: "failed", errorCode: "invalid_json", attempts: 2, inputTokens: 21, outputTokens: 9 });
        expect(JSON.stringify(logs)).not.toContain(marker);
      }
    }
    raw = JSON.stringify(questions);
    const retried = await request.post("/api/drills", { data: drillInput });
    expect(retried.status(), await retried.text()).toBe(201);
    const saved = await (await request.get(`/api/drills/${(await retried.json()).id}`)).json();
    expect(saved.questions.map((item: { question: string }) => item.question)).toEqual(["合成考点 1", "合成考点 2", "合成考点 3"]);
    raw = JSON.stringify({ draft: "• 参与合成验证，未上线。", draftItems: [{ text: "参与合成验证，未上线。", sourceIndices: [1] }] });
    const polished = await request.post(`${resumePath}/polish`, { data: { text: "参与合成验证，未上线。" } });
    expect(polished.status(), await polished.text()).toBe(200);
    expect((await polished.json()).result).toMatchObject({ draft: "• 参与合成验证，未上线。", draftItemDetails: [{ text: "参与合成验证，未上线。", sourceIndices: [1] }] });
    expect(await (await request.get(seedPath)).json()).toEqual(seedDrill);
    expect(await (await request.get(resumePath)).json()).toEqual(resume);
  } finally {
    provider.closeAllConnections();
    await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
  }
});
