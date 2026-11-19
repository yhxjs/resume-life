import { listenForFetch } from "../support/http-server";
import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import { exportEncryptedBackup, postEncryptedBackup } from "./backup-helpers";

test("三协议坏 UTF-8 不替换后保存，正常 BOM 和多字节正文可完整重试", async ({ request }) => {
  test.setTimeout(90_000);
  const baseline = await exportEncryptedBackup(request);
  expect(baseline.response.ok()).toBe(true);
  const questions = [1, 2, 3].map(index => `请说明考点 ${index} 中的𠮷😀与实际字符 �，SYNTHETIC_PRIVATE_MARKER`);
  const reply = JSON.stringify({ questions: questions.map(question => ({ question, kind: "tech" })) });
  let format = "openai_chat";
  let fallback = false;
  let corrupt = false;
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
    const event = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    const usage = format === "openai_chat" ? { prompt_tokens: 12, completion_tokens: 5 } : { input_tokens: 12, output_tokens: 5 };
    const json = format === "openai_chat" ? { choices: [{ message: { content: reply } }], usage }
      : format === "anthropic_messages" ? { content: [{ type: "text", text: reply }], stop_reason: "end_turn", usage }
        : { status: "completed", output_text: reply, usage };
    const stream = format === "openai_chat" ? event({ choices: [{ delta: { content: reply } }] }) + "data: [DONE]\n\n"
      : format === "anthropic_messages" ? event({ type: "content_block_delta", delta: { type: "text_delta", text: reply } }) + event({ type: "message_stop" })
        : event({ type: "response.output_text.delta", delta: reply }) + event({ type: "response.completed", response: { status: "completed" } });
    const wire = Buffer.from("\uFEFF" + (fallback ? JSON.stringify(json) : stream));
    const position = wire.indexOf("SYNTHETIC_PRIVATE_MARKER");
    const bytes = corrupt ? Buffer.concat([wire.subarray(0, position), Buffer.from([0xff]), wire.subarray(position + "SYNTHETIC_PRIVATE_MARKER".length)]) : wire;
    outgoing.writeHead(200, { "Content-Type": fallback ? "application/json" : "text/event-stream" });
    // 在一个合法多字节字符中切块；真实网络可能重新合并，单字节边界由单元测试保证。
    const split = bytes.indexOf(Buffer.from("𠮷")) + 1;
    outgoing.write(bytes.subarray(0, split));
    outgoing.end(bytes.subarray(split));
  });
  await listenForFetch(provider);
  const address = provider.address();
  if (!address || typeof address === "string") throw new Error("Missing provider address");
  try {
    const drillInput = { source: "bank", direction: "前端", count: 3 };
    let seedPath = "";
    let seedDrill: unknown;
    for (const apiFormat of ["openai_chat", "anthropic_messages", "openai_responses"]) {
      format = apiFormat;
      expect((await request.put("/api/settings", { data: {
        base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "synthetic-utf8-key", api_format: format, model_question: "synthetic",
      } })).ok()).toBe(true);
      if (!seedPath) {
        const seed = await request.post("/api/drills", { data: drillInput });
        expect(seed.status(), await seed.text()).toBe(201);
        seedPath = `/api/drills/${(await seed.json()).id}`;
        seedDrill = await (await request.get(seedPath)).json();
      }
      for (const useFallback of [false, true]) {
        fallback = useFallback;
        corrupt = true;
        const before = await (await request.get("/api/drills?limit=50")).json();
        const callsBefore = calls;
        const rejected = await request.post("/api/drills", { data: drillInput });
        expect(rejected.status(), await rejected.text()).toBe(502);
        expect((await rejected.json()).error).toContain("UTF-8");
        expect(await rejected.text()).not.toContain("SYNTHETIC_PRIVATE_MARKER");
        expect(calls).toBe(callsBefore + (fallback ? 2 : 1));
        expect(await (await request.get("/api/drills?limit=50")).json()).toEqual(before);
        expect(await (await request.get(seedPath)).json()).toEqual(seedDrill);
        const logsResponse = await request.get("/api/settings/llm-logs?limit=50");
        expect(logsResponse.ok()).toBe(true);
        expect((await logsResponse.json()).items[0]).toMatchObject({ status: "failed", errorCode: "protocol", attempts: 0 });
        corrupt = false;
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
