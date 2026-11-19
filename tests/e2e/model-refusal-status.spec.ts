import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";

test("明确拒绝信号不能被有效题目正文覆盖，失败不保存且正常结果可显式重试", async ({ request }) => {
  test.setTimeout(90_000);
  const baseline = await exportEncryptedBackup(request);
  expect(baseline.response.ok()).toBe(true);
  const reply = JSON.stringify({ questions: [1, 2, 3].map(index => ({ question: `合成独立考点 ${index}`, kind: "tech" })) });
  const refusal = { type: "refusal", refusal: "SYNTHETIC_PRIVATE_MARKER" };
  let format = "openai_chat";
  let mode = "choices-stream";
  let refuse = false;
  let calls = 0;
  const provider = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    calls += 1;
    const fallback = mode.endsWith("nonstream");
    if (fallback && input.stream) {
      outgoing.writeHead(400).end();
      return;
    }
    const usage = format === "openai_chat" ? { prompt_tokens: 12, completion_tokens: 5 } : { input_tokens: 12, output_tokens: 5 };
    const message = { type: "message", content: [{ type: "output_text", text: reply }, ...(refuse ? [refusal] : [])] };
    if (fallback) {
      const body = mode === "choices-nonstream"
        ? { choices: [{ message: { content: reply, refusal: refuse ? refusal.refusal : null }, finish_reason: "stop" }], usage }
        : { status: "completed", output_text: reply, output: [message], usage };
      outgoing.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
      return;
    }
    const event = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    let body: string;
    if (mode === "choices-stream") {
      body = event({ choices: [{ delta: { content: reply } }], usage });
      if (refuse) body += event({ choices: [{ delta: { refusal: refusal.refusal } }] });
    } else {
      body = event({ type: "response.created", response: { usage } }) + event({ type: "response.output_text.delta", delta: reply });
      if (refuse && mode !== "response.completed") {
        body += event({ type: mode, delta: refusal.refusal, refusal: refusal.refusal, part: refusal, item: message });
      }
      body += event({ type: "response.completed", response: { status: "completed", output: [message] } });
    }
    outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
    outgoing.end(body + "data: [DONE]\n\n");
  });
  await listenForFetch(provider);
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("Missing provider address");
  try {
    const drillInput = { source: "bank", direction: "前端", count: 3 };
    let seedPath = "";
    let seedDrill: unknown;
    for (const apiFormat of ["openai_chat", "openai_responses"]) {
      format = apiFormat;
      expect((await request.put("/api/settings", { data: {
        base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-refusal-key", api_format: format, model_question: "synthetic",
      } })).ok()).toBe(true);
      if (!seedPath) {
        const seed = await request.post("/api/drills", { data: drillInput });
        expect(seed.status(), await seed.text()).toBe(201);
        seedPath = `/api/drills/${(await seed.json()).id}`;
        seedDrill = await (await request.get(seedPath)).json();
      }
      const before = await (await request.get("/api/drills?limit=50")).json();
      const modes = ["choices-stream", "choices-nonstream", ...(format === "openai_responses"
        ? ["native-nonstream", "response.refusal.delta", "response.refusal.done", "response.content_part.added", "response.content_part.done",
          "response.output_item.added", "response.output_item.done", "response.completed"] : [])];
      for (const responseMode of modes) {
        mode = responseMode;
        refuse = true;
        const callsBefore = calls;
        const rejected = await request.post("/api/drills", { data: drillInput });
        expect(rejected.status(), await rejected.text()).toBe(502);
        expect((await rejected.json()).error).toContain("拒绝");
        expect(await rejected.text()).not.toContain(refusal.refusal);
        expect(calls).toBe(callsBefore + (mode.endsWith("nonstream") ? 2 : 1));
        expect(await (await request.get("/api/drills?limit=50")).json()).toEqual(before);
        expect(await (await request.get(seedPath)).json()).toEqual(seedDrill);
        const logsResponse = await request.get("/api/settings/llm-logs?limit=50");
        expect(logsResponse.ok()).toBe(true);
        const logs = await logsResponse.json();
        expect(logs.items[0]).toMatchObject({ status: "failed", errorCode: "incomplete", attempts: 0, inputTokens: 12, outputTokens: 5 });
        expect(JSON.stringify(logs)).not.toContain(refusal.refusal);
      }
      refuse = false;
      for (const responseMode of format === "openai_chat" ? ["choices-stream", "choices-nonstream"] : ["native-nonstream", "response.completed"]) {
        mode = responseMode;
        const retried = await request.post("/api/drills", { data: drillInput });
        expect(retried.status(), await retried.text()).toBe(201);
        const saved = await (await request.get(`/api/drills/${(await retried.json()).id}`)).json();
        expect(saved.questions.map((item: { question: string }) => item.question)).toEqual(["合成独立考点 1", "合成独立考点 2", "合成独立考点 3"]);
      }
    }
    expect(await (await request.get(seedPath)).json()).toEqual(seedDrill);
  } finally {
    provider.closeAllConnections();
    await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
  }
});
