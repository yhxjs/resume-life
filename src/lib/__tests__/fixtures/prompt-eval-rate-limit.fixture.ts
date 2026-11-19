import { afterAll, beforeAll, it } from "vitest";
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { LlmHttpError } from "@/lib/llm";
import { LLM_FEATURES, safeChat, type SafeMessage } from "@/lib/safe-llm";
import { readSettings, writeSettings } from "@/lib/settings";
import { createEvaluationSuite } from "../../../../evals/harness";
import { listenForFetch } from "../../../../tests/support/http-server";

// 仅由外层集成测试收集；HTTP 只访问本机合成服务。
const ids = ["http-503", "lookalike-429", "validation-429", "valid", "rate-limit", "after-first", "invalid-after", "after-second"];
const evaluate = createEvaluationSuite("project", ids.length, 8192);
const live = process.env.PROMPT_EVAL_LIVE === "1";
const mode = process.env.PROMPT_EVAL_RATE_LIMIT_TEST;
const called: string[] = [], validated: string[] = [];
let requests = 0;
let cancellation: AbortController | undefined;
const server = createServer(async (req, res) => {
  for await (const chunk of req) void chunk;
  requests++;
  if ((mode === "cancel-after-429" && requests === 2)
    || (mode === "cancel-without-headers" && requests === 1)
    || (mode === "503-then-cancel" && requests === 3)) {
    cancellation?.abort(new DOMException("Synthetic deadline", "TimeoutError"));
    return; // 取消发生在此请求返回任何响应头之前。
  }
  if (mode === "stop" || requests === 1) {
    res.writeHead(429, { "Content-Type": "text/plain", "Retry-After": "0" });
    res.end("synthetic-private-rate-limit-body");
  } else if (mode === "503-then-cancel" && requests === 2) {
    res.writeHead(503, { "Retry-After": "0" });
    res.end();
  } else if (mode === "recover-then-cancel" && requests === 2) {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.flushHeaders(); // 回调确认真实 200 后取消，避免依赖机器速度。
  } else if (mode === "recover-invalid-json" && called.at(-1) === "rate-limit") {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "invalid-json" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  } else {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: '{"accepted":true}' }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  }
});

beforeAll(async () => {
  if (!live) return;
  await listenForFetch(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic server unavailable");
  writeSettings({ ...readSettings(), base_url: `http://127.0.0.1:${address.port}/v1`, proxy_enabled: false });
});

for (const id of ids) {
  it(id, async () => {
    const system = "依据给定材料输出 JSON。";
    const messages: SafeMessage[] = [{ role: "user", parts: [{ trust: "untrusted", tag: id === "invalid-after" ? "invalid-tag" : "source", text: "已完成代码，验证状态待核实。" }] }];
    await evaluate({
      id, input: { source: "已完成代码，验证状态待核实。" }, system, messages,
      rubric: ["仅审阅真实取得的输出，未调用不能作为语义通过。"],
      call: async options => {
        called.push(id);
        if (id === "http-503") {
          options.onHttpStatus(429); // 模拟包装器残留状态，最终 typed HTTP 错误必须优先。
          throw new LlmHttpError(503, null);
        }
        if (id === "lookalike-429") throw Object.assign(new Error("synthetic-private-error-HTTP-429"), { status: 429 });
        if (["rate-limit", "after-first", "after-second"].includes(id)) {
          if (id !== "rate-limit") return safeChat("evaluate", { feature: LLM_FEATURES.defenseDrillGrade }, system, messages, options);
          cancellation = new AbortController();
          return safeChat("evaluate", { feature: LLM_FEATURES.defenseDrillGrade }, system, messages, {
            ...options, signal: AbortSignal.any([options.signal, cancellation.signal]),
            onHttpStatus: status => {
              options.onHttpStatus(status);
              if ((mode === "recover-then-cancel" && status === 200)
                || (mode === "cancel-on-429" && status === 429)) {
                queueMicrotask(() => cancellation?.abort(new DOMException("Synthetic deadline", "TimeoutError")));
              }
            },
          });
        }
        return '{"accepted":true}';
      },
      validate: value => {
        validated.push(id);
        if (id === "validation-429") throw new LlmHttpError(429, null);
        return (value as { accepted: boolean }).accepted;
      },
      supplementalValidators: { optional: () => "pass" },
    });
  });
}

afterAll(async () => {
  fs.writeFileSync(path.join(process.env.PROMPT_EVAL_OUTPUT!, "observations.json"), JSON.stringify({ called, validated, requests }));
  if (server.listening) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
