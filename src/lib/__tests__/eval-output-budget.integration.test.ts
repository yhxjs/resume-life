import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const directories: string[] = [];
const servers: Server[] = [];
const apiKey = "synthetic-eval-output-budget-key";

async function service(vision: boolean) {
  const requests: { max_tokens?: number }[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    const content = vision ? "合成文字，仅验证预算传输。"
      : JSON.stringify({ isRelated: null, reason: "合成结果，仅验证预算传输。" });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`);
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing local server address");
  return { requests, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

async function run(vision: boolean, live: boolean, baseUrl: string, budget?: string) {
  const prefix = vision ? "VISION_EVAL" : "PROMPT_EVAL";
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^(?:PROMPT|VISION)_EVAL_/.test(name)) delete env[name];
  const child = spawn(process.execPath, [path.resolve(`scripts/eval-${vision ? "vision" : "prompts"}.mjs`),
    ...(!vision ? ["--suite=repo"] : []), ...(live ? ["--live"] : [])], {
    windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...env, [`${prefix}_BASE_URL`]: baseUrl, [`${prefix}_API_KEY`]: apiKey, [`${prefix}_MODEL`]: "synthetic-model",
      ...(budget !== undefined ? { [`${prefix}_MAX_OUTPUT_TOKENS`]: budget } : {}),
    },
  });
  let text = "";
  child.stdout.on("data", data => { text += data; });
  child.stderr.on("data", data => { text += data; });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("Local output budget evaluation exceeded 30s")); }, 30_000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", status => { clearTimeout(timer); resolve(status); });
  });
  const output = text.match(/(?:提示词快照（零模型调用）|真实模型评估|视觉评估目录)：([^\r\n]+)/)?.[1];
  if (output) directories.push(output);
  expect(output).toBeDefined();
  expect(text).not.toContain(apiKey);
  const read = (name: string) => JSON.parse(fs.readFileSync(path.join(output!, `${name}.json`), "utf8"));
  return { code, text, output: output!, read, summary: read("summary") };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
  for (const directory of directories.splice(0)) {
    const target = path.resolve(directory);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !/^resume-life-(?:prompt-eval|vision-eval)-/.test(path.basename(target))) {
      throw new Error("Unsafe output budget evaluation cleanup path");
    }
    fs.rmSync(target, { recursive: true, force: true });
  }
});

describe.each([false, true])("评测输出预算：vision=%s（仅本地合成服务）", vision => {
  const prefix = vision ? "VISION_EVAL" : "PROMPT_EVAL";

  it.each([undefined, "4096"])("实际请求、隔离设置及报告采用同一有效预算：%s", async budget => {
    const local = await service(vision);
    const result = await run(vision, true, local.baseUrl, budget);
    const expected = budget === undefined ? (vision ? 2400 : 1200) : Number(budget);
    expect(result.code, result.text).toBe(0);
    expect(local.requests).toHaveLength(vision ? 7 : 5);
    expect(local.requests.every(request => request.max_tokens === expected)).toBe(true);
    expect(result.summary).toMatchObject({ status: "completed", maxOutputTokens: expected });
    for (const entry of result.summary.results) expect(result.read(entry.id)).toMatchObject({ maxOutputTokens: expected, protocol: "pass" });
    const db = new DatabaseSync(path.join(result.output, "data", "resume-life.db"), { readOnly: true });
    try {
      expect(db.prepare("SELECT max_output_tokens FROM settings WHERE id = 1").get()).toEqual({ max_output_tokens: String(expected) });
    } finally { db.close(); }
  });

  it("快照记录覆盖预算但不发请求或创建数据库", async () => {
    const local = await service(vision);
    const result = await run(vision, false, local.baseUrl, "3072");
    expect(result.code, result.text).toBe(0);
    expect(result.summary).toMatchObject({ status: "completed", mode: "snapshot", maxOutputTokens: 3072 });
    for (const entry of result.summary.results) expect(result.read(entry.id)).toMatchObject({ maxOutputTokens: 3072, protocol: "not-run", raw: null });
    expect(local.requests).toHaveLength(0);
    expect(fs.existsSync(path.join(result.output, "data"))).toBe(false);
  });

  it.each([
    { live: true, budget: "0" },
    { live: true, budget: "1.5" },
    { live: true, budget: "1200junk" },
    { live: true, budget: "9007199254740992" },
    { live: false, budget: "" },
  ])("无效预算明确失败且不回退默认：$budget，live=$live", async ({ live, budget }) => {
    const local = await service(vision);
    const result = await run(vision, live, local.baseUrl, budget);
    expect(result.code).toBe(1);
    expect(result.text).toContain(`${prefix}_MAX_OUTPUT_TOKENS 必须是正安全整数`);
    expect(result.summary).toMatchObject({ status: "incomplete", recordedSamples: 0, maxOutputTokens: null });
    expect(local.requests).toHaveLength(0);
    expect(fs.existsSync(path.join(result.output, "data"))).toBe(false);
  });
});
