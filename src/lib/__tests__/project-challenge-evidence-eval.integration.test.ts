import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProjectSummaryMessages, PROJECT_SUMMARY_SYSTEM_PROMPT, serializeProjectSummaryMaterial } from "../project-summary-llm";
import { checkSafeModelInput } from "../safe-llm";
import { emptySummary, isGeneratedProjectSummary } from "../summary";
import { buildProjectChallengeEvidenceSystem, consumeProjectChallengeEvidence } from "../../../evals/project-challenge-evidence";
import { projectChallengeEvidenceCases } from "../../../evals/project-challenge-evidence-fixture";
import { projectChallengeOrderCases } from "../../../evals/project-challenge-order-fixture";
import { listenForFetch } from "../../../tests/support/http-server";
import { withoutEvaluationDate } from "./helpers/evaluation-system-message";

const directories: string[] = [], servers: Server[] = [];
const key = "synthetic-challenge-evidence-key-never-real";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sampleIds = projectChallengeEvidenceCases.map(sample => sample.id);
const ids = sampleIds.flatMap((id, index) => index % 2 === 0
  ? [`${id}/full/baseline`, `${id}/full/candidate`]
  : [`${id}/full/candidate`, `${id}/full/baseline`]);

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
  for (const directory of directories.splice(0)) {
    const target = path.resolve(directory);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !/^resume-life-(?:challenge-evidence-test-|prompt-eval-)/.test(path.basename(target))) {
      throw new Error("Unsafe challenge evidence test cleanup path");
    }
    fs.rmSync(target, { recursive: true, force: true });
  }
});

function isCandidateRequest(messages: ReturnType<typeof checkSafeModelInput>): boolean {
  return messages.some(message => message.role === "system" && typeof message.content === "string" && message.content.includes('"challenges": [],'));
}

async function run(mode: "snapshot" | "valid" | "invalid-fields" | "invalid-evidence" | "invalid-json", sample?: string) {
  const requests: { model: string; max_tokens: number; stream: boolean; messages: ReturnType<typeof checkSafeModelInput> }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof requests[number];
    requests.push(request);
    const candidate = isCandidateRequest(request.messages);
    const fixture = sample ? projectChallengeEvidenceCases.find(fixture => sample.startsWith(`${fixture.id}/`))
      : projectChallengeEvidenceCases[Math.floor((requests.length - 1) / 2)];
    const quote = fixture?.source.slice(0, fixture.source.indexOf("。") + 1) ?? "";
    const content = mode === "invalid-json" ? "private-invalid-challenge-evidence-output-never-copy"
      : JSON.stringify({ ...emptySummary(), overview: "本机合成协议控制。",
        ...(candidate ? { challenges: [{ problem: { materialNumber: 1, quote: mode === "invalid-evidence" ? "private-invalid-source-never-copy" : quote }, handling: [], outcome: [] }] } : {}),
        ...(mode === "invalid-fields" ? { extra: true } : {}),
      });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  servers.push(server);
  await listenForFetch(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic service unavailable");
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-challenge-evidence-test-"));
  directories.push(source);
  fs.writeFileSync(path.join(source, "sentinel.txt"), "unchanged");
  const env = { ...process.env };
  for (const variable of Object.keys(env)) if (variable.startsWith("PROMPT_EVAL_")) delete env[variable];
  const child = spawn(process.execPath, [path.resolve("scripts/eval-prompts.mjs"), "--suite=project-challenge-evidence",
    ...(mode === "snapshot" ? [] : ["--live"]), ...(sample ? [`--sample=${sample}`] : []),
  ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: {
    ...env, RESUME_LIFE_DATA_DIR: source,
    PROMPT_EVAL_BASE_URL: `http://127.0.0.1:${address.port}/v1`, PROMPT_EVAL_API_KEY: key,
    PROMPT_EVAL_MODEL: "synthetic-summary-model", PROMPT_EVAL_API_FORMAT: "openai_chat",
    ...(mode === "snapshot" ? {} : { PROMPT_EVAL_TIMEOUT_MS: "300000" }),
    // A stale live flag and suite must not alter the explicit CLI mode.
    PROMPT_EVAL_LIVE: "1", PROMPT_EVAL_SUITE: "project",
  } });
  let text = "";
  child.stdout.on("data", value => { text += value; });
  child.stderr.on("data", value => { text += value; });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Challenge evidence fixture exceeded 20s")); }, 20_000);
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
  return { code, text, output, requests, read, summary: fs.existsSync(path.join(output, "summary.json")) ? read("summary") : null };
}

describe("项目难点证据候选评测入口（本机合成控制）", () => {
  it("六份旧材料和判据原样继承，四份对抗材料使用独立稳定ID", () => {
    expect(projectChallengeEvidenceCases).toHaveLength(10);
    expect(projectChallengeEvidenceCases.slice(0, 6)).toEqual(projectChallengeOrderCases);
    expect(sampleIds.slice(6)).toEqual(["foreign-issue-in-same-material", "misleading-challenge-heading", "negated-and-hypothetical-issue", "two-issues-distinct-outcomes"]);
    expect(new Set(ids).size).toBe(20);
  });

  it.each(["snapshot", "valid"] as const)("标准入口保存动态固定配对并保持生产消息：%s", async mode => {
    const result = await run(mode);
    expect(result.code, result.text).toBe(0);
    expect(result.summary).toMatchObject({ suite: "project-challenge-evidence", expectedSamples: ids.length, recordedSamples: ids.length,
      maxOutputTokens: 8192, timeoutMs: mode === "snapshot" ? 60000 : 300000, status: "completed",
    });
    expect(result.summary.results.map((entry: { id: string }) => entry.id)).toEqual(ids);
    expect(result.requests).toHaveLength(mode === "snapshot" ? 0 : ids.length);
    for (const sample of projectChallengeEvidenceCases) {
      const materials = [{ title: "合成项目记录", content: sample.source }];
      const input = { projectName: sample.projectName, materials, materialText: materials.map(serializeProjectSummaryMaterial).join(""), archive: emptySummary(), mode: "full" };
      for (const arm of ["baseline", "candidate"] as const) {
        const record = result.read(`${sample.id}/full/${arm}`);
        expect(record.input).toEqual(input);
        expect(record.inputHash).toBe(hash(input));
        expect(record.rubric).toEqual([...sample.rubric]);
        const system = arm === "baseline" ? PROJECT_SUMMARY_SYSTEM_PROMPT : buildProjectChallengeEvidenceSystem();
        const expected = checkSafeModelInput(system, buildProjectSummaryMessages(input));
        expect(withoutEvaluationDate(record.assembledMessages[0])).toEqual(withoutEvaluationDate(expected[0] as { role: string; content: string }));
        expect(record.assembledMessages.slice(1)).toEqual(expected.slice(1));
        expect(record.promptHash).toBe(hash(record.assembledMessages));
        expect(record.semanticReviewItems.every((item: { verdict: string }) => item.verdict === "pending")).toBe(true);
        if (mode === "snapshot") {
          expect(record).toMatchObject({ raw: null, observedRequests: [], protocol: "not-run" });
        } else {
          const parsed = JSON.parse(record.raw);
          expect(record.protocol).toBe("pass");
          expect(record.observedRequests).toMatchObject([{ requestIndex: 0, stream: true, phase: "ended", outcome: "complete" }]);
          if (arm === "baseline") expect(isGeneratedProjectSummary(parsed)).toBe(true);
          else {
            const consumed = consumeProjectChallengeEvidence(parsed, materials);
            expect(consumed?.challenges).toBe(sample.source.slice(0, sample.source.indexOf("。") + 1));
            expect(result.read(`${sample.id}/full/candidate-consumed`)).toEqual({ schemaVersion: 1, id: `${sample.id}/full/candidate`, summary: consumed });
            expect(parsed.challenges).toHaveLength(1);
          }
        }
      }
    }
    result.requests.forEach((request, index) => {
      expect(request).toMatchObject({ model: "synthetic-summary-model", max_tokens: 8192, stream: true });
      expect(request.messages).toEqual(result.read(ids[index]!).assembledMessages);
    });
    if (mode === "snapshot") expect(fs.existsSync(path.join(result.output, "data"))).toBe(false);
  }, 25_000);

  it("候选错误来源引用在消费阶段拒绝并保留raw", async () => {
    const selected = `${sampleIds[0]}/full/candidate`;
    const result = await run("invalid-evidence", selected);
    expect(result.code).toBe(1);
    expect(result.summary).toMatchObject({ expectedSamples: 1, recordedSamples: 1, status: "failed", selection: { requestedIds: [selected] }, protocolCounts: { fail: 1, pass: 0, error: 0, "not-run": 0 } });
    const record = result.read(selected);
    expect(record).toMatchObject({ protocol: "fail", failureStage: "validation", callDeadlineExceeded: false });
    expect(record.raw).toContain("private-invalid-source-never-copy");
    expect(result.read(`${sampleIds[0]}/full/candidate-consumed`).summary).toBeNull();
  }, 25_000);

  it("strict JSON失败保留三次读取观察且不泄露模型正文", async () => {
    const selected = `${sampleIds[0]}/full/baseline`;
    const result = await run("invalid-json", selected);
    expect(result.code).toBe(1);
    expect(result.summary).toMatchObject({ expectedSamples: 1, recordedSamples: 1, status: "failed", protocolCounts: { error: 1, pass: 0, fail: 0, "not-run": 0 } });
    expect(result.requests).toHaveLength(3);
    const record = result.read(selected);
    expect(record).toMatchObject({ raw: null, protocol: "error", failureStage: "call", callDeadlineExceeded: false });
    expect(record.observedRequests.map((request: { requestIndex: number; attempt: number; outcome: string }) => [request.requestIndex, request.attempt, request.outcome])).toEqual([[0, 0, "complete"], [1, 1, "complete"], [2, 2, "complete"]]);
    expect(JSON.stringify(record) + result.text).not.toContain("private-invalid-challenge-evidence-output-never-copy");
  }, 25_000);

  it("未知样本在调用前拒绝且不产生HTTP请求", async () => {
    const result = await run("snapshot", "unknown-evidence-sample");
    expect(result.code).not.toBe(0);
    expect(result.requests).toHaveLength(0);
    expect(result.text).not.toContain(key);
    expect(result.summary).toBeNull();
  }, 25_000);
});
