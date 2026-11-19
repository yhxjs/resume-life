import { afterAll, beforeAll, it, vi } from "vitest";
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { LlmResponseError } from "@/lib/llm-adapter";
import * as safeLlm from "@/lib/safe-llm";
import * as ocrOutput from "@/lib/ocr-output";
import { readSettings, writeSettings } from "@/lib/settings";
import { createEvaluationSuite } from "../../../../evals/harness";
import { createVisionEvaluationSuite } from "../../../../evals/vision-harness";
import { listenForFetch } from "../../../../tests/support/http-server";

// 只由外层集成测试收集；真实调用路径仅连接本机合成服务。
const ids = ["valid", "valid-zero-usage", "valid-no-usage", "length", "unknown-diagnostics", "invalid-code", "direct-protocol", "lookalike", "duck", "input-error", "validation-error", "validation-fail", "post-call-error"];
const vision = process.env.PROMPT_EVAL_ARTIFACT_TEST_VISION === "1";
const live = process.env.PROMPT_EVAL_LIVE === "1";
const evaluateText = vision ? null : createEvaluationSuite("project", ids.length, 8192);
const evaluateVision = vision ? createVisionEvaluationSuite(ids.length) : null;
const privateMarker = "synthetic-private-response-diagnostic-do-not-copy";
let activeId = "";
let requests = 0;
const called: string[] = [], validated: string[] = [];
const server = createServer(async (req, res) => {
  for await (const chunk of req) void chunk;
  requests++;
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  res.end(`data: ${JSON.stringify({
    choices: [{ delta: { content: vision ? "Observed sample" : '{"accepted":true}' }, finish_reason: activeId === "length" ? "length" : "stop" }],
    ...(activeId === "valid-no-usage" ? {} : { usage: activeId === "valid-zero-usage"
      ? { prompt_tokens: 0, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 }, extra: privateMarker }
      : { prompt_tokens: 17, completion_tokens: 23, prompt_tokens_details: { cached_tokens: 5 }, extra: privateMarker } }),
  })}\n\ndata: [DONE]\n\n`);
});

function typedError() {
  return Object.assign(new LlmResponseError(privateMarker, "protocol"), {
    cause: new Error(privateMarker), providerBody: privateMarker, request: { apiKey: privateMarker },
  });
}

async function callOrThrow(call: () => Promise<string>) {
  called.push(activeId);
  if (activeId === "unknown-diagnostics") throw Object.assign(typedError(), {
    reason: privateMarker,
    usage: { inputTokens: 7, outputTokens: -1, cachedTokens: Infinity, extra: privateMarker },
  });
  if (activeId === "invalid-code") throw Object.assign(typedError(), { code: privateMarker });
  if (activeId === "direct-protocol") throw typedError();
  if (activeId === "lookalike") throw Object.assign(new Error(privateMarker), {
    name: "LlmResponseError", code: "incomplete", reason: "output_limit",
    usage: { inputTokens: 1, outputTokens: 2, cachedTokens: 0 },
  });
  if (activeId === "duck") throw { code: "incomplete", reason: "output_limit", message: privateMarker };
  const result = await call();
  if (activeId === "post-call-error") throw new RangeError(privateMarker);
  return result;
}

beforeAll(async () => {
  const originalTextCheck = safeLlm.checkSafeModelInput;
  vi.spyOn(safeLlm, "checkSafeModelInput").mockImplementation((...args) => {
    if (activeId === "input-error") throw typedError();
    return originalTextCheck(...args);
  });
  const originalVisionCheck = safeLlm.checkSafeVisionModelInput;
  vi.spyOn(safeLlm, "checkSafeVisionModelInput").mockImplementation((...args) => {
    if (activeId === "input-error") throw typedError();
    return originalVisionCheck(...args);
  });
  const originalVisionChat = safeLlm.safeVisionChat;
  vi.spyOn(safeLlm, "safeVisionChat").mockImplementation((...args) => callOrThrow(() => originalVisionChat(...args)));
  const originalHasOcrText = ocrOutput.hasOcrText;
  vi.spyOn(ocrOutput, "hasOcrText").mockImplementation(value => {
    validated.push(activeId);
    if (activeId === "validation-error") throw typedError();
    if (activeId === "validation-fail") return false;
    return originalHasOcrText(value);
  });
  if (!live) return;
  await listenForFetch(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic server unavailable");
  writeSettings({ ...readSettings(), base_url: `http://127.0.0.1:${address.port}/v1`, proxy_enabled: false });
});

for (const id of ids) {
  it(id, async () => {
    activeId = id;
    const system = "只使用给定材料。";
    const rubric = ["未取得完整正文时保留未知；有限诊断不替代语义审阅。"];
    if (evaluateVision) {
      await evaluateVision({
        id, system, rubric,
        pages: [{ pageNumber: 1, svg: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><text x="2" y="20">Sample</text></svg>' }],
        referenceText: "Sample",
      });
    } else {
      const messages: safeLlm.SafeMessage[] = [{ role: "user", parts: [{ trust: "untrusted", tag: "source", text: "合成材料" }] }];
      await evaluateText!({
        id, system, rubric, messages, input: { source: "合成材料" },
        call: options => callOrThrow(() => safeLlm.safeChat("evaluate", { feature: safeLlm.LLM_FEATURES.defenseDrillGrade }, system, messages, options)),
        validate: value => {
          validated.push(activeId);
          if (activeId === "validation-error") throw typedError();
          if (activeId === "validation-fail") return false;
          return (value as { accepted: boolean }).accepted;
        },
      });
    }
  });
}

afterAll(async () => {
  fs.writeFileSync(path.join(process.env.PROMPT_EVAL_OUTPUT!, "observations.json"), JSON.stringify({ called, validated, requests }));
  vi.restoreAllMocks();
  if (server.listening) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
