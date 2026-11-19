import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const directories: string[] = [];
const servers: Server[] = [];
const syntheticKey = "synthetic-timeout-key-never-a-real-credential";

async function delayedService() {
  const requests: { closedBeforeReply: boolean }[] = [];
  const server = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    const request = { closedBeforeReply: false };
    requests.push(request);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.flushHeaders();
    const timer = setTimeout(() => {
      res.end([
        `data: ${JSON.stringify({ choices: [{ delta: { content: '{"accepted":true}' }, finish_reason: null }] })}`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}`,
        "data: [DONE]",
        "",
      ].join("\n\n"));
    }, 1500);
    res.once("close", () => {
      request.closedBeforeReply = !res.writableEnded;
      clearTimeout(timer);
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic service unavailable");
  return { url: `http://127.0.0.1:${address.port}/v1`, requests };
}

async function runEvaluation(timeoutMs: string | undefined, live: boolean, baseUrl: string) {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-prompt-eval-timeout-"));
  directories.push(output);
  const fixture = path.resolve("src/lib/__tests__/fixtures/prompt-eval-timeout.fixture.ts");
  const config = path.join(output, "vitest.config.mts");
  fs.writeFileSync(config, `
import base from ${JSON.stringify(path.resolve("evals/vitest.config.mts"))};
export default { ...base, root: ${JSON.stringify(process.cwd())}, test: { ...base.test, include: [${JSON.stringify(fixture.split(path.sep).join("/"))}] } };
`);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(PROMPT_EVAL_|VISION_EVAL_)/u.test(key)) delete env[key];
  const child = spawn(process.execPath, [path.resolve("node_modules/vitest/vitest.mjs"), "run", "--config", config], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...env, NODE_OPTIONS: "--experimental-sqlite",
      PROMPT_EVAL_LIVE: live ? "1" : "0", PROMPT_EVAL_OUTPUT: output,
      ...(timeoutMs === undefined ? {} : { PROMPT_EVAL_TIMEOUT_MS: timeoutMs }),
      PROMPT_EVAL_MODEL: "synthetic-model", PROMPT_EVAL_API_KEY: syntheticKey,
      PROMPT_EVAL_BASE_URL: baseUrl, PROMPT_EVAL_API_FORMAT: "openai_chat",
      RESUME_LIFE_DATA_DIR: path.join(output, "data"), RESUME_LIFE_SETTINGS_KEY: randomBytes(32).toString("hex"),
    },
  });
  let text = "";
  child.stdout.on("data", data => { text += data; });
  child.stderr.on("data", data => { text += data; });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("Timeout integration fixture exceeded 20s")); }, 20_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", status => { clearTimeout(timer); resolve(status); });
  });
  expect(text).not.toContain(syntheticKey);
  expect(fs.existsSync(path.join(output, "summary.json")), text).toBe(true);
  const read = (name: string) => JSON.parse(fs.readFileSync(path.join(output, `${name}.json`), "utf8"));
  return { output, code, read, text };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
  for (const directory of directories.splice(0)) {
    const target = path.resolve(directory);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !path.basename(target).startsWith("resume-life-prompt-eval-timeout-")) {
      throw new Error("Unsafe timeout test cleanup path");
    }
    fs.rmSync(target, { recursive: true, force: true });
  }
});

describe("评测期限的实际调用边界（仅本地合成 SSE）", () => {
  it("相同延迟在短期限下取消，在较长期限下完成，保留两份真实报告", async () => {
    const service = await delayedService();
    const short = await runEvaluation("500", true, service.url);
    expect(short.code).toBe(1);
    expect(short.read("summary")).toMatchObject({ status: "failed", timeoutMs: 500, recordedSamples: 1, missingSamples: 0 });
    expect(short.read("delayed-answer")).toMatchObject({ timeoutMs: 500, protocol: "error", failureStage: "call", raw: null, callDeadlineExceeded: true, observedHttpStatuses: [200] });
    expect(service.requests).toEqual([{ closedBeforeReply: true }]);

    const longer = await runEvaluation("5000", true, service.url);
    expect(longer.code).toBe(0);
    expect(longer.read("summary")).toMatchObject({ status: "completed", timeoutMs: 5000, recordedSamples: 1, missingSamples: 0, semanticQuality: "pending-human-review" });
    expect(longer.read("delayed-answer")).toMatchObject({ timeoutMs: 5000, protocol: "pass", failureStage: null, raw: '{"accepted":true}', callDeadlineExceeded: false, observedHttpStatuses: [200] });
    expect(longer.read("delayed-answer").semanticReviewItems[0].verdict).toBe("pending");
    expect(service.requests).toEqual([{ closedBeforeReply: true }, { closedBeforeReply: false }]);
  }, 45_000);

  it.each([false, true].flatMap(live => ["", "300001"].map(timeoutMs => ({ live, timeoutMs }))))(
    "无效期限保留失败汇总且零调用、零数据库：live=$live，timeout=$timeoutMs", async ({ live, timeoutMs }) => {
      const service = await delayedService();
      const result = await runEvaluation(timeoutMs, live, service.url);
      expect(result.code).toBe(1);
      expect(result.read("summary")).toMatchObject({ schemaVersion: 4, timeoutMs: null, status: "incomplete", expectedSamples: 1, recordedSamples: 0, missingSamples: 1 });
      expect(result.text).toContain("PROMPT_EVAL_TIMEOUT_MS");
      expect(service.requests).toEqual([]);
      expect(fs.existsSync(path.join(result.output, "data"))).toBe(false);
      expect(fs.existsSync(path.join(result.output, "delayed-answer.json"))).toBe(false);
    }, 25_000,
  );

  it("非默认期限的快照只记录参数，不调用模型或创建数据库", async () => {
    const service = await delayedService();
    const result = await runEvaluation("120000", false, service.url);
    expect(result.code).toBe(0);
    expect(result.read("summary")).toMatchObject({ timeoutMs: 120_000, status: "completed", semanticQuality: "not-evaluated" });
    expect(result.read("delayed-answer")).toMatchObject({ timeoutMs: 120_000, protocol: "not-run", raw: null, callDeadlineExceeded: null });
    expect(service.requests).toEqual([]);
    expect(fs.existsSync(path.join(result.output, "data"))).toBe(false);
  }, 25_000);
});
