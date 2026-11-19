import { afterAll, beforeAll, it, vi } from "vitest";
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createEvaluationSuite } from "../../../../evals/harness";
import { LLM_FEATURES, safeChat, type SafeMessage } from "@/lib/safe-llm";
import { readSettings, writeSettings } from "@/lib/settings";
import { listenForFetch } from "../../../../tests/support/http-server";

// 只由 harness 集成测试收集；手动触发本次信号，不等待真实的 60 秒。
const ids = ["success", "call-error", "named-timeout-only", "deadline-abort", "production-deadline", "deadline-then-raw", "validation-after-call", "invalid-input"];
const evaluate = createEvaluationSuite("project", ids.length, 3200);
const calls: { id: string; timeoutMs: number | undefined; signalMatches: boolean }[] = [];
let requests = 0;
const server = createServer(async (req, res) => {
  for await (const chunk of req) void chunk;
  requests++;
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.flushHeaders(); // 收到响应头后触发专用信号，验证生产层包装取消错误的真实路径。
});

beforeAll(async () => {
  if (process.env.PROMPT_EVAL_LIVE !== "1") return;
  await listenForFetch(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic server unavailable");
  writeSettings({ ...readSettings(), base_url: `http://127.0.0.1:${address.port}/v1`, proxy_enabled: false });
});

for (const id of ids) {
  it(id, async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const system = "仅按原答整理。";
    const messages: SafeMessage[] = [{ role: "user", parts: [{ trust: "untrusted", tag: id === "invalid-input" ? "invalid-tag" : "source", text: "合成回答" }] }];
    try {
      await evaluate({
        id, input: { source: "本人参与测试，结果尚待核实。" }, system, messages,
        rubric: ["只据完整输出核对事实。"],
        call: async options => {
          const { signal } = options;
          calls.push({ id, timeoutMs: timeout.mock.calls[0]?.[0], signalMatches: signal === controller.signal });
          if (id === "production-deadline") return safeChat("evaluate", { feature: LLM_FEATURES.interviewFinish }, system, messages, {
            ...options,
            onHttpStatus: status => {
              options.onHttpStatus(status);
              controller.abort(new DOMException("private-production-deadline-never-copy", "TimeoutError"));
            },
          });
          if (id === "call-error") throw new TypeError("private-call-failure-never-copy");
          // 错误名称不能证明本次评测期限已经触发。
          if (id === "named-timeout-only") throw new DOMException("private-other-timeout-never-copy", "TimeoutError");
          if (id === "deadline-abort" || id === "deadline-then-raw") {
            controller.abort(new DOMException("private-deadline-reason-never-copy", "TimeoutError"));
            if (id === "deadline-abort") throw new Error("private-wrapped-cancellation-never-copy");
          }
          return JSON.stringify({ accepted: true });
        },
        validate: value => {
          if (id === "validation-after-call") {
            controller.abort(new DOMException("private-after-call-never-copy", "TimeoutError"));
            throw new RangeError("private-validator-failure-never-copy");
          }
          return (value as { accepted: boolean }).accepted;
        },
      });
    } finally {
      timeout.mockRestore();
    }
  });
}

afterAll(async () => {
  fs.writeFileSync(path.join(process.env.PROMPT_EVAL_OUTPUT!, "observations.json"), JSON.stringify({ calls, requests }));
  if (server.listening) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
