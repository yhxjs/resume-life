import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";

test("Anthropic 客户端工具及 Responses 自定义工具不保存为最终正文", async ({ request }) => {
  test.setTimeout(90_000);
  const baseline = await exportEncryptedBackup(request);
  expect(baseline.response.ok()).toBe(true);
  const questions = [1, 2, 3].map(index => `合成工具边界考点 ${index}`);
  const reply = JSON.stringify({ questions: questions.map(question => ({ question, kind: "tech" })) });
  const marker = "SYNTHETIC_PRIVATE_MARKER";
  const anthropic = { type: "tool_use", id: "synthetic", name: "unrequested", input: { material: marker } };
  const custom = { type: "custom_tool_call", call_id: "synthetic", name: "unrequested", input: marker, status: "completed" };
  const usage = { input_tokens: 12, output_tokens: 5 };
  const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
  let format = "anthropic_messages";
  let mode = "content_block_start";
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
    if (fallback) {
      const body = format === "anthropic_messages"
        ? { content: [{ type: "text", text: reply }, ...(invoke ? [anthropic] : [])], ...(mode.startsWith("missing") ? {} : { stop_reason: "end_turn" }), usage }
        : { status: "completed", output_text: reply, output: invoke ? [custom] : [], usage };
      outgoing.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
      return;
    }
    let body: string;
    if (format === "anthropic_messages") {
      body = event({ type: "message_start", message: { usage, content: invoke && mode === "message_start" ? [anthropic] : [] } })
        + event({ type: "content_block_delta", delta: { type: "text_delta", text: reply } });
      if (invoke && mode === "content_block_start") body += event({ type: "content_block_start", content_block: anthropic });
      if (invoke && mode === "input_json_delta") body += event({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json: marker } });
      body += event({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage }) + event({ type: "message_stop" });
    } else {
      body = event({ type: "response.created", response: { usage } }) + event({ type: "response.output_text.delta", delta: reply });
      if (invoke && !["response.completed", "response.done"].includes(mode)) {
        body += event({ type: mode, ...(mode.startsWith("response.output_item.") ? { item: custom } : { delta: marker, input: marker }) });
      }
      body += event({ type: mode === "response.done" ? mode : "response.completed", response: { status: "completed", output: invoke ? [custom] : [] } });
    }
    outgoing.writeHead(200, { "Content-Type": "text/event-stream" }).end(body);
  });
  await listenForFetch(provider);
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("Missing provider address");
  try {
    const drillInput = { source: "bank", direction: "前端", count: 3 };
    let seedPath = "";
    let seedDrill: unknown;
    for (const apiFormat of ["anthropic_messages", "openai_responses"]) {
      format = apiFormat;
      expect((await request.put("/api/settings", { data: {
        base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-client-tools-key", api_format: format, model_question: "synthetic",
      } })).ok()).toBe(true);
      if (!seedPath) {
        const seed = await request.post("/api/drills", { data: drillInput });
        expect(seed.status(), await seed.text()).toBe(201);
        seedPath = `/api/drills/${(await seed.json()).id}`;
        seedDrill = await (await request.get(seedPath)).json();
      }
      const before = await (await request.get("/api/drills?limit=50")).json();
      const modes = format === "anthropic_messages" ? ["missing-nonstream", "end-turn-nonstream", "content_block_start", "input_json_delta", "message_start"]
        : ["native-nonstream", "response.output_item.added", "response.output_item.done", "response.custom_tool_call_input.delta", "response.custom_tool_call_input.done", "response.completed", "response.done"];
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
      for (const responseMode of format === "anthropic_messages" ? ["missing-nonstream", "content_block_start"] : ["native-nonstream", "response.completed"]) {
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
