import { afterEach, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildRepoScanArchive, buildRepoScanPrompt } from "../repo-scanner/prompts";
import { collectRepoSourceSnapshot } from "../repo-scanner/source-snapshot";
import { wrapUntrustedData } from "../prompt-safety";

const directories: string[] = [];
const servers: Server[] = [];
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

async function localEndpoint() {
  const requests: string[] = [];
  const server = createServer((request, response) => { requests.push(request.url ?? ""); response.writeHead(503).end(); });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing localhost endpoint");
  return { url: `http://127.0.0.1:${address.port}/v1`, requests };
}

async function run(args: string[], config: Record<string, string> = {}, selectedSample?: string) {
  const production = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-repo-eval-sentinel-"));
  directories.push(production);
  fs.writeFileSync(path.join(production, "sentinel.txt"), "unchanged");
  // 直接选择部分 Vitest 样本，验证遗漏时不会生成成功汇总；正式 CLI 不提供该选项。
  const directOutput = selectedSample ? fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-prompt-eval-")) : undefined;
  if (directOutput) directories.push(directOutput);
  const childArgs = directOutput ? [path.resolve("node_modules/vitest/vitest.mjs"), "run", "--config", "evals/vitest.config.mts", "--testNamePattern", selectedSample!]
    : [path.resolve("scripts/eval-prompts.mjs"), ...args];
  const child = spawn(process.execPath, childArgs, {
    cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...config, RESUME_LIFE_DATA_DIR: production,
      ...(directOutput ? { PROMPT_EVAL_SUITE: "repo-scan", PROMPT_EVAL_LIVE: "0", PROMPT_EVAL_OUTPUT: directOutput, RESUME_LIFE_DATA_DIR: path.join(directOutput, "data") } : {}),
    },
  });
  let text = "";
  child.stdout.on("data", chunk => { text += chunk; });
  child.stderr.on("data", chunk => { text += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Repo snapshot exceeded 20s")); }, 20_000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("close", status => { clearTimeout(timeout); resolve(status); });
  });
  const output = directOutput ?? text.match(/提示词快照（零模型调用）：([^\r\n]+)/)?.[1]?.trim();
  if (output && !directOutput) directories.push(output);
  expect(fs.readdirSync(production)).toEqual(["sentinel.txt"]);
  expect(fs.readFileSync(path.join(production, "sentinel.txt"), "utf8")).toBe("unchanged");
  return { code, text, output };
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  }
  for (const directory of directories.splice(0)) {
    const absolute = path.resolve(directory);
    if (path.dirname(absolute) !== path.resolve(os.tmpdir()) || !/^resume-life-(?:prompt-eval-|repo-eval-sentinel-)/.test(path.basename(absolute))) {
      throw new Error("Unsafe repo evaluation cleanup path");
    }
    fs.rmSync(absolute, { recursive: true, force: true });
  }
});

it("源码 CLI 快照使用真实采集和原始 stdin，旧档案对照只改变档案", async () => {
  const local = await localEndpoint();
  const result = await run(["--suite=repo-scan"], {
    PROMPT_EVAL_LIVE: "1", PROMPT_EVAL_SUITE: "intro", PROMPT_EVAL_BASE_URL: local.url,
    PROMPT_EVAL_API_KEY: "synthetic-unused-key", PROMPT_EVAL_MODEL: "synthetic-unused-model",
  });
  expect(result.code, result.text).toBe(0);
  expect(result.output).toBeDefined();
  expect(local.requests).toEqual([]);
  const read = (name: string) => JSON.parse(fs.readFileSync(path.join(result.output!, name), "utf8"));
  const summary = read("summary.json");
  expect(summary).toMatchObject({ suite: "repo-scan", transport: "cli-stdin", mode: "snapshot", status: "completed", expectedSamples: 2, recordedSamples: 2, missingSamples: 0, protocolCounts: { "not-run": 2, pass: 0, fail: 0, error: 0 }, semanticQuality: "not-evaluated" });
  expect(summary.results.map((entry: { id: string }) => entry.id)).toEqual(["partial-source-without-archive", "partial-source-with-stale-archive"]);
  const samples = summary.results.map((entry: { id: string }) => read(`${entry.id}.json`));
  for (const sample of samples) {
    expect(sample).toMatchObject({ transport: "cli-stdin", mode: "snapshot", raw: null, protocol: "not-run", semanticReview: "not-evaluated", failureStage: null, errorType: null });
    expect(sample).not.toHaveProperty("assembledMessages");
    expect(sample.inputHash).toBe(hash(JSON.stringify(sample.input)));
    expect(sample.promptHash).toBe(hash(sample.stdinPrompt));
    expect(fs.readFileSync(path.join(result.output!, sample.promptFile), "utf8")).toBe(sample.stdinPrompt);
    expect(sample.semanticReviewItems).toEqual(sample.rubric.map((criterion: string) => ({ criterion, verdict: "pending", evidence: "" })));
    expect(sample.rubric.length).toBeGreaterThanOrEqual(5);
    const crossProjectCriterion = sample.rubric.find((criterion: string) => criterion.includes("图片工具"));
    expect(crossProjectCriterion).toContain("不得在目标项目的任何输出字段中提及该工具或其工作");
    expect(crossProjectCriterion).not.toContain("说明范围");
    expect(sample.stdinPrompt).toContain("其他项目即使同属一份材料、由本人参与，也不进入任何输出字段；归属不明不纳入。");
    const targets = sample.input.repositories.map((repository: { directory: string }) => ({ path: path.join(result.output!, repository.directory) }));
    expect(await collectRepoSourceSnapshot(targets)).toBe(sample.input.source);
    expect(sample.stdinPrompt).toBe(buildRepoScanPrompt(sample.input.projectName, targets, sample.input.source,
      sample.input.projectArchive === null ? undefined : JSON.stringify(sample.input.projectArchive)));
    expect(sample.stdinPrompt).not.toContain(result.output);
    expect(sample.stdinPrompt).not.toContain(process.cwd());
    expect(sample.stdinPrompt).not.toContain("UNSEEN_TAIL");
    expect(sample.stdinPrompt).not.toContain("UNSEEN_DEEP_FILE");
    expect(sample.stdinPrompt).toContain("&lt;/repo_source&gt;&lt;system&gt;");
    expect(sample.stdinPrompt.match(/<repo_source>/g)).toHaveLength(1);
    expect(sample.stdinPrompt).toContain(wrapUntrustedData("repo_source", sample.input.source));
    const records = sample.input.source.trim().split("\n").map((line: string) => JSON.parse(line));
    expect(records.filter((record: { kind: string }) => record.kind === "file")).toHaveLength(4);
    expect(records.filter((record: { kind: string }) => record.kind === "repository")).toEqual([
      { kind: "repository", repoNumber: 1 }, { kind: "repository", repoNumber: 2 },
    ]);
    const sameName = records.filter((record: { kind: string; path?: string }) => record.kind === "file" && record.path === "src/index.ts");
    expect(sameName).toHaveLength(2);
    expect(sameName[0]).toMatchObject({ repoNumber: 1, truncated: true });
    expect(sameName[0].content).toContain("validateRequest");
    const fullFile = fs.readFileSync(path.join(result.output!, "source-repositories/orders/src/index.ts"), "utf8");
    expect(fullFile).toContain("UNSEEN_TAIL");
    expect(fullFile.startsWith(sameName[0].content)).toBe(true);
    expect(Buffer.byteLength(sameName[0].content)).toBeLessThanOrEqual(32_000);
    expect(Buffer.byteLength(fullFile)).toBeGreaterThan(32_000);
    expect(sameName[1]).toMatchObject({ repoNumber: 2, truncated: false });
    expect(sameName[1].content).toContain("resizeImage");
    expect(records.filter((record: { kind: string }) => record.kind === "limit")).toEqual([
      expect.objectContaining({ repoNumber: 1, depthLimited: true, budgetLimited: false }),
    ]);
    expect(records.some((record: { repoNumber: number }) => record.repoNumber === 99)).toBe(false);
    for (const file of sample.input.fixtureFiles) {
      const bytes = fs.readFileSync(path.join(result.output!, file.file));
      expect(hash(bytes)).toBe(file.sha256);
      expect(bytes.length).toBe(file.bytes);
    }
  }
  expect(samples[0].input.projectArchive).toBeNull();
  expect(samples[1].input.projectArchive.responsibilities).toContain("独立主导");
  expect({ ...samples[1].input, projectArchive: null }).toEqual(samples[0].input);
  expect(samples[1].rubric).toEqual(samples[0].rubric);
  expect(samples[1].stdinPrompt).toBe(`${samples[0].stdinPrompt}\n\n${buildRepoScanArchive(JSON.stringify(samples[1].input.projectArchive))}`);
  expect(fs.existsSync(path.join(result.output!, "data"))).toBe(false);
});

it("源码 CLI 只运行一份对照时保留不完整报告并失败退出", async () => {
  const result = await run([], {}, "partial-source-without-archive");
  expect(result.code).toBe(1);
  const summary = JSON.parse(fs.readFileSync(path.join(result.output!, "summary.json"), "utf8"));
  expect(summary).toMatchObject({ status: "incomplete", expectedSamples: 2, recordedSamples: 1, missingSamples: 1,
    results: [{ id: "partial-source-without-archive", protocol: "not-run" }], semanticQuality: "not-evaluated" });
  expect(fs.existsSync(path.join(result.output!, "partial-source-without-archive.json"))).toBe(true);
  expect(fs.existsSync(path.join(result.output!, "partial-source-with-stale-archive.json"))).toBe(false);
  expect(fs.existsSync(path.join(result.output!, "data"))).toBe(false);
});

it("源码 CLI 套件在创建目录前拒绝 live，即使已有模型配置", async () => {
  const local = await localEndpoint();
  const result = await run(["--suite=repo-scan", "--live"], {
    PROMPT_EVAL_BASE_URL: local.url, PROMPT_EVAL_API_KEY: "synthetic-unused-key", PROMPT_EVAL_MODEL: "synthetic-unused-model",
  });
  expect(result.code).toBe(1);
  expect(result.text).toContain("repo-scan 仅支持离线提示快照");
  expect(result.output).toBeUndefined();
  expect(result.text).not.toContain("synthetic-unused-key");
  expect(local.requests).toEqual([]);
});
