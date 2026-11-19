import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProjectSummaryMessages, PROJECT_SUMMARY_SYSTEM_PROMPT, serializeProjectSummaryMaterial } from "../project-summary-llm";
import { emptySummary, isGeneratedProjectSummary, normalizeSummary } from "../summary";
import { checkSafeModelInput } from "../safe-llm";
import { compareProjectSummaries } from "../project-summary-diff";
import { matchesProjectSummary, readProjectSummarySaveConfirmation } from "../project-summary-save";
import { buildProjectChallengeOrderSystems, projectChallengeOrderCases } from "../../../evals/project-challenge-order-fixture";
import { projectChallengeBoundaryCases } from "../../../evals/project-challenge-boundaries-fixture";
import { projectPersonalScopeCases } from "../../../evals/project-personal-scope-fixture";
import { listenForFetch } from "../../../tests/support/http-server";
import { withoutEvaluationDate } from "./helpers/evaluation-system-message";

const directories: string[] = [], servers: Server[] = [];
const key = "synthetic-challenge-order-key-never-real";
const ids = ["log-progress/full/baseline", "log-progress/full/candidate", "log-unresolved/full/candidate", "log-unresolved/full/baseline",
  "csv-verified/full/baseline", "csv-verified/full/candidate", "csv-unverified/full/candidate", "csv-unverified/full/baseline",
  "implemented-change-known-author/full/baseline", "implemented-change-known-author/full/candidate",
  "documentation-unknown-role/full/candidate", "documentation-unknown-role/full/baseline"];
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const example = (system: string) => system.match(/字段值不带标题前缀：\n(\{\n[\s\S]*?\n\})/)![1]!;

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve()); server.closeAllConnections();
  })));
  for (const directory of directories.splice(0)) {
    const target = path.resolve(directory);
    if (path.dirname(target) !== path.resolve(os.tmpdir()) || !/^resume-life-(?:challenge-order-test-|prompt-eval-)/.test(path.basename(target))) {
      throw new Error("Unsafe challenge order test cleanup path");
    }
    fs.rmSync(target, { recursive: true, force: true });
  }
});

async function run(control: "snapshot" | "valid" | "invalid-fields" | "invalid-json") {
  const selected = control === "invalid-fields" ? [ids[1]!] : control === "invalid-json" ? [ids[0]!] : [];
  const requests: { model: string; max_tokens: number; stream: boolean; messages: ReturnType<typeof checkSafeModelInput> }[] = [];
  const methods: (string | undefined)[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8"))); methods.push(req.method);
    const content = control === "invalid-json" ? "private-invalid-challenge-order-output"
      : JSON.stringify({ ...emptySummary(), overview: "本机合成协议控制。", ...(control === "invalid-fields" ? { extra: true } : {}) });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
  });
  servers.push(server); await listenForFetch(server);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic service unavailable");
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-challenge-order-test-")); directories.push(source);
  fs.writeFileSync(path.join(source, "sentinel.txt"), "unchanged");
  const env = { ...process.env };
  for (const variable of Object.keys(env)) if (variable.startsWith("PROMPT_EVAL_")) delete env[variable];
  const child = spawn(process.execPath, [path.resolve("scripts/eval-prompts.mjs"), "--suite=project-challenge-order",
    ...(control === "snapshot" ? [] : ["--live"]), ...selected.map(id => `--sample=${id}`),
  ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: {
    ...env, RESUME_LIFE_DATA_DIR: source, PROMPT_EVAL_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
    PROMPT_EVAL_API_KEY: key, PROMPT_EVAL_MODEL: "synthetic-summary-model", PROMPT_EVAL_API_FORMAT: "openai_chat",
    ...(control === "snapshot" ? {} : { PROMPT_EVAL_TIMEOUT_MS: "300000" }),
    PROMPT_EVAL_LIVE: "1", PROMPT_EVAL_SUITE: "project",
  } });
  let text = "";
  child.stdout.on("data", value => { text += value; }); child.stderr.on("data", value => { text += value; });
  const code = await new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Challenge order fixture exceeded 20s")); }, 20_000);
    child.once("error", error => { clearTimeout(timeout); reject(error); });
    child.once("exit", status => { clearTimeout(timeout); resolve(status); });
  });
  expect(fs.readdirSync(source)).toEqual(["sentinel.txt"]);
  expect(fs.readFileSync(path.join(source, "sentinel.txt"), "utf8")).toBe("unchanged"); expect(text).not.toContain(key);
  const output = text.match(/(?:提示词快照（零模型调用）|真实模型评估)：([^\r\n]+)/)?.[1];
  if (!output) throw new Error("Evaluation did not produce an output directory");
  directories.push(output);
  const read = (id: string) => JSON.parse(fs.readFileSync(path.join(output, `${id.replaceAll("/", "-")}.json`), "utf8"));
  return { code, text, output, requests, methods, selected, read, summary: read("summary") };
}

describe("项目难点键序对照套件（本机合成控制）", () => {
  it("仅移动完整challenges成员，旧序或新序均构造固定版本对并拒绝不明模板", () => {
    const pair = buildProjectChallengeOrderSystems(PROJECT_SUMMARY_SYSTEM_PROMPT);
    expect(pair.baseline).toBe(PROJECT_SUMMARY_SYSTEM_PROMPT);
    const before = example(pair.baseline), after = example(pair.candidate);
    expect(JSON.parse(after)).toEqual(JSON.parse(before));
    expect(Object.keys(JSON.parse(after))).toEqual(["challenges", "overview", "architecture", "highlights", "responsibilities", "techStack", "brief", "achievements"]);
    expect(after.split("\n").slice(1, -1).sort()).toEqual(before.split("\n").slice(1, -1).sort());
    expect(pair.candidate.replace(after, before)).toBe(pair.baseline);
    expect(Buffer.byteLength(pair.candidate)).toBe(Buffer.byteLength(pair.baseline));
    expect(buildProjectChallengeOrderSystems(pair.candidate)).toEqual(pair);
    const members = before.split("\n"), missing = members.filter(line => !line.startsWith('  "challenges":')).join("\n");
    const sameLineDuplicate = before.replace(members[1]!, members[1]!.replace(/,$/, ', "overview": "重复",'));
    [members[1], members[2]] = [members[2]!, members[1]!];
    for (const invalid of [pair.baseline.replace(before, missing), pair.baseline.replace(before, members.join("\n")),
      pair.baseline + before, pair.baseline + after, pair.baseline + pair.baseline, pair.baseline.replace(before, "{}"), pair.baseline.replace(before, sameLineDuplicate)]) {
      expect(() => buildProjectChallengeOrderSystems(invalid)).toThrow("requires one complete eight-field example");
    }
  });

  it("四份168材料及判据逐字沿用，两份170材料只前加难点为空的直接判据", () => {
    expect(projectChallengeOrderCases).toHaveLength(6);
    expect(projectChallengeOrderCases.slice(0, 4)).toEqual(projectChallengeBoundaryCases);
    for (const [sample, original] of [[projectChallengeOrderCases[4], projectPersonalScopeCases[0]], [projectChallengeOrderCases[5], projectPersonalScopeCases[3]]] as const) {
      expect(sample.id).toBe(original.id); expect(sample.projectName).toBe(original.projectName); expect(sample.source).toBe(original.source);
      expect(sample.rubric).toHaveLength(5); expect(sample.rubric[0]).toBe("本例未提供实际技术问题，challenges应空；提交/未测试/未知实现/未发布不独立成为难点"); expect(sample.rubric.slice(1)).toEqual(original.rubric);
    }
  });

  it("相同正文换键序仍通过消费校验、规范化、差异及保存确认", () => {
    const before = { ...emptySummary(), overview: "本机控制", challenges: "实际问题及处理", brief: "本机控制", achievements: ["处理记录"] };
    const after = { challenges: before.challenges, ...Object.fromEntries(Object.entries(before).filter(([key]) => key !== "challenges")) };
    expect(Object.keys(after)[0]).toBe("challenges"); expect(isGeneratedProjectSummary(before)).toBe(true); expect(isGeneratedProjectSummary(after)).toBe(true);
    const normalized = normalizeSummary(after);
    expect(JSON.stringify(normalized)).toBe(JSON.stringify(normalizeSummary(before)));
    expect(compareProjectSummaries(before, normalized, {})).toEqual([]); expect(matchesProjectSummary(normalized, before)).toBe(true);
    expect(readProjectSummarySaveConfirmation({ revisionId: 2, summary: after }, before, 1).revisionId).toBe(2);
  });

  it.each(["snapshot", "valid"] as const)("标准入口保存12条固定配对和完整请求消息：%s", async control => {
    const result = await run(control);
    expect(result.code, result.text).toBe(0);
    expect(result.summary).toMatchObject({ suite: "project-challenge-order", expectedSamples: 12, recordedSamples: 12,
      maxOutputTokens: 8192, timeoutMs: control === "snapshot" ? 60000 : 300000, missingSamples: 0, status: "completed" });
    expect(result.summary.results.map((record: { id: string }) => record.id)).toEqual(ids);
    expect(result.requests).toHaveLength(control === "snapshot" ? 0 : 12); expect(result.methods).toEqual(result.requests.map(() => "POST"));
    if (control === "snapshot") expect(fs.existsSync(path.join(result.output, "data"))).toBe(false);
    const systems = buildProjectChallengeOrderSystems(PROJECT_SUMMARY_SYSTEM_PROMPT);
    for (const sample of projectChallengeOrderCases) {
      const baseline = result.read(`${sample.id}/full/baseline`), candidate = result.read(`${sample.id}/full/candidate`);
      expect(candidate.input).toEqual(baseline.input); expect(candidate.rubric).toEqual(baseline.rubric); expect(candidate.assembledMessages.slice(1)).toEqual(baseline.assembledMessages.slice(1));
      const materials = [{ title: "合成项目记录", content: sample.source }];
      const input = { projectName: sample.projectName, materials, materialText: materials.map(serializeProjectSummaryMaterial).join(""), archive: emptySummary(), mode: "full" };
      for (const arm of ["baseline", "candidate"] as const) {
        const record = arm === "baseline" ? baseline : candidate;
        expect(record.input).toEqual(input); expect(record.rubric).toEqual([...sample.rubric]);
        const expected = checkSafeModelInput(systems[arm], buildProjectSummaryMessages(input));
        expect(withoutEvaluationDate(record.assembledMessages[0])).toEqual(withoutEvaluationDate(expected[0] as { role: string; content: string }));
        expect(record.assembledMessages.slice(1)).toEqual(expected.slice(1));
        expect(record.inputHash).toBe(hash(input)); expect(record.promptHash).toBe(hash(record.assembledMessages));
        expect(record.protocol).toBe(control === "snapshot" ? "not-run" : "pass");
        if (control === "valid") expect(isGeneratedProjectSummary(JSON.parse(record.raw))).toBe(true);
        else { expect(record.raw).toBeNull(); expect(record.observedRequests).toEqual([]); }
      }
    }
    result.requests.forEach((request, index) => {
      expect(request).toMatchObject({ model: "synthetic-summary-model", max_tokens: 8192, stream: true });
      expect(request.messages).toEqual(result.read(ids[index]!).assembledMessages);
    });
  }, 25_000);

  it("选定一臂字段错误保留raw及进度，不扩展选择或重跑", async () => {
    const result = await run("invalid-fields"), record = result.read(ids[1]!);
    expect(result.code).toBe(1); expect(result.requests).toHaveLength(1);
    expect(result.summary).toMatchObject({ expectedSamples: 1, recordedSamples: 1, selection: { requestedIds: [ids[1]] }, protocolCounts: { fail: 1, pass: 0, error: 0, "not-run": 0 } });
    expect(record).toMatchObject({ protocol: "fail", failureStage: "validation", callDeadlineExceeded: false });
    expect(JSON.parse(record.raw).extra).toBe(true); expect(record.rubric).toEqual([...projectChallengeOrderCases[0].rubric]);
    expect(record.observedRequests).toHaveLength(1); expect(record.observedRequests[0]).toMatchObject({ phase: "ended", httpStatus: 200, outcome: "complete" });
  }, 25_000);

  it("strict JSON失败保留三次尝试及未交付状态", async () => {
    const result = await run("invalid-json"), record = result.read(ids[0]!);
    expect(result.code).toBe(1); expect(result.requests).toHaveLength(3);
    expect(result.summary).toMatchObject({ expectedSamples: 1, recordedSamples: 1, selection: { requestedIds: [ids[0]] }, protocolCounts: { error: 1, pass: 0, fail: 0, "not-run": 0 } });
    expect(record).toMatchObject({ raw: null, protocol: "error", failureStage: "call", callDeadlineExceeded: false });
    expect(record.observedRequests.map((request: { requestIndex: number; attempt: number; outcome: string }) => [request.requestIndex, request.attempt, request.outcome])).toEqual([[0, 0, "complete"], [1, 1, "complete"], [2, 2, "complete"]]);
    expect(JSON.stringify(record) + result.text).not.toContain("private-invalid-challenge-order-output");
  }, 25_000);
});
