import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProjectSummaryMessages, PROJECT_RESUME_SYSTEM_PROMPT, PROJECT_SUMMARY_SYSTEM_PROMPT, serializeProjectSummaryMaterial } from "../project-summary-llm";
import { emptySummary, isGeneratedProjectSummary, validateGeneratedProjectResume } from "../summary";
import { checkSafeModelInput } from "../safe-llm";
import { buildProjectWorkStateSystems, projectWorkStateCases } from "../../../evals/project-work-state-fixture";
import { listenForFetch } from "../../../tests/support/http-server";
import { withoutEvaluationDate } from "./helpers/evaluation-system-message";

type OutputMode = "full" | "resume-only";
type RecordedRequest = { model: string; max_tokens: number; stream: boolean; messages: ReturnType<typeof checkSafeModelInput> };
const directories: string[] = [];
const servers: Server[] = [];
const key = "synthetic-work-state-key-never-real";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const ids = projectWorkStateCases.flatMap((sample, caseIndex) =>
  (["full", "resume-only"] as const).flatMap((mode, modeIndex) => {
    const arms = (caseIndex + modeIndex) % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
    return arms.map(arm => sample.id + "/" + mode + "/" + arm);
  }),
);

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
  for (const directory of directories.splice(0)) {
    const target = path.resolve(directory);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !/^resume-life-(?:work-state-eval-test-|prompt-eval-)/.test(path.basename(target))) {
      throw new Error("Unsafe work-state evaluation cleanup path");
    }
    fs.rmSync(target, { recursive: true, force: true });
  }
});

async function run(control: "snapshot" | "valid" | "invalid-fields" | "invalid-json", selectedId?: string) {
  const activeIds = selectedId ? [selectedId] : ids;
  const requests: RecordedRequest[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as RecordedRequest;
    requests.push(request);
    const currentId = activeIds[Math.min(requests.length - 1, activeIds.length - 1)]!;
    const mode = currentId.split("/")[1] as OutputMode;
    const fullShape = { ...emptySummary(), brief: "本机合成协议控制。" };
    const resumeShape = { techStack: "", brief: "本机合成协议控制。", achievements: [] };
    const content = control === "invalid-json" ? "private-invalid-work-state-output-never-copy" : control === "invalid-fields"
      ? JSON.stringify(mode === "full" ? resumeShape : fullShape)
      : JSON.stringify(mode === "full" ? fullShape : resumeShape);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end("data: " + JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }] }) + "\n\ndata: [DONE]\n\n");
  });
  servers.push(server);
  await listenForFetch(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic service unavailable");
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-work-state-eval-test-"));
  directories.push(source);
  fs.writeFileSync(path.join(source, "sentinel.txt"), "unchanged");
  const env = { ...process.env };
  for (const variable of Object.keys(env)) if (variable.startsWith("PROMPT_EVAL_")) delete env[variable];
  const args = [path.resolve("scripts/eval-prompts.mjs"), "--suite=project-work-state",
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
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Work state fixture exceeded 20s")); }, 20_000);
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
  return { code, transcript, output, requests, selectedId, read, summary: read("summary") };
}

describe("项目工作状态候选评测入口（本机合成控制）", () => {
  it("候选只增加固定定义，且两种生产提示都有同一插入位置", () => {
    for (const production of [PROJECT_SUMMARY_SYSTEM_PROMPT, PROJECT_RESUME_SYSTEM_PROMPT]) {
      const pair = buildProjectWorkStateSystems(production);
      expect(pair.baseline).toBe(production);
      expect(pair.candidate.replace("- 职责分工只说明责任范围，不证明相关工作已实施或完成；未给实施状态时保持未知，不补成已实现或改成未实现。有独立实现证据时照常保留，不要求实现者已知。\n", "")).toBe(production);
    }
  });

  it.each(["snapshot", "valid"] as const)("标准入口固定32个配对并保持生产输入与消息：%s", async control => {
    const result = await run(control);
    expect(result.code, result.transcript).toBe(0);
    expect(result.summary).toMatchObject({
      suite: "project-work-state", expectedSamples: 32, recordedSamples: 32,
      maxOutputTokens: 8192, timeoutMs: control === "snapshot" ? 60000 : 300000, status: "completed",
    });
    expect(result.summary.results.map((entry: { id: string }) => entry.id)).toEqual(ids);
    expect(result.requests).toHaveLength(control === "snapshot" ? 0 : 32);
    for (const sample of projectWorkStateCases) {
      const materials = [{ title: "合成项目记录", content: sample.source }];
      for (const mode of ["full", "resume-only"] as const) {
        const input = {
          projectName: sample.projectName, materials,
          materialText: materials.map(serializeProjectSummaryMaterial).join(""), archive: emptySummary(), mode,
        };
        for (const arm of ["baseline", "candidate"] as const) {
          const record = result.read(sample.id + "/" + mode + "/" + arm);
          const system = mode === "full" ? PROJECT_SUMMARY_SYSTEM_PROMPT : PROJECT_RESUME_SYSTEM_PROMPT;
          const pair = buildProjectWorkStateSystems(system);
          const expectedSystem = arm === "baseline" ? pair.baseline : pair.candidate;
          const expected = checkSafeModelInput(expectedSystem, buildProjectSummaryMessages(input));
          expect(record.input).toEqual(input);
          expect(record.inputHash).toBe(hash(input));
          expect(withoutEvaluationDate(record.assembledMessages[0])).toEqual(withoutEvaluationDate(expected[0] as { role: string; content: string }));
          expect(record.assembledMessages.slice(1)).toEqual(expected.slice(1));
          expect(record.promptHash).toBe(hash(record.assembledMessages));
          expect(record.rubric).toEqual([...sample.rubric]);
          expect(record.semanticReviewItems.every((item: { verdict: string }) => item.verdict === "pending")).toBe(true);
          if (control === "snapshot") expect(record).toMatchObject({ raw: null, observedRequests: [], protocol: "not-run" });
          else {
            expect(record.protocol).toBe("pass");
            const parsed = JSON.parse(record.raw);
            expect(mode === "full" ? isGeneratedProjectSummary(parsed) : Boolean(validateGeneratedProjectResume(parsed))).toBe(true);
            expect(record.observedRequests).toMatchObject([{ requestIndex: 0, stream: true, phase: "ended", outcome: "complete" }]);
          }
        }
      }
    }
    if (control === "valid") result.requests.forEach((request, index) => {
      expect(request).toMatchObject({ model: "synthetic-summary-model", max_tokens: 8192, stream: true });
      expect(request.messages).toEqual(result.read(ids[index]!).assembledMessages);
    });
    if (control === "snapshot") expect(fs.existsSync(path.join(result.output, "data"))).toBe(false);
  }, 25_000);

  it.each(["full", "resume-only"] as const)("%s拒绝另一模式字段结构并保留已交付raw", async mode => {
    const selected = ids.find(id => id.endsWith("/" + mode + "/baseline"))!;
    const result = await run("invalid-fields", selected);
    expect(result.code).toBe(1);
    expect(result.summary).toMatchObject({ suite: "project-work-state", expectedSamples: 1, recordedSamples: 1, status: "failed" });
    const record = result.read(selected);
    expect(record).toMatchObject({ protocol: "fail", failureStage: "validation", callDeadlineExceeded: false });
    expect(record.raw).toEqual(expect.any(String));
    expect(isGeneratedProjectSummary(JSON.parse(record.raw))).toBe(mode === "resume-only");
    expect(Boolean(validateGeneratedProjectResume(JSON.parse(record.raw)))).toBe(mode === "full");
    expect(result.requests).toHaveLength(1);
    expect(result.transcript).not.toContain(key);
  }, 25_000);

  it("strict JSON失败保留三次观察且不交付无效正文", async () => {
    const selected = ids[0]!;
    const result = await run("invalid-json", selected);
    expect(result.code).toBe(1);
    expect(result.requests).toHaveLength(3);
    expect(result.summary).toMatchObject({ expectedSamples: 1, recordedSamples: 1, status: "failed",
      protocolCounts: { error: 1, pass: 0, fail: 0, "not-run": 0 } });
    const record = result.read(selected);
    expect(record).toMatchObject({ raw: null, protocol: "error", failureStage: "call", callDeadlineExceeded: false });
    expect(record.observedRequests.map((request: { attempt: number; outcome: string }) => [request.attempt, request.outcome]))
      .toEqual([[0, "complete"], [1, "complete"], [2, "complete"]]);
    expect(JSON.stringify(record) + result.transcript).not.toContain("private-invalid-work-state-output-never-copy");
  }, 25_000);
});
