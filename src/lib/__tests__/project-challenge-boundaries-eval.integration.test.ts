import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProjectSummaryMessages, PROJECT_SUMMARY_SYSTEM_PROMPT, serializeProjectSummaryMaterial } from "../project-summary-llm";
import { emptySummary, isGeneratedProjectSummary } from "../summary";
import { checkSafeModelInput } from "../safe-llm";
import {
  buildProjectChallengeBoundaryCandidate, PROJECT_CHALLENGE_BOUNDARY_ADDITION,
  PROJECT_CHALLENGE_BOUNDARY_ANCHOR, projectChallengeBoundaryCases,
} from "../../../evals/project-challenge-boundaries-fixture";
import { listenForFetch } from "../../../tests/support/http-server";

const directories: string[] = [], servers: Server[] = [];
const key = "synthetic-challenge-boundaries-key-never-real";
const ids = ["log-progress/baseline", "log-progress/candidate", "log-unresolved/candidate", "log-unresolved/baseline",
  "csv-verified/baseline", "csv-verified/candidate", "csv-unverified/candidate", "csv-unverified/baseline"];
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
  for (const directory of directories.splice(0)) {
    const target = path.resolve(directory);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !/^resume-life-(?:challenge-eval-test-|prompt-eval-)/.test(path.basename(target))) {
      throw new Error("Unsafe challenge evaluation test cleanup path");
    }
    fs.rmSync(target, { recursive: true, force: true });
  }
});

async function run(mode: "snapshot" | "valid" | "invalid-fields" | "invalid-json") {
  const requests: { model: string; max_tokens: number; stream: boolean; messages: ReturnType<typeof checkSafeModelInput> }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const content = mode === "invalid-json" ? "private-invalid-output-never-copy"
      : JSON.stringify({ ...emptySummary(), overview: "本机合成协议控制。", ...(mode === "invalid-fields" ? { extra: true } : {}) });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  servers.push(server);
  await listenForFetch(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic service unavailable");
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-challenge-eval-test-"));
  directories.push(source);
  fs.writeFileSync(path.join(source, "sentinel.txt"), "unchanged");
  const env = { ...process.env };
  for (const variable of Object.keys(env)) if (variable.startsWith("PROMPT_EVAL_")) delete env[variable];
  const child = spawn(process.execPath, [path.resolve("scripts/eval-prompts.mjs"), "--suite=project-challenge-boundaries",
    ...(mode === "snapshot" ? [] : ["--live"]), ...(mode === "invalid-json" ? ["--sample=log-progress/baseline"] : []),
  ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: {
    ...env, RESUME_LIFE_DATA_DIR: source,
    PROMPT_EVAL_BASE_URL: `http://127.0.0.1:${address.port}/v1`, PROMPT_EVAL_API_KEY: key,
    PROMPT_EVAL_MODEL: "synthetic-summary-model", PROMPT_EVAL_API_FORMAT: "openai_chat",
    // A stale external live flag must not turn the snapshot control into model calls.
    PROMPT_EVAL_LIVE: "1", PROMPT_EVAL_SUITE: "project",
  } });
  let text = "";
  child.stdout.on("data", value => { text += value; });
  child.stderr.on("data", value => { text += value; });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Challenge evaluation fixture exceeded 20s")); }, 20_000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", status => { clearTimeout(timeout); resolve(status); });
  });
  expect(fs.readdirSync(source)).toEqual(["sentinel.txt"]);
  expect(fs.readFileSync(path.join(source, "sentinel.txt"), "utf8")).toBe("unchanged");
  expect(text).not.toContain(key);
  const output = text.match(/(?:提示词快照（零模型调用）|真实模型评估)：([^\r\n]+)/)?.[1];
  if (!output) throw new Error("Evaluation did not produce an output directory");
  directories.push(output);
  const read = (id: string) => JSON.parse(fs.readFileSync(path.join(output, `${id.replaceAll("/", "-")}.json`), "utf8"));
  return { code, text, output, requests, read, summary: read("summary") };
}

describe("项目难点状态边界对照套件（本机合成控制）", () => {
  it("只在原始 challenges 锚点后追加边界规则", () => {
    const candidate = buildProjectChallengeBoundaryCandidate(PROJECT_SUMMARY_SYSTEM_PROMPT);
    expect(candidate.replace(PROJECT_CHALLENGE_BOUNDARY_ADDITION, "")).toBe(PROJECT_SUMMARY_SYSTEM_PROMPT);
    expect(candidate).toContain(PROJECT_CHALLENGE_BOUNDARY_ANCHOR + PROJECT_CHALLENGE_BOUNDARY_ADDITION);
    for (const changed of [candidate, PROJECT_SUMMARY_SYSTEM_PROMPT.replace(PROJECT_CHALLENGE_BOUNDARY_ANCHOR, ""), PROJECT_SUMMARY_SYSTEM_PROMPT + PROJECT_CHALLENGE_BOUNDARY_ANCHOR]) {
      expect(() => buildProjectChallengeBoundaryCandidate(changed)).toThrow("requires one original challenges anchor");
    }
  });

  it("两对材料只增真实问题或替换修复验证状态，不复用旧跨批次问题", () => {
    const [progress, unresolved, verified, unverified] = projectChallengeBoundaryCases;
    expect(progress.source).toBe("本地日志筛选工具供开发人员按起始时间筛选本地日志，使用 TypeScript。本人负责筛选逻辑，同事负责界面。本人已整理8条合成日志并补充操作说明。工具未发布，整体验收未完成，尚无整体验证结论。");
    expect(unresolved.source).toBe(progress.source + "本人在本地用这8条合成日志复现：与筛选起始时间完全相等的一条日志按需求应保留，实际被遗漏。原因尚未定位，尚无修复方案，没有实施修复或验证修复效果。");
    const commonCsv = "名单CSV导出工具供活动组织者将报名名单导出为CSV，使用 TypeScript。本人负责CSV字段转义，同事负责页面。本人在本地用6行合成名单复现：姓名包含逗号时，一名报名者的姓名被拆成两列。本人已修改字段转义，用双引号包裹包含逗号的字段，字段内部的双引号写为连续两个双引号。上述修改已提交。工具未发布，整体验收未完成。";
    expect(verified.source).toBe(commonCsv + "本人随后复测这6行合成名单，各姓名均保持为一个字段，结果符合预期；未用真实名单验证。");
    expect(unverified.source).toBe(commonCsv + "尚未运行修复后的测试，是否消除错误尚未确认；未用真实名单验证。");
    for (const sample of projectChallengeBoundaryCases) {
      expect(sample.source).not.toMatch(/跨批次|批次 ID|12 份|参数校验|缓存/);
      expect(sample.rubric).toHaveLength(4);
      expect(sample.rubric[0]).toContain("challenges");
      expect(sample.rubric[2]).toContain("brief 与每条 achievement");
      expect(sample.rubric[3]).toContain("审阅流程（不计模型语义判据）");
    }
  });

  it.each(["snapshot", "valid", "invalid-fields"] as const)("标准入口保存8个固定顺序配对且采用生产消息/协议校验：%s", async mode => {
    const result = await run(mode);
    expect(result.code, result.text).toBe(mode === "invalid-fields" ? 1 : 0);
    expect(result.summary).toMatchObject({ suite: "project-challenge-boundaries", expectedSamples: 8, recordedSamples: 8,
      maxOutputTokens: 8192, timeoutMs: 60000, status: mode === "invalid-fields" ? "failed" : "completed",
      protocolCounts: { "not-run": mode === "snapshot" ? 8 : 0, pass: mode === "valid" ? 8 : 0, fail: mode === "invalid-fields" ? 8 : 0, error: 0 },
    });
    expect(result.summary.results.map((entry: { id: string }) => entry.id)).toEqual(ids);
    expect(result.requests).toHaveLength(mode === "snapshot" ? 0 : 8);
    for (const sample of projectChallengeBoundaryCases) {
      const baseline = result.read(`${sample.id}/baseline`), candidate = result.read(`${sample.id}/candidate`);
      expect(baseline.input).toEqual(candidate.input);
      expect(baseline.inputHash).toBe(candidate.inputHash);
      expect(baseline.rubric).toEqual([...sample.rubric]);
      expect(candidate.rubric).toEqual(baseline.rubric);
      expect(candidate.assembledMessages.slice(1)).toEqual(baseline.assembledMessages.slice(1));
      expect(candidate.assembledMessages[0].content.replace(PROJECT_CHALLENGE_BOUNDARY_ADDITION, "")).toBe(baseline.assembledMessages[0].content);
      const materials = [{ title: "合成项目记录", content: sample.source }];
      expect(baseline.input).toEqual({ projectName: sample.projectName, materials, materialText: materials.map(serializeProjectSummaryMaterial).join(""), archive: emptySummary(), mode: "full" });
      expect(baseline.assembledMessages.slice(1)).toEqual(checkSafeModelInput(PROJECT_SUMMARY_SYSTEM_PROMPT, buildProjectSummaryMessages(baseline.input)).slice(1));
      for (const record of [baseline, candidate]) {
        expect(record.inputHash).toBe(hash(record.input));
        expect(record.promptHash).toBe(hash(record.assembledMessages));
        expect(record.semanticReviewItems.every((item: { verdict: string }) => item.verdict === "pending")).toBe(true);
        if (mode === "snapshot") expect(record).toMatchObject({ raw: null, observedRequests: [], protocol: "not-run" });
        else {
          expect(isGeneratedProjectSummary(JSON.parse(record.raw))).toBe(mode === "valid");
          expect(record.observedRequests).toMatchObject([{ requestIndex: 0, stream: true, phase: "ended", outcome: "complete" }]);
          expect(record.failureStage).toBe(mode === "invalid-fields" ? "validation" : null);
        }
      }
    }
    result.requests.forEach((request, index) => {
      expect(request).toMatchObject({ model: "synthetic-summary-model", max_tokens: 8192, stream: true });
      expect(request.messages).toEqual(result.read(ids[index]!).assembledMessages);
    });
    if (mode === "snapshot") expect(fs.existsSync(path.join(result.output, "data"))).toBe(false);
  }, 25_000);

  it("标准样本选择只调用一臂，strict JSON失败保留三次读取观察而不交付无效正文", async () => {
    const result = await run("invalid-json");
    expect(result.code).toBe(1);
    expect(result.summary).toMatchObject({ expectedSamples: 1, recordedSamples: 1, status: "failed",
      selection: { suiteSamples: 8, requestedIds: ["log-progress/baseline"] }, protocolCounts: { error: 1, pass: 0, fail: 0, "not-run": 0 },
    });
    expect(result.requests).toHaveLength(3);
    const record = result.read("log-progress/baseline");
    expect(record).toMatchObject({ raw: null, protocol: "error", failureStage: "call", callDeadlineExceeded: false });
    expect(record.observedRequests.map((request: { requestIndex: number; attempt: number; outcome: string }) => [request.requestIndex, request.attempt, request.outcome])).toEqual([[0, 0, "complete"], [1, 1, "complete"], [2, 2, "complete"]]);
    expect(JSON.stringify(record) + result.text).not.toContain("private-invalid-output-never-copy");
  }, 25_000);
});
