import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";

test("Anthropic 非正文停止原因不保存已有 JSON，正常停止后可显式重试", async ({ request }) => {
  test.setTimeout(90_000);
  const baseline = await exportEncryptedBackup(request);
  expect(baseline.response.ok()).toBe(true);
  const reply = JSON.stringify({ questions: [1, 2, 3].map(index => ({ question: `合成独立考点 ${index}`, kind: "tech" })) });
  let reason = "end_turn";
  let fallback = false;
  let calls = 0;
  const provider = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    calls += 1;
    if (fallback && input.stream) {
      outgoing.writeHead(400).end();
      return;
    }
    const stopDetails = { detail: "SYNTHETIC_PRIVATE_MARKER" };
    if (fallback) {
      outgoing.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({
        type: "message", content: [{ type: "text", text: reply }], stop_reason: reason,
        stop_details: stopDetails, usage: { input_tokens: 12, output_tokens: 5 },
      }));
      return;
    }
    const event = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    outgoing.writeHead(200, { "Content-Type": "text/event-stream" });
    outgoing.end(event({ type: "message_start", message: { usage: { input_tokens: 12 }, stop_reason: null } }) +
      event({ type: "content_block_delta", delta: { type: "text_delta", text: reply } }) +
      event({ type: "message_delta", delta: { stop_reason: reason, stop_details: stopDetails }, usage: { output_tokens: 5 } }) +
      event({ type: "message_stop" }));
  });
  await listenForFetch(provider);
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("Missing provider address");
  try {
    expect((await request.put("/api/settings", { data: {
      base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-anthropic-status-key",
      api_format: "anthropic_messages", model_question: "synthetic",
    } })).ok()).toBe(true);
    const drillInput = { source: "bank", direction: "前端", count: 3 };
    const seed = await request.post("/api/drills", { data: drillInput });
    expect(seed.status(), await seed.text()).toBe(201);
    const seedPath = `/api/drills/${(await seed.json()).id}`;
    const seedDrill = await (await request.get(seedPath)).json();
    for (const useFallback of [false, true]) {
      fallback = useFallback;
      const before = await (await request.get("/api/drills?limit=50")).json();
      for (const failedReason of ["tool_use", "pause_turn", "refusal", "model_context_window_exceeded"]) {
        reason = failedReason;
        const callsBefore = calls;
        const rejected = await request.post("/api/drills", { data: drillInput });
        expect(rejected.status(), await rejected.text()).toBe(502);
        expect((await rejected.json()).error).toContain(reason === "tool_use" ? "工具调用" : "未完成");
        expect(await rejected.text()).not.toContain("SYNTHETIC_PRIVATE_MARKER");
        expect(calls).toBe(callsBefore + (fallback ? 2 : 1));
        expect(await (await request.get("/api/drills?limit=50")).json()).toEqual(before);
        expect(await (await request.get(seedPath)).json()).toEqual(seedDrill);
        const logsResponse = await request.get("/api/settings/llm-logs?limit=50");
        expect(logsResponse.ok()).toBe(true);
        const logs = await logsResponse.json();
        expect(logs.items[0]).toMatchObject({ status: "failed", errorCode: reason === "tool_use" ? "protocol" : "incomplete",
          attempts: 0, inputTokens: 12, outputTokens: 5 });
        expect(JSON.stringify(logs)).not.toContain("SYNTHETIC_PRIVATE_MARKER");
      }
      for (const completedReason of ["end_turn", "stop_sequence"]) {
        reason = completedReason;
        const callsBefore = calls;
        const retried = await request.post("/api/drills", { data: drillInput });
        expect(retried.status(), await retried.text()).toBe(201);
        const saved = await (await request.get(`/api/drills/${(await retried.json()).id}`)).json();
        expect(saved.questions.map((item: { question: string }) => item.question)).toEqual(["合成独立考点 1", "合成独立考点 2", "合成独立考点 3"]);
        expect(calls).toBe(callsBefore + (fallback ? 2 : 1));
      }
    }
    expect(await (await request.get(seedPath)).json()).toEqual(seedDrill);
  } finally {
    provider.closeAllConnections();
    await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    expect((await postEncryptedBackup(request, "/api/backup/restore", baseline.bytes)).ok()).toBe(true);
  }
});
