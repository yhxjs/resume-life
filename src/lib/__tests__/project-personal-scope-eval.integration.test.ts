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
import {
  buildProjectPersonalScopeSystems, PROJECT_PERSONAL_SCOPE_BEFORE,
  PROJECT_PERSONAL_SCOPE_CANDIDATE_RULE, projectPersonalScopeCases,
} from "../../../evals/project-personal-scope-fixture";
import { listenForFetch } from "../../../tests/support/http-server";
import { withoutEvaluationDate } from "./helpers/evaluation-system-message";

const directories: string[] = [], servers: Server[] = [];
const key = "synthetic-personal-scope-key-never-real";
const ids = [
  "implemented-change-known-author/full/baseline", "implemented-change-known-author/full/candidate",
  "implemented-change-known-author/resume-only/candidate", "implemented-change-known-author/resume-only/baseline",
  "implemented-change-unknown-author/full/candidate", "implemented-change-unknown-author/full/baseline",
  "implemented-change-unknown-author/resume-only/baseline", "implemented-change-unknown-author/resume-only/candidate",
  "documentation-known-role/full/baseline", "documentation-known-role/full/candidate",
  "documentation-known-role/resume-only/candidate", "documentation-known-role/resume-only/baseline",
  "documentation-unknown-role/full/candidate", "documentation-unknown-role/full/baseline",
  "documentation-unknown-role/resume-only/baseline", "documentation-unknown-role/resume-only/candidate",
];
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type OutputMode = "full" | "resume-only";

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
  for (const directory of directories.splice(0)) {
    const target = path.resolve(directory);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !/^resume-life-(?:personal-scope-eval-test-|prompt-eval-)/.test(path.basename(target))) {
      throw new Error("Unsafe personal scope evaluation test cleanup path");
    }
    fs.rmSync(target, { recursive: true, force: true });
  }
});

async function run(control: "snapshot" | "valid" | "invalid-fields" | "invalid-json", outputMode: OutputMode = "full") {
  const selected = control === "invalid-fields" ? [ids.find(id => id.includes(`/${outputMode}/`))!]
    : control === "invalid-json" ? [ids[0]!] : [];
  const activeIds = selected.length ? selected : ids;
  const requests: { model: string; max_tokens: number; stream: boolean; messages: ReturnType<typeof checkSafeModelInput> }[] = [];
  const methods: (string | undefined)[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    methods.push(req.method);
    const id = activeIds[Math.min(requests.length - 1, activeIds.length - 1)]!;
    const full = id.split("/")[1] === "full";
    const fullShape = { ...emptySummary(), brief: "本机合成协议控制。" };
    const resumeShape = { techStack: "", brief: "本机合成协议控制。", achievements: [] };
    const shape = (control === "invalid-fields" ? !full : full) ? fullShape : resumeShape;
    const content = control === "invalid-json" ? "private-invalid-personal-scope-output" : JSON.stringify(shape);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  servers.push(server);
  await listenForFetch(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic service unavailable");
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-personal-scope-eval-test-"));
  directories.push(source);
  fs.writeFileSync(path.join(source, "sentinel.txt"), "unchanged");
  const env = { ...process.env };
  for (const variable of Object.keys(env)) if (variable.startsWith("PROMPT_EVAL_")) delete env[variable];
  const child = spawn(process.execPath, [path.resolve("scripts/eval-prompts.mjs"), "--suite=project-personal-scope",
    ...(control === "snapshot" ? [] : ["--live"]), ...selected.map(id => `--sample=${id}`),
  ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: {
    ...env, RESUME_LIFE_DATA_DIR: source,
    PROMPT_EVAL_BASE_URL: `http://127.0.0.1:${address.port}/v1`, PROMPT_EVAL_API_KEY: key,
    PROMPT_EVAL_MODEL: "synthetic-summary-model", PROMPT_EVAL_API_FORMAT: "openai_chat",
    // The suite keeps the standard default; only explicit live controls use the longer window.
    ...(control === "snapshot" ? {} : { PROMPT_EVAL_TIMEOUT_MS: "300000" }),
    PROMPT_EVAL_LIVE: "1", PROMPT_EVAL_SUITE: "project",
  } });
  let text = "";
  child.stdout.on("data", value => { text += value; });
  child.stderr.on("data", value => { text += value; });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Personal scope evaluation fixture exceeded 20s")); }, 20_000);
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
  return { code, text, output, requests, methods, selected, read, summary: read("summary") };
}

describe("项目个人分工条件对照套件（本机合成控制）", () => {
  it("两种已知提示词都构造同一固定版本对，拒绝缺失、重复或混合条件", () => {
    expect(PROJECT_PERSONAL_SCOPE_CANDIDATE_RULE.length).toBe(PROJECT_PERSONAL_SCOPE_BEFORE.length);
    expect(Buffer.byteLength(PROJECT_PERSONAL_SCOPE_CANDIDATE_RULE)).toBe(Buffer.byteLength(PROJECT_PERSONAL_SCOPE_BEFORE));
    for (const production of [PROJECT_SUMMARY_SYSTEM_PROMPT, PROJECT_RESUME_SYSTEM_PROMPT]) {
      const pair = buildProjectPersonalScopeSystems(production);
      const { baseline, candidate } = pair;
      expect([baseline, candidate]).toContain(production);
      expect(buildProjectPersonalScopeSystems(baseline)).toEqual(pair);
      expect(buildProjectPersonalScopeSystems(candidate)).toEqual(pair);
      expect(baseline.replace(PROJECT_PERSONAL_SCOPE_BEFORE, PROJECT_PERSONAL_SCOPE_CANDIDATE_RULE)).toBe(candidate);
      expect(baseline).not.toContain(PROJECT_PERSONAL_SCOPE_CANDIDATE_RULE);
      expect(candidate).not.toContain(PROJECT_PERSONAL_SCOPE_BEFORE);
      for (const invalid of [baseline.replace(PROJECT_PERSONAL_SCOPE_BEFORE, ""), baseline + PROJECT_PERSONAL_SCOPE_BEFORE,
        candidate + PROJECT_PERSONAL_SCOPE_CANDIDATE_RULE, baseline + PROJECT_PERSONAL_SCOPE_CANDIDATE_RULE, candidate + PROJECT_PERSONAL_SCOPE_BEFORE]) {
        expect(() => buildProjectPersonalScopeSystems(invalid)).toThrow("requires exactly one known personal scope condition");
      }
    }
  });

  it.each(["snapshot", "valid"] as const)("标准入口保留16条配对、两模式固定版本消息和交替顺序：%s", async control => {
    const result = await run(control);
    expect(result.code, result.text).toBe(0);
    expect(result.summary).toMatchObject({ suite: "project-personal-scope", expectedSamples: 16, recordedSamples: 16,
      maxOutputTokens: 8192, timeoutMs: control === "snapshot" ? 60000 : 300000, status: "completed",
      protocolCounts: { "not-run": control === "snapshot" ? 16 : 0, pass: control === "valid" ? 16 : 0, fail: 0, error: 0 },
    });
    expect(result.summary.results.map((entry: { id: string }) => entry.id)).toEqual(ids);
    expect(result.requests).toHaveLength(control === "snapshot" ? 0 : 16);
    expect(result.methods).toEqual(result.requests.map(() => "POST"));
    const [implementedKnown, implementedUnknown, documentationKnown, documentationUnknown] = projectPersonalScopeCases;
    expect(implementedKnown.source.replace("本次增加记录编号的修改由本人完成。", "未提供本次增加记录编号修改的执行者信息。")).toBe(implementedUnknown.source);
    expect(documentationKnown.source.replace("当前分工为本人负责提醒规则、同事负责页面；字段说明文档由本人补充。", "未提供提醒规则、页面及字段说明文档的个人分工信息。")).toBe(documentationUnknown.source);
    for (const sample of projectPersonalScopeCases) {
      for (const mode of ["full", "resume-only"] as const) {
        const baseline = result.read(`${sample.id}/${mode}/baseline`), candidate = result.read(`${sample.id}/${mode}/candidate`);
        const system = mode === "full" ? PROJECT_SUMMARY_SYSTEM_PROMPT : PROJECT_RESUME_SYSTEM_PROMPT;
        const pair = buildProjectPersonalScopeSystems(system);
        const materials = [{ title: "合成项目记录", content: sample.source }];
        const candidateSystem = withoutEvaluationDate(candidate.assembledMessages[0]);
        const oldSystem = withoutEvaluationDate(baseline.assembledMessages[0]);
        expect(candidateSystem).toEqual(withoutEvaluationDate(checkSafeModelInput(pair.candidate, [])[0] as { role: string; content: string }));
        expect(oldSystem).toEqual(withoutEvaluationDate(checkSafeModelInput(pair.baseline, [])[0] as { role: string; content: string }));
        expect(candidate.input).toEqual(baseline.input);
        expect(candidate.input).toEqual({ projectName: sample.projectName, materials,
          materialText: materials.map(serializeProjectSummaryMaterial).join(""), archive: emptySummary(), mode });
        expect(candidate.assembledMessages.slice(1)).toEqual(baseline.assembledMessages.slice(1));
        expect(candidateSystem.content.replace(PROJECT_PERSONAL_SCOPE_CANDIDATE_RULE, PROJECT_PERSONAL_SCOPE_BEFORE)).toBe(oldSystem.content);
        expect(candidate.assembledMessages.slice(1)).toEqual(checkSafeModelInput(system, buildProjectSummaryMessages(candidate.input)).slice(1));
        for (const record of [baseline, candidate]) {
          expect(record.rubric).toEqual([...sample.rubric]);
          expect(record.rubric).toHaveLength(4);
          expect(record.rubric[3]).toContain("审阅流程（不计模型语义）");
          expect(record.inputHash).toBe(hash(record.input));
          expect(record.promptHash).toBe(hash(record.assembledMessages));
          expect(record.semanticReviewItems.every((item: { verdict: string }) => item.verdict === "pending")).toBe(true);
          if (control === "snapshot") expect(record).toMatchObject({ raw: null, observedRequests: [], protocol: "not-run" });
          else {
            const parsed = JSON.parse(record.raw);
            expect(mode === "full" ? isGeneratedProjectSummary(parsed) : Boolean(validateGeneratedProjectResume(parsed))).toBe(true);
            expect(record.observedRequests).toMatchObject([{ requestIndex: 0, stream: true, phase: "ended", outcome: "complete" }]);
          }
        }
      }
      const full = result.read(`${sample.id}/full/candidate`), resume = result.read(`${sample.id}/resume-only/candidate`);
      expect({ ...full.input, mode: "resume-only" }).toEqual(resume.input);
      expect(full.assembledMessages.slice(1)).toEqual(resume.assembledMessages.slice(1));
    }
    result.requests.forEach((request, index) => {
      expect(request).toMatchObject({ model: "synthetic-summary-model", max_tokens: 8192, stream: true });
      expect(request.messages).toEqual(result.read(ids[index]!).assembledMessages);
    });
    if (control === "snapshot") expect(fs.existsSync(path.join(result.output, "data"))).toBe(false);
  }, 25_000);

  it.each(["full", "resume-only"] as const)("%s拒绝另一模式字段结构并保留已交付raw，只执行选定一臂", async mode => {
    const result = await run("invalid-fields", mode);
    expect(result.code).toBe(1);
    expect(result.requests).toHaveLength(1);
    expect(result.summary).toMatchObject({ expectedSamples: 1, recordedSamples: 1, status: "failed",
      selection: { suiteSamples: 16, requestedIds: result.selected }, protocolCounts: { fail: 1, pass: 0, error: 0, "not-run": 0 } });
    const record = result.read(result.selected[0]!);
    expect(record).toMatchObject({ protocol: "fail", failureStage: "validation", callDeadlineExceeded: false });
    expect(record.raw).toEqual(expect.any(String));
    const parsed = JSON.parse(record.raw);
    expect(isGeneratedProjectSummary(parsed)).toBe(mode === "resume-only");
    expect(Boolean(validateGeneratedProjectResume(parsed))).toBe(mode === "full");
  }, 25_000);

  it("strict JSON失败保留三次读取观察而不交付无效正文", async () => {
    const result = await run("invalid-json");
    expect(result.code).toBe(1);
    expect(result.requests).toHaveLength(3);
    expect(result.summary).toMatchObject({ expectedSamples: 1, recordedSamples: 1, status: "failed",
      selection: { suiteSamples: 16, requestedIds: [ids[0]] }, protocolCounts: { error: 1, pass: 0, fail: 0, "not-run": 0 } });
    const record = result.read(ids[0]!);
    expect(record).toMatchObject({ raw: null, protocol: "error", failureStage: "call", callDeadlineExceeded: false });
    expect(record.observedRequests.map((request: { requestIndex: number; attempt: number; outcome: string }) => [request.requestIndex, request.attempt, request.outcome])).toEqual([[0, 0, "complete"], [1, 1, "complete"], [2, 2, "complete"]]);
    expect(JSON.stringify(record) + result.text).not.toContain("private-invalid-personal-scope-output");
  }, 25_000);
});
