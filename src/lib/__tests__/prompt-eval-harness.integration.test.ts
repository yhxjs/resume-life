import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const directories: string[] = [];
const syntheticKey = "synthetic-harness-key-never-a-real-credential";
// Windows coverage 并行运行时，嵌套 Vitest 启动与原生图像模块加载可能超过 20 秒。
// 仅放宽测试子进程的总预算；各 fixture 的模型调用期限仍由独立断言校验。
const fixtureProcessTimeoutMs = process.platform === "win32" ? 60_000 : 20_000;
const fixtureTestTimeoutMs = fixtureProcessTimeoutMs + 5_000;

type RateLimitMode = "stop" | "recover" | "cancel-after-429" | "cancel-on-429" | "recover-then-cancel" | "recover-invalid-json" | "503-then-cancel" | "cancel-without-headers";

async function runFixture(live: boolean, ids?: readonly string[], vision = false, completeness?: "complete" | "skipped" | "missing" | "extra", rateLimit?: RateLimitMode, deadline = false, timeoutMs?: string, responseError = false, progress = false) {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), `resume-life-${vision ? "vision" : "prompt"}-eval-harness-`));
  directories.push(output);
  const config = path.join(output, "vitest.config.mjs");
  fs.writeFileSync(config, `export default ${JSON.stringify({
    root: process.cwd(),
    resolve: { alias: { "@": path.resolve("src") } },
    test: {
      include: [`src/lib/__tests__/fixtures/prompt-eval-${progress ? "progress" : responseError ? "response-error" : deadline ? "deadline" : rateLimit ? "rate-limit" : completeness ? "completeness" : ids ? "artifact-ids" : "failures"}.fixture.ts`],
      environment: "node", maxWorkers: 1,
    },
  })};`);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("PROMPT_EVAL_")) delete env[key];
  const child = spawn(process.execPath, [
    path.resolve("node_modules/vitest/vitest.mjs"), "run", "--config", config,
    "--reporter=json", "--outputFile", path.join(output, "vitest.json"),
  ], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...env, PROMPT_EVAL_LIVE: live ? "1" : "0", PROMPT_EVAL_OUTPUT: output,
      ...(timeoutMs === undefined ? {} : { PROMPT_EVAL_TIMEOUT_MS: timeoutMs }),
      PROMPT_EVAL_ARTIFACT_TEST_IDS: JSON.stringify(ids ?? []), PROMPT_EVAL_ARTIFACT_TEST_VISION: vision ? "1" : "0",
      PROMPT_EVAL_COMPLETENESS_TEST: completeness ?? "",
      PROMPT_EVAL_RATE_LIMIT_TEST: rateLimit ?? "",
      VISION_EVAL_LIVE: responseError && live ? "1" : "0", VISION_EVAL_OUTPUT: output,
      ...(responseError ? {
        VISION_EVAL_MODEL: "synthetic-model", VISION_EVAL_API_KEY: syntheticKey,
        VISION_EVAL_BASE_URL: "https://synthetic.invalid/v1", VISION_EVAL_API_FORMAT: "openai_chat",
      } : {}),
      PROMPT_EVAL_MODEL: "synthetic-model", PROMPT_EVAL_API_KEY: syntheticKey,
      PROMPT_EVAL_BASE_URL: "https://synthetic.invalid/v1", PROMPT_EVAL_API_FORMAT: "openai_chat",
      RESUME_LIFE_DATA_DIR: path.join(output, "data"), RESUME_LIFE_SETTINGS_KEY: randomBytes(32).toString("hex"),
    },
  });
  let text = "";
  child.stdout.on("data", data => { text += data; });
  child.stderr.on("data", data => { text += data; });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Harness fixture exceeded ${fixtureProcessTimeoutMs / 1000}s`)); }, fixtureProcessTimeoutMs);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", status => { clearTimeout(timer); resolve(status); });
  });
  const read = (name: string) => JSON.parse(fs.readFileSync(path.join(output, `${name}.json`), "utf8"));
  return { code, text, output, read };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    const target = path.resolve(directory);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !/^resume-life-(?:prompt|vision)-eval-harness-/.test(path.basename(target))) {
      throw new Error("Unsafe harness test cleanup path");
    }
    fs.rmSync(target, { recursive: true, force: true });
  }
});

describe("评估失败报告（真实输入预检与 Vitest 生命周期，合成调用）", () => {
  it.each([false, true])("请求进度区分收到字节、解析内容和完整交付，且只保留有限元数据，live=%s", async live => {
    const result = await runFixture(live, undefined, false, undefined, undefined, false, undefined, false, true);
    expect(result.code).toBe(1);
    const summary = result.read("summary");
    const observations = result.read("observations");
    expect(summary).toMatchObject({
      schemaVersion: 4, expectedSamples: 11, recordedSamples: 11, status: "failed",
      protocolCounts: live ? { pass: 5, fail: 1, error: 5, "not-run": 0 } : { pass: 0, fail: 0, error: 1, "not-run": 10 },
    });
    const fields = ["requestIndex", "attempt", "stream", "phase", "elapsedMs", "httpStatus", "headersMs", "firstByteMs",
      "lastByteMs", "responseBytes", "firstContentMs", "lastContentMs", "contentBytes", "outcome", "abortKind"].sort();
    for (const entry of summary.results) {
      const record = result.read(entry.id);
      expect(record.observedRequests.length).toBeLessThanOrEqual(16);
      expect(record.semanticReviewItems[0].verdict).toBe("pending");
      for (const request of record.observedRequests) expect(Object.keys(request).sort()).toEqual(fields);
      if (!live || entry.id === "invalid-input") expect(record.observedRequests).toEqual([]);
    }
    if (!live) {
      expect(observations).toMatchObject({ calls: [], validated: [], requestCounts: {}, wireBytes: {}, deltas: {}, deliveryAtEvents: {} });
      expect(fs.existsSync(path.join(result.output, "data"))).toBe(false);
    } else {
      expect(observations.requestCounts).toEqual({ valid: 1, "headers-cancel": 1, "bytes-cancel": 1, "content-cancel": 1,
        "strict-rejected": 3, "strict-recovered": 2, "json-fallback": 2, "validation-fail": 1 });
      expect(observations.validated).toEqual(["valid", "strict-recovered", "json-fallback", "validation-fail", "malformed-diagnostics", "sparse-diagnostics"]);
      for (const id of ["headers-cancel", "bytes-cancel", "content-cancel"]) {
        const record = result.read(id);
        expect(record).toMatchObject({ protocol: "error", failureStage: "call", raw: null, callDeadlineExceeded: true,
          observedRequests: [{ requestIndex: 0, attempt: 0, stream: true, phase: "ended", httpStatus: 200, outcome: "error", abortKind: "client" }] });
        expect(observations.deltas[id]).toEqual([]);
      }
      expect(result.read("headers-cancel").observedRequests[0]).toMatchObject({
        responseBytes: 0, contentBytes: 0, firstByteMs: null, lastByteMs: null, firstContentMs: null, lastContentMs: null,
      });
      expect(result.read("bytes-cancel").observedRequests[0]).toMatchObject({
        responseBytes: observations.wireBytes["bytes-cancel"][0], contentBytes: 0,
        firstByteMs: expect.any(Number), lastByteMs: expect.any(Number), firstContentMs: null, lastContentMs: null,
      });
      expect(result.read("content-cancel").observedRequests[0]).toMatchObject({
        responseBytes: observations.wireBytes["content-cancel"][0], contentBytes: observations.expectedPartialBytes,
        firstContentMs: expect.any(Number), lastContentMs: expect.any(Number),
      });
      const rejected = result.read("strict-rejected");
      expect(rejected).toMatchObject({ protocol: "error", failureStage: "call", raw: null, callDeadlineExceeded: false });
      expect(rejected.observedRequests.map((request: { requestIndex: number; attempt: number }) => [request.requestIndex, request.attempt])).toEqual([[0, 0], [1, 1], [2, 2]]);
      for (const request of rejected.observedRequests) expect(request).toMatchObject({ phase: "ended", outcome: "complete", abortKind: null, contentBytes: observations.expectedInvalidBytes });
      expect(observations.deltas["strict-rejected"]).toEqual([]);
      expect(result.read("strict-recovered").observedRequests.map((request: { requestIndex: number; attempt: number; contentBytes: number }) => [request.requestIndex, request.attempt, request.contentBytes])).toEqual([[0, 0, observations.expectedInvalidBytes], [1, 1, observations.expectedContentBytes]]);
      expect(result.read("json-fallback").observedRequests).toMatchObject([
        { requestIndex: 0, attempt: 0, stream: true, httpStatus: 400, outcome: "error", responseBytes: 0, contentBytes: 0 },
        { requestIndex: 1, attempt: 0, stream: false, httpStatus: 200, outcome: "complete", responseBytes: observations.wireBytes["json-fallback"][1], contentBytes: observations.expectedContentBytes },
      ]);
      for (const id of ["valid", "strict-recovered", "json-fallback", "validation-fail"]) {
        const record = result.read(id);
        expect(record.raw).toBe('{"accepted":true,"text":"已核对🙂"}');
        expect(observations.deltas[id]).toEqual([record.raw]);
        // The reader emits its final progress event before requireJson releases the buffered text.
        expect(observations.deliveryAtEvents[id].every((event: { delivered: number }) => event.delivered === 0)).toBe(true);
        expect(record.observedRequests.at(-1)).toMatchObject({ contentBytes: observations.expectedContentBytes, outcome: "complete", abortKind: null });
        if (id === "validation-fail") expect(record).toMatchObject({ protocol: "fail", failureStage: "validation" });
        else expect(record.protocol).toBe("pass");
      }
      expect(result.read("valid").observedRequests[0].responseBytes).toBe(observations.wireBytes.valid[0]);
      const malformed = result.read("malformed-diagnostics");
      expect(malformed.protocol).toBe("pass");
      expect(malformed.observedRequests.map((request: { requestIndex: number }) => request.requestIndex)).toEqual(Array.from({ length: 16 }, (_, index) => index));
      expect(malformed.observedRequests.every((request: { contentBytes: number; phase: string }) => request.contentBytes === 0 && request.phase === "started")).toBe(true);
      expect(result.read("sparse-diagnostics").observedRequests).toHaveLength(1);
      expect(result.read("sparse-diagnostics").observedRequests[0].requestIndex).toBe(15);
    }
    const artifacts = fs.readdirSync(result.output).filter(name => name.endsWith(".json"))
      .map(name => fs.readFileSync(path.join(result.output, name), "utf8")).join("\n");
    for (const hidden of [syntheticKey, "private-progress-observer-never-copy", "https://synthetic.invalid/v1"])
      expect(artifacts + result.text).not.toContain(hidden);
  }, fixtureTestTimeoutMs);

  it.each([false, true].flatMap(vision => [false, true].map(live => ({ vision, live }))))(
    "只记录调用阶段 typed 响应错误的有限诊断：vision=$vision，live=$live", async ({ vision, live }) => {
      const result = await runFixture(live, undefined, vision, undefined, undefined, false, undefined, true);
      expect(result.code).toBe(1); // 输入错误在两种模式都存在，真实模式另有合成调用错误。
      const summary = result.read("summary");
      expect(summary).toMatchObject({
        schemaVersion: vision ? 1 : 4, status: "failed", expectedSamples: 13, recordedSamples: 13, missingSamples: 0,
        protocolCounts: live ? { "not-run": 0, pass: 3, fail: 1, error: 9 } : { "not-run": 12, pass: 0, fail: 0, error: 1 },
      });
      for (const entry of summary.results) {
        const record = result.read(entry.id);
        const expected = !live ? null : entry.id === "length"
          ? { code: "incomplete", reason: "output_limit", usage: { inputTokens: 17, outputTokens: 23, cachedTokens: 5 } }
          : entry.id === "unknown-diagnostics"
            ? { code: "protocol", reason: null, usage: { inputTokens: 7, outputTokens: null, cachedTokens: null } }
            : entry.id === "direct-protocol" ? { code: "protocol", reason: null, usage: null } : null;
        expect(record.responseError).toEqual(expected);
        expect(entry.responseError).toEqual(record.responseError);
        const observedUsage = !live ? null
          : ["valid", "length", "validation-error", "validation-fail", "post-call-error"].includes(entry.id)
            ? { inputTokens: 17, outputTokens: 23, cachedTokens: 5 }
            : entry.id === "valid-zero-usage" ? { inputTokens: 0, outputTokens: 0, cachedTokens: 0 }
              : entry.id === "valid-no-usage" ? { inputTokens: null, outputTokens: null, cachedTokens: null } : null;
        expect(record.observedUsage).toEqual(observedUsage);
        expect(entry.observedUsage).toEqual(observedUsage);
        expect(record.semanticReviewItems).toEqual([{ criterion: record.rubric[0], verdict: "pending", evidence: "" }]);
      }
      expect(result.read("input-error")).toMatchObject({ failureStage: "input", protocol: "error", responseError: null, raw: null });
      expect(result.read("valid")).toMatchObject({ failureStage: null, protocol: live ? "pass" : "not-run", responseError: null });
      if (live) {
        expect(result.read("length")).toMatchObject({ failureStage: "call", protocol: "error", raw: null });
        expect(result.read("validation-error")).toMatchObject({ failureStage: "validation", protocol: "error", responseError: null });
        expect(result.read("validation-fail")).toMatchObject({ failureStage: "validation", protocol: "fail", responseError: null });
        expect(result.read("post-call-error")).toMatchObject({ failureStage: "call", protocol: "error", responseError: null, errorType: "RangeError", raw: null });
        expect(result.read("observations")).toEqual({
          called: ["valid", "valid-zero-usage", "valid-no-usage", "length", "unknown-diagnostics", "invalid-code", "direct-protocol", "lookalike", "duck", "validation-error", "validation-fail", "post-call-error"],
          validated: ["valid", "valid-zero-usage", "valid-no-usage", "validation-error", "validation-fail"], requests: 7,
        });
      } else {
        expect(result.read("observations")).toEqual({ called: [], validated: [], requests: 0 });
        expect(fs.existsSync(path.join(result.output, "data"))).toBe(false);
      }
      const artifacts = fs.readdirSync(result.output).filter(name => name.endsWith(".json"))
        .map(name => fs.readFileSync(path.join(result.output, name), "utf8")).join("\n");
      for (const hidden of [syntheticKey, "synthetic-private-response-diagnostic-do-not-copy", "https://synthetic.invalid/v1"]) {
        expect(artifacts + result.text).not.toContain(hidden);
      }
    }, fixtureTestTimeoutMs,
  );

  it.each([
    { live: false, configured: undefined, expectedTimeout: 60_000 },
    { live: true, configured: undefined, expectedTimeout: 60_000 },
    { live: true, configured: "120000", expectedTimeout: 120_000 },
    { live: true, configured: "300000", expectedTimeout: 300_000 },
  ])("评测期限只按调用结束时的专用信号记录，live=$live，timeout=$expectedTimeout", async ({ live, configured, expectedTimeout }) => {
    const result = await runFixture(live, undefined, false, undefined, undefined, true, configured);
    expect(result.code).toBe(1);
    expect(result.read("vitest")).toMatchObject({ numTotalTests: 8, numFailedTests: live ? 6 : 1 });
    const expected: Record<string, boolean | null> = {
      success: live ? false : null,
      "call-error": live ? false : null,
      "named-timeout-only": live ? false : null,
      "deadline-abort": live ? true : null,
      "production-deadline": live ? true : null,
      "deadline-then-raw": live ? true : null,
      "validation-after-call": live ? false : null,
      "invalid-input": null,
    };
    for (const [id, callDeadlineExceeded] of Object.entries(expected)) {
      const record = result.read(id);
      expect(record).toMatchObject({ callDeadlineExceeded, timeoutMs: expectedTimeout });
      expect(result.read("summary").results.find((entry: { id: string }) => entry.id === id)).toMatchObject({ callDeadlineExceeded });
      expect(record.semanticReviewItems).toEqual([{ criterion: "只据完整输出核对事实。", verdict: "pending", evidence: "" }]);
      expect(JSON.stringify(record)).not.toContain("private-");
    }
    expect(result.read("summary").timeoutMs).toBe(expectedTimeout);
    if (live) {
      expect(result.read("deadline-abort")).toMatchObject({ errorType: "Error", failureStage: "call", protocol: "error", raw: null });
      expect(result.read("production-deadline")).toMatchObject({ errorType: "Error", failureStage: "call", protocol: "error", raw: null, observedHttpStatuses: [200] });
      expect(result.read("named-timeout-only")).toMatchObject({ errorType: "TimeoutError", failureStage: "call", protocol: "error" });
      // 诊断标记不替代既有协议判定，也不被之后的校验阶段覆盖。
      expect(result.read("deadline-then-raw")).toMatchObject({ protocol: "pass", raw: '{"accepted":true}' });
      expect(result.read("validation-after-call")).toMatchObject({ errorType: "RangeError", failureStage: "validation", protocol: "error" });
      const calls = result.read("observations").calls;
      expect(calls).toHaveLength(7);
      expect(calls.every((call: { timeoutMs: number; signalMatches: boolean }) => call.timeoutMs === expectedTimeout && call.signalMatches)).toBe(true);
      expect(result.read("observations").requests).toBe(1);
    } else {
      expect(result.read("observations").calls).toEqual([]);
      expect(result.read("observations").requests).toBe(0);
      expect(result.read("success")).toMatchObject({ protocol: "not-run", raw: null });
      expect(fs.existsSync(path.join(result.output, "data"))).toBe(false);
    }
    expect(result.text).not.toContain("private-");
    expect(result.text).not.toContain(syntheticKey);
  }, fixtureTestTimeoutMs);

  it.each([false, true].flatMap(vision => (["complete", "skipped", "missing", "extra"] as const).map(completeness => ({ vision, completeness }))))(
    "样本记录数与预期一致才成功退出：$completeness，vision=$vision", async ({ vision, completeness }) => {
      const result = await runFixture(false, undefined, vision, completeness);
      const complete = completeness === "complete";
      const recorded = completeness === "skipped" || completeness === "missing" ? 1 : 2;
      expect.soft(result.code).toBe(complete ? 0 : 1);
      expect.soft(result.read("vitest")).toMatchObject({ success: complete, numPendingTests: completeness === "skipped" ? 1 : 0 });
      expect(result.read("summary")).toMatchObject({
        status: complete ? "completed" : "incomplete",
        expectedSamples: completeness === "extra" ? 1 : 2,
        recordedSamples: recorded,
        missingSamples: recorded === 1 ? 1 : 0,
        protocolCounts: { "not-run": recorded, pass: 0, fail: 0, error: 0 },
        semanticQuality: "not-evaluated",
      });
      expect(result.read("first")).toMatchObject({ id: "first", raw: null, protocol: "not-run" });
      if (recorded === 2) expect(result.read("second")).toMatchObject({ id: "second", raw: null, protocol: "not-run" });
      else expect(fs.existsSync(path.join(result.output, "second.json"))).toBe(false);
      expect(fs.existsSync(path.join(result.output, "data"))).toBe(false);
    }, fixtureTestTimeoutMs,
  );

  it.each([
    { ids: ["Case-Sample", "case-sample"], kept: "Case-Sample", vision: false },
    { ids: ["Group/Item", "group-item"], kept: "Group/Item", vision: false },
    { ids: ["summary", "valid"], kept: "valid", vision: false },
    { ids: ["SUMMARY", "valid"], kept: "valid", vision: false },
    { ids: ["summary", "valid"], kept: "valid", vision: true },
  ])("拒绝冲突 ID $ids，保留首份报告与汇总，vision=$vision", async ({ ids, kept, vision }) => {
    const result = await runFixture(!vision, ids, vision);
    expect(result.code).toBe(1);
    expect(result.read("vitest")).toMatchObject({ numTotalTests: 2, numFailedTests: 1 });
    expect(result.read("summary")).toMatchObject({
      status: "incomplete", expectedSamples: 2, recordedSamples: 1, missingSamples: 1,
      results: [expect.objectContaining({ id: kept })],
    });
    const record = result.read(kept.replaceAll("/", "-"));
    expect(record.id).toBe(kept);
    if (!vision) {
      expect(record.input).toEqual({ source: `原始材料：${kept}` });
      expect(result.read("observations")).toEqual({ called: [kept] });
    } else {
      expect(record.raw).toBeNull();
      expect(fs.existsSync(path.join(result.output, "data"))).toBe(false);
      expect(fs.readdirSync(result.output).filter(name => /^summary-.*\.png$/.test(name))).toEqual([]);
    }
  }, fixtureTestTimeoutMs);

  it.each([false, true])("预检、调用和校验失败均保留记录且令进程失败，live=%s", async live => {
    const result = await runFixture(live);
    expect(result.code).toBe(1);
    expect(result.read("vitest")).toMatchObject({ numTotalTests: 7, numFailedTests: live ? 6 : 2 });
    const summary = result.read("summary");
    expect(summary.recordedSamples).toBe(7);
    expect(summary).toMatchObject({
      status: "failed", expectedSamples: 7, recordedSamples: 7, missingSamples: 0,
      protocolCounts: live ? { pass: 1, fail: 1, error: 5, "not-run": 0 } : { pass: 0, fail: 0, error: 2, "not-run": 5 },
      semanticQuality: live ? "pending-human-review" : "not-evaluated",
    });
    expect(result.read("observations")).toEqual({
      called: live ? ["valid", "call-error", "invalid-json", "rejected", "validator-error"] : [],
      validated: live ? ["valid", "rejected", "validator-error"] : [],
    });
    for (const id of ["oversized", "invalid-tag"]) {
      const record = result.read(id);
      expect(record).toMatchObject({ id, protocol: "error", failureStage: "input", raw: null, assembledMessages: null, promptHash: null });
      expect(record.errorType).toBe("Error");
      expect(record.inputHash).toBe(createHash("sha256").update(JSON.stringify(record.input)).digest("hex"));
      expect(record.rubric).toHaveLength(1);
      expect(record.semanticReviewItems).toEqual([{ criterion: record.rubric[0], verdict: "pending", evidence: "" }]);
      expect(record.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(summary.results).toContainEqual({ id, protocol: "error", failureStage: "input", semanticReview: record.semanticReview, notRunReason: null, callDeadlineExceeded: null, responseError: null, observedUsage: null });
    }
    expect(result.read("oversized").input.source).toBe("<".repeat(16_000));
    expect(result.read("valid")).toMatchObject({ protocol: live ? "pass" : "not-run", failureStage: null, errorType: null });
    if (live) {
      for (const [id, protocol, errorType, raw] of [
        ["call-error", "error", "TypeError", null],
        ["invalid-json", "error", "SyntaxError", "{invalid-json"],
        ["rejected", "fail", null, '{"accepted":false}'],
        ["validator-error", "error", "RangeError", '{"accepted":true}'],
      ] as const) {
        const record = result.read(id);
        expect(record).toMatchObject({ protocol, errorType, raw, failureStage: id === "call-error" ? "call" : "validation" });
        expect(record.assembledMessages).toHaveLength(2);
        expect(record.promptHash).toBe(createHash("sha256").update(JSON.stringify(record.assembledMessages)).digest("hex"));
      }
    } else {
      expect(fs.existsSync(path.join(result.output, "data"))).toBe(false);
    }
    const artifacts = fs.readdirSync(result.output).filter(name => name.endsWith(".json"))
      .map(name => fs.readFileSync(path.join(result.output, name), "utf8")).join("\n");
    for (const hidden of [syntheticKey, "synthetic-private-call-error-do-not-copy", "synthetic-private-validation-error-do-not-copy"]) {
      expect(artifacts + result.text).not.toContain(hidden);
    }
  }, fixtureTestTimeoutMs);

  it.each([
    { live: true, mode: "stop" },
    { live: true, mode: "recover" },
    { live: false, mode: "stop" },
  ] as const)("HTTP 429 失败停止后续调用，成功恢复继续：$mode，live=$live", async ({ live, mode }) => {
    const result = await runFixture(live, undefined, false, undefined, mode);
    const stopped = live && mode === "stop";
    expect(result.code).toBe(1); // 故意构造的非限流错误仍令整套失败。
    const summary = result.read("summary");
    expect(summary).toMatchObject({
      schemaVersion: 4, status: "failed", expectedSamples: 8, recordedSamples: 8, missingSamples: 0,
      stopReason: stopped ? "http_429" : null,
      protocolCounts: !live ? { "not-run": 7, pass: 0, fail: 0, error: 1 }
        : stopped ? { "not-run": 2, pass: 1, fail: 0, error: 5 } : { "not-run": 0, pass: 4, fail: 0, error: 4 },
    });
    expect(result.read("observations")).toEqual({
      called: !live ? [] : ["http-503", "lookalike-429", "validation-429", "valid", "rate-limit", ...(!stopped ? ["after-first", "after-second"] : [])],
      validated: !live ? [] : ["validation-429", "valid", ...(!stopped ? ["rate-limit", "after-first", "after-second"] : [])],
      requests: !live ? 0 : stopped ? 3 : 4,
    });
    for (const id of ["after-first", "after-second"]) {
      const record = result.read(id);
      expect(record).toMatchObject({
        protocol: !live || stopped ? "not-run" : "pass", failureStage: null, errorType: null, httpStatus: null,
        notRunReason: stopped ? "prior-http-429" : null,
        observedUsage: !live || stopped ? null : { inputTokens: null, outputTokens: null, cachedTokens: null },
        callDeadlineExceeded: !live || stopped ? null : false,
        semanticReview: !live || stopped ? "not-evaluated" : "pending-human-review",
        supplementalProtocols: { optional: !live || stopped ? "not-run" : "pass" },
        maxOutputTokens: 8192, timeoutMs: 60_000,
      });
      expect(record.promptHash).toBe(createHash("sha256").update(JSON.stringify(record.assembledMessages)).digest("hex"));
      expect(record.semanticReviewItems).toEqual([{ criterion: record.rubric[0], verdict: "pending", evidence: "" }]);
      if (!live || stopped) expect(record.raw).toBeNull();
      expect(summary.results).toContainEqual(expect.objectContaining({ id, notRunReason: record.notRunReason, protocol: record.protocol, observedUsage: record.observedUsage }));
    }
    expect(result.read("invalid-after")).toMatchObject({ protocol: "error", failureStage: "input", notRunReason: null, callDeadlineExceeded: null });
    if (live) {
      expect(result.read("rate-limit")).toMatchObject(stopped
        ? { protocol: "error", failureStage: "call", httpStatus: 429, observedHttpStatuses: [429, 429, 429], raw: null, notRunReason: null }
        : { protocol: "pass", failureStage: null, httpStatus: null, observedHttpStatuses: [429, 200] });
      expect(result.read("http-503")).toMatchObject({ protocol: "error", failureStage: "call", httpStatus: 503, observedHttpStatuses: [429] });
      expect(result.read("lookalike-429")).toMatchObject({ protocol: "error", failureStage: "call", httpStatus: null });
      expect(result.read("validation-429")).toMatchObject({ protocol: "error", failureStage: "validation", httpStatus: null });
    }
    const artifacts = fs.readdirSync(result.output).filter(name => name.endsWith(".json"))
      .map(name => fs.readFileSync(path.join(result.output, name), "utf8")).join("\n");
    for (const hidden of [syntheticKey, "synthetic-private-rate-limit-body", "synthetic-private-error-HTTP-429"]) {
      expect(artifacts + result.text).not.toContain(hidden);
    }
  }, fixtureTestTimeoutMs);

  it.each([
    { mode: "cancel-after-429", statuses: [429], stopped: true, requests: 2 },
    { mode: "cancel-on-429", statuses: [429], stopped: true, requests: 1 },
    { mode: "recover-then-cancel", statuses: [429, 200], stopped: false, requests: 4 },
    { mode: "recover-invalid-json", statuses: [429, 200, 200], stopped: false, requests: 5 },
    { mode: "503-then-cancel", statuses: [429, 503], stopped: false, requests: 5 },
    { mode: "cancel-without-headers", statuses: [], stopped: false, requests: 3 },
  ] as const)("失败前最后收到 429 才停止，保留原错误类型：$mode", async ({ mode, statuses, stopped, requests }) => {
    const result = await runFixture(true, undefined, false, undefined, mode);
    expect(result.code).toBe(1);
    expect(result.read("summary")).toMatchObject({
      status: "failed", expectedSamples: 8, recordedSamples: 8, missingSamples: 0,
      stopReason: stopped ? "http_429" : null,
      protocolCounts: { "not-run": stopped ? 2 : 0, pass: stopped ? 1 : 3, fail: 0, error: 5 },
    });
    const record = result.read("rate-limit");
    expect(record).toMatchObject({
      protocol: "error", failureStage: "call", httpStatus: null, observedHttpStatuses: statuses,
      raw: null, notRunReason: null, maxOutputTokens: 8192, timeoutMs: 60_000,
      callDeadlineExceeded: false, // 此组取消来自另一个信号，不是本次评测期限。
    });
    expect(["Error", "TimeoutError"]).toContain(record.errorType);
    expect(result.read("observations")).toEqual({
      called: ["http-503", "lookalike-429", "validation-429", "valid", "rate-limit", ...(!stopped ? ["after-first", "after-second"] : [])],
      validated: ["validation-429", "valid", ...(!stopped ? ["after-first", "after-second"] : [])], requests,
    });
    for (const id of ["after-first", "after-second"]) {
      const after = result.read(id);
      expect(after).toMatchObject({
        protocol: stopped ? "not-run" : "pass", httpStatus: null, observedHttpStatuses: stopped ? [] : [200],
        notRunReason: stopped ? "prior-http-429" : null,
        callDeadlineExceeded: stopped ? null : false,
        semanticReview: stopped ? "not-evaluated" : "pending-human-review",
      });
      expect(after.semanticReviewItems[0].verdict).toBe("pending");
      if (stopped) expect(after.raw).toBeNull();
    }
    expect(result.read("invalid-after")).toMatchObject({ protocol: "error", failureStage: "input", observedHttpStatuses: [] });
  }, fixtureTestTimeoutMs);
});
