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
import { buildProjectSummaryChallengeStatusSystems, projectSummaryChallengeStatusCases } from "../../../evals/project-summary-challenge-status-fixture";
import { listenForFetch } from "../../../tests/support/http-server";
import { withoutEvaluationDate } from "./helpers/evaluation-system-message";

type RecordedRequest = { model: string; max_tokens: number; stream: boolean; messages: ReturnType<typeof checkSafeModelInput> };
const directories: string[] = [];
const servers: Server[] = [];
const key = "synthetic-summary-challenge-status-key-never-real";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const ids = projectSummaryChallengeStatusCases.flatMap((sample, caseIndex) => {
  const arms = caseIndex % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
  return arms.map(arm => sample.id + "/full/" + arm);
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
  for (const directory of directories.splice(0)) {
    const target = path.resolve(directory);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !/^resume-life-(?:summary-challenge-status-eval-test-|prompt-eval-)/.test(path.basename(target))) {
      throw new Error("Unsafe summary-challenge-status evaluation cleanup path");
    }
    fs.rmSync(target, { recursive: true, force: true });
  }
});

async function run(control: "snapshot" | "valid", selectedId?: string) {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as RecordedRequest);
    const content = JSON.stringify({ ...emptySummary(), brief: "本机合成协议控制。" });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end("data: " + JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }] }) + "\n\ndata: [DONE]\n\n");
  });
  servers.push(server);
  await listenForFetch(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic service unavailable");
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-summary-challenge-status-eval-test-"));
  directories.push(source);
  fs.writeFileSync(path.join(source, "sentinel.txt"), "unchanged");
  const env = { ...process.env };
  for (const variable of Object.keys(env)) if (variable.startsWith("PROMPT_EVAL_")) delete env[variable];
  const args = [path.resolve("scripts/eval-prompts.mjs"), "--suite=project-summary-challenge-status",
    ...(control === "snapshot" ? [] : ["--live"]), ...(selectedId ? ["--sample=" + selectedId] : [])];
  const child = spawn(process.execPath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: {
    ...env, RESUME_LIFE_DATA_DIR: source,
    PROMPT_EVAL_BASE_URL: "http://127.0.0.1:" + address.port + "/v1", PROMPT_EVAL_API_KEY: key,
    PROMPT_EVAL_MODEL: "synthetic-summary-model", PROMPT_EVAL_API_FORMAT: "openai_chat",
    ...(control === "snapshot" ? {} : { PROMPT_EVAL_TIMEOUT_MS: "300000" }),
    PROMPT_EVAL_LIVE: "1", PROMPT_EVAL_SUITE: "project",
  } });
  let transcript = "";
  child.stdout.on("data", value => { transcript += value; });
  child.stderr.on("data", value => { transcript += value; });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Summary challenge status fixture exceeded 20s")); }, 20_000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", status => { clearTimeout(timeout); resolve(status); });
  });
  expect(fs.readdirSync(source)).toEqual(["sentinel.txt"]);
  expect(fs.readFileSync(path.join(source, "sentinel.txt"), "utf8")).toBe("unchanged");
  expect(transcript).not.toContain(key);
  const output = transcript.match(/(?:提示词快照（零模型调用）|真实模型评估)：([^\r\n]+)/)?.[1];
  if (!output) throw new Error("Evaluation did not produce an output directory");
  directories.push(output);
  const read = (id: string) => JSON.parse(fs.readFileSync(path.join(output, id.replaceAll("/", "-") + ".json"), "utf8"));
  return { code, transcript, output, requests, read, summary: read("summary") };
}

describe("challenges状态准入候选评测入口（本机合成控制）", () => {
  it("标准快照记录全部12个配对并逐项保留production输入、messages和rubric", async () => {
    const result = await run("snapshot");
    expect(result.code, result.transcript).toBe(0);
    expect(result.summary).toMatchObject({ suite: "project-summary-challenge-status", expectedSamples: 12, recordedSamples: 12, status: "completed" });
    expect(result.summary.results.map((entry: { id: string }) => entry.id)).toEqual(ids);
    expect(result.requests).toHaveLength(0);
    for (const sample of projectSummaryChallengeStatusCases) {
      const materials = [{ title: "合成项目记录", content: sample.source }];
      const input = {
        projectName: sample.projectName, materials,
        materialText: materials.map(serializeProjectSummaryMaterial).join(""), archive: emptySummary(), mode: "full" as const,
      };
      const pair = buildProjectSummaryChallengeStatusSystems(PROJECT_SUMMARY_SYSTEM_PROMPT);
      for (const arm of ["baseline", "candidate"] as const) {
        const record = result.read(sample.id + "/full/" + arm);
        const expected = checkSafeModelInput(pair[arm], buildProjectSummaryMessages(input));
        expect(record.input).toEqual(input);
        expect(record.inputHash).toBe(hash(input));
        expect(withoutEvaluationDate(record.assembledMessages[0])).toEqual(withoutEvaluationDate(expected[0] as { role: string; content: string }));
        expect(record.assembledMessages.slice(1)).toEqual(expected.slice(1));
        expect(record.promptHash).toBe(hash(record.assembledMessages));
        expect(record.rubric).toEqual([...sample.rubric]);
        expect(record.semanticReviewItems.every((item: { verdict: string }) => item.verdict === "pending")).toBe(true);
        expect(record).toMatchObject({ raw: null, observedRequests: [], protocol: "not-run" });
      }
    }
    expect(fs.existsSync(path.join(result.output, "data"))).toBe(false);
  }, 25_000);

  it("选定真实入口只调用合成SSE并通过full结构校验", async () => {
    const selected = ids[0]!;
    const result = await run("valid", selected);
    expect(result.code, result.transcript).toBe(0);
    expect(result.summary).toMatchObject({ suite: "project-summary-challenge-status", expectedSamples: 1, recordedSamples: 1, status: "completed" });
    expect(result.requests).toHaveLength(1);
    const record = result.read(selected);
    expect(record.protocol).toBe("pass");
    expect(isGeneratedProjectSummary(JSON.parse(record.raw))).toBe(true);
    expect(record.observedRequests).toMatchObject([{ requestIndex: 0, stream: true, phase: "ended", outcome: "complete" }]);
    expect(result.requests[0]).toMatchObject({ model: "synthetic-summary-model", max_tokens: 8192, stream: true });
    expect(result.requests[0]?.messages).toEqual(record.assembledMessages);
    expect(result.transcript).not.toContain(key);
  }, 25_000);
});
