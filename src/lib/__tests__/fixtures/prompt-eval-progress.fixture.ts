import { afterAll, beforeAll, it, vi } from "vitest";
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createEvaluationSuite } from "../../../../evals/harness";
import { listenForFetch } from "../../../../tests/support/http-server";
import { LLM_FEATURES, safeChatStream, type SafeMessage } from "@/lib/safe-llm";
import type { LlmProgressObserver, LlmRequestProgress } from "@/lib/llm-request-progress";
import { readSettings, writeSettings } from "@/lib/settings";

// Collected only by the outer integration test; every transport call uses this loopback server.
const ids = ["valid", "headers-cancel", "bytes-cancel", "content-cancel", "strict-rejected",
  "strict-recovered", "json-fallback", "validation-fail", "malformed-diagnostics", "sparse-diagnostics", "invalid-input"];
const evaluate = createEvaluationSuite("project", ids.length, 3200);
const privateMarker = "private-progress-observer-never-copy";
const validContent = '{"accepted":true,"text":"已核对🙂"}';
const partialContent = `{"accepted":true,"text":"${privateMarker}`;
const comment = `: ${privateMarker}\n\n`;
const sse = (content: string, complete = true) => `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: complete ? "stop" : null }] })}\n\n${complete ? "data: [DONE]\n\n" : ""}`;
let activeId = "";
const requestCounts: Record<string, number> = {};
const wireBytes: Record<string, number[]> = {};
const calls: string[] = [], validated: string[] = [];
const deltas: Record<string, string[]> = {};
const deliveryAtEvents: Record<string, { phase: string; delivered: number }[]> = {};
let previousObserver: LlmProgressObserver | undefined;
const server = createServer(async (req, res) => {
  for await (const chunk of req) void chunk;
  const count = requestCounts[activeId] = (requestCounts[activeId] ?? 0) + 1;
  const send = (status: number, contentType: string, body: string, end = true) => {
    (wireBytes[activeId] ??= []).push(Buffer.byteLength(body, "utf8"));
    res.writeHead(status, { "Content-Type": contentType });
    if (end) res.end(body);
    else { res.flushHeaders(); if (body) res.write(body); }
  };
  if (activeId === "headers-cancel") return send(200, "text/event-stream", "", false);
  if (activeId === "bytes-cancel") return send(200, "text/event-stream", comment, false);
  if (activeId === "content-cancel") return send(200, "text/event-stream", sse(partialContent, false), false);
  if (activeId === "json-fallback") return count === 1
    ? send(400, "text/plain", privateMarker)
    : send(200, "application/json", JSON.stringify({ choices: [{ message: { content: validContent }, finish_reason: "stop" }] }));
  const content = activeId === "strict-rejected" || (activeId === "strict-recovered" && count === 1) ? privateMarker : validContent;
  send(200, "text/event-stream", sse(content));
});

beforeAll(async () => {
  if (process.env.PROMPT_EVAL_LIVE !== "1") return;
  await listenForFetch(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic server unavailable");
  writeSettings({ ...readSettings(), base_url: `http://127.0.0.1:${address.port}/v1`, proxy_enabled: false });
});

const metadata = (requestIndex = 0): LlmRequestProgress => ({
  requestIndex, attempt: 0, stream: true, phase: "started", elapsedMs: 0,
  httpStatus: null, headersMs: null, firstByteMs: null, lastByteMs: null, responseBytes: 0,
  firstContentMs: null, lastContentMs: null, contentBytes: 0, outcome: null, abortKind: null,
});

for (const id of ids) {
  it(id, async () => {
    activeId = id;
    const controller = new AbortController();
    // Trigger the harness-owned deadline at a known read stage, without waiting 60 seconds.
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const system = "仅按原答整理。";
    const messages: SafeMessage[] = [{ role: "user", parts: [{ trust: "untrusted", tag: id === "invalid-input" ? "invalid-tag" : "source", text: "合成回答" }] }];
    try {
      await evaluate({
        id, input: { source: "本人参与测试，结果尚待核实。" }, system, messages,
        rubric: ["观察到文本不代表完整交付或语义正确。"],
        call: async options => {
          calls.push(id);
          const delivered: string[] = [];
          const events: { phase: string; delivered: number }[] = [];
          deltas[id] = delivered;
          deliveryAtEvents[id] = events;
          if (id === "malformed-diagnostics") {
            const emit = options.onRequestProgress as (value: unknown) => void;
            const original = { ...metadata(15), extra: privateMarker, toJSON: () => ({ leaked: privateMarker }) };
            emit(original);
            original.contentBytes = 987654;
            emit(null);
            emit({ get requestIndex() { throw new Error(privateMarker); } });
            const revoked = Proxy.revocable({}, {});
            revoked.revoke();
            emit(revoked.proxy);
            for (const field of Object.keys(metadata())) emit({ ...metadata(15), [field]: privateMarker });
            for (const responseBytes of [-1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) emit({ ...metadata(15), responseBytes });
            for (const requestIndex of [-1, 1.5, Infinity, 16, 1000000]) emit(metadata(requestIndex));
            for (let index = 14; index >= 0; index--) emit(metadata(index));
            previousObserver = options.onRequestProgress;
            return validContent;
          }
          if (id === "sparse-diagnostics") {
            // A later sample cannot change a previous sample after its call has settled.
            previousObserver?.({ ...metadata(), contentBytes: 999999 });
            options.onRequestProgress(metadata(15));
            return validContent;
          }
          return safeChatStream("evaluate", { feature: LLM_FEATURES.interviewFinish }, system, messages,
            delta => { delivered.push(delta); }, {
              ...options,
              onRequestProgress: event => {
                options.onRequestProgress(event);
                events.push({ phase: event.phase, delivered: delivered.length });
                const cancelPhase = id === "headers-cancel" ? "headers" : id === "bytes-cancel" ? "first-byte" : id === "content-cancel" ? "first-content" : null;
                if (event.phase === cancelPhase) controller.abort(new DOMException(privateMarker, "TimeoutError"));
              },
            });
        },
        validate: value => {
          validated.push(id);
          // Validation runs after the call has settled but before its report is saved.
          if (id === "malformed-diagnostics") previousObserver?.({ ...metadata(), contentBytes: 999999 });
          return id !== "validation-fail" && (value as { accepted: boolean }).accepted;
        },
      });
    } finally {
      timeout.mockRestore();
    }
  });
}

afterAll(async () => {
  fs.writeFileSync(path.join(process.env.PROMPT_EVAL_OUTPUT!, "observations.json"), JSON.stringify({
    calls, validated, requestCounts, wireBytes, deltas, deliveryAtEvents,
    expectedContentBytes: Buffer.byteLength(validContent, "utf8"),
    expectedPartialBytes: Buffer.byteLength(partialContent, "utf8"),
    expectedInvalidBytes: Buffer.byteLength(privateMarker, "utf8"),
  }));
  if (server.listening) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
