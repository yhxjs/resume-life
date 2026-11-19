import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";

test("工具调用字段不能被合法正文及完成状态掩盖，失败不入库且可正常重试", async ({ request }) => {
  test.setTimeout(90_000);
  const baseline = await exportEncryptedBackup(request);
  expect(baseline.response.ok()).toBe(true);
  const questions = [1, 2, 3].map(index => `合成独立考点 ${index}`);
  const reply = JSON.stringify({ questions: questions.map(question => ({ question, kind: "tech" })) });
  const marker = "SYNTHETIC_PRIVATE_MARKER";
  const fn = { name: "unrequested", arguments: JSON.stringify({ material: marker }) };
  const tool = { type: "function_call", call_id: "synthetic", ...fn };
  let format = "openai_chat";
  let mode = "tool_calls-stream";
  let invoke = false;
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
    const usage = { prompt_tokens: 12, completion_tokens: 5, input_tokens: 12, output_tokens: 5 };
    const fields = !invoke ? {} : mode.startsWith("function_call-") ? { function_call: fn }
      : { tool_calls: [{ index: 0, type: "function", function: fn }] };
    if (fallback) {
      const body = mode === "native-nonstream"
        ? { status: "completed", output_text: reply, output: invoke ? [tool] : [], usage }
        : { choices: [{ message: { content: reply, ...fields }, finish_reason: "stop" }], usage };
      outgoing.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
      return;
    }
    const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
    let body: string;
    if (mode.endsWith("-stream")) {
      body = event({ choices: [{ delta: { content: reply } }], usage });
      if (invoke) body += event({ choices: [{ delta: fields, finish_reason: "stop" }] });
    } else {
      body = event({ type: "response.created", response: { usage } }) + event({ type: "response.output_text.delta", delta: reply });
      if (invoke && mode !== "response.completed") {
        body += event({ type: mode, ...(mode.startsWith("response.output_item.") ? { item: tool } : { delta: fn.arguments, arguments: fn.arguments }) });
      }
      body += event({ type: "response.completed", response: { status: "completed", output: invoke ? [tool] : [] } });
    }
    outgoing.writeHead(200, { "Content-Type": "text/event-stream" }).end(body + "data: [DONE]\n\n");
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
        base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-tools-key", api_format: format, model_question: "synthetic",
      } })).ok()).toBe(true);
      if (!seedPath) {
        const seed = await request.post("/api/drills", { data: drillInput });
        expect(seed.status(), await seed.text()).toBe(201);
        seedPath = `/api/drills/${(await seed.json()).id}`;
        seedDrill = await (await request.get(seedPath)).json();
      }
      const before = await (await request.get("/api/drills?limit=50")).json();
      const modes = ["tool_calls-stream", "tool_calls-nonstream", "function_call-stream", "function_call-nonstream",
        ...(format === "openai_responses" ? ["native-nonstream", "response.output_item.added", "response.output_item.done",
          "response.function_call_arguments.delta", "response.function_call_arguments.done", "response.completed"] : [])];
      for (const responseMode of modes) {
        mode = responseMode;
        invoke = true;
        const callsBefore = calls;
        const rejected = await request.post("/api/drills", { data: drillInput });
        expect(rejected.status(), await rejected.text()).toBe(502);
        expect((await rejected.json()).error).toContain("工具调用");
        expect(await rejected.text()).not.toContain(marker);
        expect(calls).toBe(callsBefore + (mode.endsWith("nonstream") ? 2 : 1));
        expect(await (await request.get("/api/drills?limit=50")).json()).toEqual(before);
        expect(await (await request.get(seedPath)).json()).toEqual(seedDrill);
        const logsResponse = await request.get("/api/settings/llm-logs?limit=50");
        expect(logsResponse.ok()).toBe(true);
        const logs = await logsResponse.json();
        expect(logs.items[0]).toMatchObject({ status: "failed", errorCode: "protocol", attempts: 0, inputTokens: 12, outputTokens: 5 });
        expect(JSON.stringify(logs)).not.toContain(marker);
      }
      invoke = false;
      for (const responseMode of format === "openai_chat" ? ["tool_calls-stream", "function_call-nonstream"] : ["native-nonstream", "response.completed"]) {
        mode = responseMode;
        const retried = await request.post("/api/drills", { data: drillInput });
        expect(retried.status(), await retried.text()).toBe(201);
        const saved = await (await request.get(`/api/drills/${(await retried.json()).id}`)).json();
        expect(saved.questions.map((item: { question: string }) => item.question)).toEqual(questions);
      }
    }
    expect(await (await request.get(seedPath)).json()).toEqual(seedDrill);
  } finally {
    provider.closeAllConnections();
    await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
  }
});
