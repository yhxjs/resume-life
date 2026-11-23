import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listenForFetch } from "../../../tests/support/http-server";

type Result = { id: string; protocol: string; notRunReason: string | null };
type Summary = {
  suite: string;
  mode: string;
  expectedSamples: number;
  recordedSamples: number;
  missingSamples: number;
  status: string;
  results: Result[];
  protocolCounts: Record<string, number>;
  stopReason: string | null;
  selection?: { suiteSamples: number; requestedIds: string[] };
};
type Sample = {
  id: string;
  input: unknown;
  rubric: string[];
  assembledMessages: { role: string; content: string }[];
  inputHash: string;
  promptHash: string;
  raw: string | null;
  protocol: string;
  semanticReview: string;
  notRunReason: string | null;
};
type Run = { code: number | null; text: string; output: string | undefined; summary: Summary | null };
type RequestBody = { model: string; messages: Sample["assembledMessages"]; stream?: boolean };

const directories: string[] = [];
const servers: Server[] = [];
const syntheticKey = "synthetic-selection-key-never-a-real-credential";
const reviewSuite = "--suite=application-interview-review";
const selectedIds = ["role-scope-material-only", "role-scope-memory-uncertain"];
const cliArgs = (ids: string[]) => ids.map(id => `--sample=${id}`);

async function service(rateLimited = false) {
  const requests: RequestBody[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body) as RequestBody);
    if (rateLimited) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "0" });
      res.end(JSON.stringify({ error: { message: "Synthetic local rate limit" } }));
      return;
    }
    const content = JSON.stringify({ mistakes: [], drills: [], resume_suggestions: [] });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`
      + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`
      + "data: [DONE]\n\n");
  });
  servers.push(server);
  await listenForFetch(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing local test endpoint");
  return {
    requests,
    config: {
      PROMPT_EVAL_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      PROMPT_EVAL_API_KEY: syntheticKey,
      PROMPT_EVAL_MODEL: "synthetic-selection-model",
    },
  };
}

async function run(args: string[], config: Record<string, string> = {}): Promise<Run> {
  const sentinel = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-eval-sentinel-"));
  directories.push(sentinel);
  fs.writeFileSync(path.join(sentinel, "sentinel.txt"), "unchanged");
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(?:PROMPT_EVAL_|VISION_EVAL_)/.test(key)
      || ["NODE_OPTIONS", "RESUME_LIFE_SETTINGS_KEY", "RESUME_LIFE_SSE_DIAGNOSTICS"].includes(key)) delete env[key];
  }
  const child = spawn(process.execPath, [path.resolve("scripts/eval-prompts.mjs"), ...args], {
    env: { ...env, ...config, NODE_OPTIONS: "--experimental-sqlite", RESUME_LIFE_DATA_DIR: sentinel },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let text = "";
  child.stdout.on("data", data => { text += data; });
  child.stderr.on("data", data => { text += data; });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Selection CLI test exceeded 20s"));
    }, 20_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", status => { clearTimeout(timer); resolve(status); });
  });
  expect(fs.readdirSync(sentinel)).toEqual(["sentinel.txt"]);
  expect(fs.readFileSync(path.join(sentinel, "sentinel.txt"), "utf8")).toBe("unchanged");
  expect(text).not.toContain(syntheticKey);
  const output = text.match(/(?:提示词快照（零模型调用）|真实模型评估)：([^\r\n]+)/)?.[1];
  if (output) directories.push(output);
  // 全部名称不匹配时 Vitest 不执行 hook；缺 summary 必须留给测试核对非零退出。
  const summaryPath = output && path.join(output, "summary.json");
  const summary = summaryPath && fs.existsSync(summaryPath)
    ? JSON.parse(fs.readFileSync(summaryPath, "utf8")) as Summary : null;
  return { code, text, output, summary };
}

function outputOf(result: Run): string {
  expect(result.output, result.text).toBeDefined();
  return result.output!;
}

function sampleOf(result: Run, id: string): Sample {
  return JSON.parse(fs.readFileSync(path.join(outputOf(result), `${id.replaceAll("/", "-")}.json`), "utf8")) as Sample;
}

function expectOnlySamples(result: Run, ids: string[]) {
  expect(result.summary?.results.map(entry => entry.id)).toEqual(ids);
  expect(fs.readdirSync(outputOf(result)).filter(file => file.endsWith(".json") && file !== "summary.json").sort())
    .toEqual(ids.map(id => `${id.replaceAll("/", "-")}.json`).sort());
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
  for (const directory of directories.splice(0)) {
    const target = path.resolve(directory);
    if (path.dirname(target) !== path.resolve(os.tmpdir())
      || !/^resume-life-(?:prompt-eval-|eval-sentinel-)/.test(path.basename(target))) {
      throw new Error("Unsafe selection test cleanup path");
    }
    fs.rmSync(target, { recursive: true, force: true });
  }
});

describe("提示词评估精确选样入口（仅本地合成请求）", () => {
  it("两例快照保留全套的输入与提示，CLI顺序不改变套件顺序，残留选择和live环境不生效", async () => {
    const local = await service();
    const config = { ...local.config, PROMPT_EVAL_LIVE: "1", PROMPT_EVAL_SAMPLE_IDS: '["does-not-exist"]' };
    const full = await run([reviewSuite], config);
    expect(full.code, full.text).toBe(0);
    expect(full.summary).toMatchObject({ mode: "snapshot", expectedSamples: 10, recordedSamples: 10, missingSamples: 0 });
    expect(full.summary).not.toHaveProperty("selection");
    const requestedIds = [...selectedIds].reverse();
    const selected = await run([reviewSuite, ...cliArgs(requestedIds)], config);
    expect(selected.code, selected.text).toBe(0);
    expect(selected.summary).toMatchObject({
      mode: "snapshot", expectedSamples: 2, recordedSamples: 2, missingSamples: 0, status: "completed",
      selection: { suiteSamples: 10, requestedIds }, protocolCounts: { "not-run": 2, pass: 0, fail: 0, error: 0 },
    });
    expectOnlySamples(selected, selectedIds);
    for (const id of selectedIds) {
      const original = sampleOf(full, id);
      const sample = sampleOf(selected, id);
      for (const key of ["id", "input", "rubric", "assembledMessages", "inputHash", "promptHash"] as const) {
        expect(sample[key]).toEqual(original[key]);
      }
      expect(sample).not.toHaveProperty("selection");
      expect(sample.raw).toBeNull();
      expect(sample.semanticReview).toBe("not-evaluated");
    }
    expect(local.requests).toHaveLength(0);
    for (const result of [full, selected]) expect(fs.existsSync(path.join(outputOf(result), "data"))).toBe(false);
  }, 45_000);

  it("含斜杠的完整ID只选择指定动作，保留原ID与兼容文件名", async () => {
    const id = "qualitative-maintenance/regenerate-30s";
    const result = await run(["--suite=intro", `--sample=${id}`]);
    expect(result.code, result.text).toBe(0);
    expect(result.summary).toMatchObject({ expectedSamples: 1, recordedSamples: 1, missingSamples: 0, selection: { requestedIds: [id] } });
    expect(result.summary!.selection!.suiteSamples).toBeGreaterThan(1);
    expectOnlySamples(result, [id]);
    expect(sampleOf(result, id).id).toBe(id);
    expect(fs.existsSync(path.join(outputOf(result), "data"))).toBe(false);
  });

  it.each([
    "qualitative-maintenance",
    "qualitative-maintenance-regenerate-30s",
    "Qualitative-maintenance/regenerate-30s",
  ])("不把近似ID %s 当作精确匹配，全跳过仍非零且不建库", async id => {
    const local = await service();
    const result = await run(["--suite=intro", "--live", `--sample=${id}`], local.config);
    expect(result.code, result.text).not.toBe(0);
    expect(result.summary).toBeNull();
    expect(local.requests).toHaveLength(0);
    expect(fs.existsSync(path.join(outputOf(result), "data"))).toBe(false);
  });

  it("已知加未知ID在首个调用前失败，不建设置库也不请求已知项", async () => {
    const local = await service();
    const requestedIds = [selectedIds[0]!, "does-not-exist"];
    const result = await run([reviewSuite, "--live", ...cliArgs(requestedIds)], local.config);
    expect(result.code, result.text).not.toBe(0);
    expect(result.summary).toMatchObject({
      mode: "live", status: "incomplete", expectedSamples: 2, recordedSamples: 0, missingSamples: 2,
      selection: { suiteSamples: 10, requestedIds }, results: [],
    });
    expect(local.requests).toHaveLength(0);
    expect(fs.existsSync(path.join(outputOf(result), "data"))).toBe(false);
  });

  it.each([
    ["empty", ["--sample="]],
    ["duplicate", cliArgs([selectedIds[0]!, selectedIds[0]!])],
    ["path collision", cliArgs(["a/b", "a-b"])],
    ["case collision", cliArgs(["Case", "case"])],
    ["regular expression", ["--sample=role-scope-.*"]],
    ["path traversal", ["--sample=../sample"]],
    ["reserved summary", ["--sample=summary"]],
    ["Windows device", ["--sample=CON"]],
    ["separate value", ["--sample", selectedIds[0]!]],
    ["duplicate suite", [reviewSuite, ...cliArgs(selectedIds)]],
    ["duplicate live", ["--live", "--live", ...cliArgs(selectedIds)]],
  ] as const)("拒绝%s参数且不创建运行目录", async (_name, extra) => {
    const result = await run([reviewSuite, ...extra]);
    expect(result.code, result.text).toBe(1);
    expect(result.output).toBeUndefined();
    expect(result.summary).toBeNull();
  });

  it("repo-scan明确拒绝选样，不启动独立离线套件", async () => {
    const result = await run(["--suite=repo-scan", "--sample=anything"]);
    expect(result.code, result.text).toBe(1);
    expect(result.output).toBeUndefined();
  });

  it("合成live只请求所选两例，并保持实际请求与各样本完整消息一致", async () => {
    const local = await service();
    const requestedIds = [...selectedIds].reverse();
    const result = await run([reviewSuite, "--live", ...cliArgs(requestedIds)], local.config);
    expect(result.code, result.text).toBe(0);
    expect(result.summary).toMatchObject({
      mode: "live", expectedSamples: 2, recordedSamples: 2, missingSamples: 0, status: "completed",
      selection: { suiteSamples: 10, requestedIds }, protocolCounts: { pass: 2, fail: 0, error: 0, "not-run": 0 },
    });
    expectOnlySamples(result, selectedIds);
    expect(local.requests).toHaveLength(2);
    for (const [index, id] of selectedIds.entries()) {
      const sample = sampleOf(result, id);
      expect(local.requests[index]).toMatchObject({ model: "synthetic-selection-model", messages: sample.assembledMessages, stream: true });
      expect(JSON.parse(sample.raw!)).toEqual({ mistakes: [], drills: [], resume_suggestions: [] });
      expect(sample.semanticReview).toBe("pending-human-review");
    }
  });

  it("429沿生产重试后只将选中的后续样本记为未运行", async () => {
    const local = await service(true);
    const requestedIds = [...selectedIds].reverse();
    const result = await run([reviewSuite, "--live", ...cliArgs(requestedIds)], local.config);
    expect(result.code, result.text).toBe(1);
    expect(result.summary).toMatchObject({
      expectedSamples: 2, recordedSamples: 2, missingSamples: 0, status: "failed", stopReason: "http_429",
      selection: { suiteSamples: 10, requestedIds }, protocolCounts: { pass: 0, fail: 0, error: 1, "not-run": 1 },
    });
    expectOnlySamples(result, selectedIds);
    const first = sampleOf(result, selectedIds[0]!);
    const later = sampleOf(result, selectedIds[1]!);
    expect(first.protocol).toBe("error");
    expect(later).toMatchObject({ protocol: "not-run", raw: null, notRunReason: "prior-http-429", semanticReview: "not-evaluated" });
    expect(local.requests).toHaveLength(3);
    expect(local.requests.every(request => JSON.stringify(request.messages) === JSON.stringify(first.assembledMessages))).toBe(true);
  }, 30_000);
});
