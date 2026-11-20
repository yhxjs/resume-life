import { afterAll, beforeAll, expect } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkSafeModelInput, type LlmUsage, type SafeMessage } from "@/lib/safe-llm";
import { LlmHttpError } from "@/lib/llm";
import type { LlmProgressObserver } from "@/lib/llm-request-progress";
import { parseMaxOutputTokens, VALID_API_FORMATS, type ApiFormat } from "@/lib/settings-constants";
import { evaluationArtifactIdentity } from "./artifact-identity";
import { parseEvaluationTimeoutMs } from "./timeout";
import { evaluationObservedUsage, evaluationResponseError, type EvaluationResponseError } from "./failure-diagnostics";
import { createEvaluationRequestProgress } from "./request-progress";
import { hasExactEvaluationSampleIds, parseEvaluationSampleEnvironment } from "../scripts/eval-selection.mjs";

type Protocol = "not-run" | "pass" | "fail" | "error";
type SupplementalProtocol = "not-run" | "pass" | "fail" | "missing";
type FailureStage = "input" | "call" | "validation";
type NotRunReason = "prior-http-429" | null;

/** 每次入口只选择一套样本；输出与专用设置均限制在入口创建的隔离目录。 */
export function createEvaluationSuite(suite: "resume-job-search" | "intro" | "project" | "project-challenge-boundaries" | "project-personal-scope" | "project-challenge-order" | "project-challenge-evidence" | "project-work-state" | "project-challenge-admission" | "project-architecture-evidence" | "project-independent-achievement" | "project-summary-field-boundaries" | "project-summary-field-repair" | "project-summary-challenge-status" | "project-summary-evidence-ledger" | "project-summary-archive-conflict" | "evaluator" | "interview" | "interview-retry" | "interview-reverse" | "interview-reference" | "interview-finish" | "interview-remediation-create" | "interview-series-answer" | "application-interview-review" | "interview-series-advance" | "interview-series-finalize" | "project-drill-create" | "project-eval-reference-scope" | "bank-drill-create" | "drill-answer" | "repo" | "salary" | "defense" | "defense-drill" | "diagnosis" | "polish" | "import" | "jd-portrait" | "jargon-decoder" | "style-generation" | "career-gap", expectedSamples: number, defaultMaxOutputTokens: number) {
  const output = path.resolve(process.env.PROMPT_EVAL_OUTPUT || ".");
  if (path.dirname(output) !== path.resolve(os.tmpdir()) || !path.basename(output).startsWith("resume-life-prompt-eval-")
    || process.env.RESUME_LIFE_DATA_DIR !== path.join(output, "data")) {
    throw new Error("请使用 npm run eval:prompts 启动隔离评估");
  }
  const live = process.env.PROMPT_EVAL_LIVE === "1";
  const model = live ? process.env.PROMPT_EVAL_MODEL?.trim() : null;
  const format = process.env.PROMPT_EVAL_API_FORMAT || "openai_chat";
  const configuredBudget = process.env.PROMPT_EVAL_MAX_OUTPUT_TOKENS;
  const maxOutputTokens = configuredBudget === undefined ? defaultMaxOutputTokens : parseMaxOutputTokens(configuredBudget);
  const budgetError = "PROMPT_EVAL_MAX_OUTPUT_TOKENS 必须是正安全整数";
  const timeoutMs = parseEvaluationTimeoutMs(process.env.PROMPT_EVAL_TIMEOUT_MS);
  const timeoutError = "PROMPT_EVAL_TIMEOUT_MS 必须是 1–300000 的完整正整数字符串";
  const requestedIds = parseEvaluationSampleEnvironment(process.env.PROMPT_EVAL_SAMPLE_IDS);
  const selectedIds = new Set(requestedIds);
  const runExpectedSamples = requestedIds.length || expectedSamples;
  const results: { id: string; protocol: Protocol; failureStage: FailureStage | null; semanticReview: string; notRunReason: NotRunReason; callDeadlineExceeded: boolean | null; responseError: EvaluationResponseError | null; observedUsage: LlmUsage | null }[] = [];
  let stopReason: "http_429" | null = null;
  const supplementalProtocolCounts: Record<string, Record<SupplementalProtocol, number>> = {};
  const recordedIds = new Set<string>();
  const outputIds = new Set<string>();
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const save = (name: string, value: unknown) => fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2), { mode: 0o600 });

  // Vitest requires destructuring for the unused fixture argument before the collected suite.
  beforeAll(async ({}, collectedSuite) => {
    for (const id of requestedIds) {
      const matches = collectedSuite.tasks.filter(task => task.type === "test" && task.name === id);
      if (matches.length !== 1 || (matches[0]?.mode !== "run" && matches[0]?.mode !== "only")) {
        throw new Error("选择的样本必须恰好对应一个未跳过的可执行测试");
      }
    }
    if (maxOutputTokens === null) throw new Error(budgetError);
    if (timeoutMs === null) throw new Error(timeoutError);
    if (!live) return;
    if (!model || !process.env.PROMPT_EVAL_API_KEY?.trim() || !process.env.PROMPT_EVAL_BASE_URL?.trim()) {
      throw new Error("真实评估缺少专用模型环境配置");
    }
    if (!VALID_API_FORMATS.has(format as ApiFormat)) throw new Error("PROMPT_EVAL_API_FORMAT 无效");
    const { writeSettings } = await import("@/lib/settings");
    writeSettings({
      base_url: process.env.PROMPT_EVAL_BASE_URL,
      api_key: process.env.PROMPT_EVAL_API_KEY,
      api_format: format,
      model_question: model,
      model_evaluate: model,
      max_output_tokens: String(maxOutputTokens),
      proxy_enabled: Boolean(process.env.PROMPT_EVAL_PROXY_URL?.trim()),
      proxy_url: process.env.PROMPT_EVAL_PROXY_URL ?? "",
      proxy_username: process.env.PROMPT_EVAL_PROXY_USERNAME ?? "",
      proxy_password: process.env.PROMPT_EVAL_PROXY_PASSWORD ?? "",
    });
  });

  afterAll(() => {
    const protocolCounts: Record<Protocol, number> = { "not-run": 0, pass: 0, fail: 0, error: 0 };
    for (const result of results) protocolCounts[result.protocol]++;
    const selectionComplete = !requestedIds.length || hasExactEvaluationSampleIds(requestedIds, results.map(result => result.id));
    const status = results.length !== runExpectedSamples || !selectionComplete ? "incomplete"
      : protocolCounts.fail + protocolCounts.error > 0 || (live && protocolCounts["not-run"] > 0) ? "failed" : "completed";
    save("summary.json", {
      schemaVersion: 4, suite, mode: live ? "live" : "snapshot", model, apiFormat: format,
      recordedAt: new Date().toISOString(), expectedSamples: runExpectedSamples, maxOutputTokens, timeoutMs,
      recordedSamples: results.length, missingSamples: requestedIds.length
        ? requestedIds.filter(id => !recordedIds.has(id)).length : Math.max(0, expectedSamples - results.length),
      ...(requestedIds.length ? { selection: { suiteSamples: expectedSamples, requestedIds } } : {}),
      status, protocolCounts, results, stopReason,
      supplementalProtocolCounts,
      semanticQuality: live ? "pending-human-review" : "not-evaluated",
      note: "Vitest 仅检查提示组装或返回协议；所有语义评分须结合每条样本的 rubric 和输出原文另行审阅。",
    });
    // 先保留不完整报告，再让漏跑、跳过或多记样本的评估以非零状态结束。
    expect(results.length, "评估记录数必须与预期样本数一致，详情见 summary.json").toBe(runExpectedSamples);
    if (requestedIds.length) expect(selectionComplete, "评估记录必须完整对应所选样本 ID，详情见 summary.json").toBe(true);
  });

  return async (sample: {
    id: string;
    input: unknown;
    system: string;
    messages: SafeMessage[];
    rubric: string[];
    call: (options: { signal: AbortSignal; maxTokens: number; requireJson: "strict"; onHttpStatus: (status: number) => void; onUsage: (usage: LlmUsage) => void; onRequestProgress: LlmProgressObserver }) => Promise<string>;
    validate: (value: unknown) => unknown;
    /** 生产允许失败后单独恢复的可选子输出；结果单独记录，不改变主输出协议状态。 */
    supplementalValidators?: Record<string, (value: unknown) => Exclude<SupplementalProtocol, "not-run">>;
  }) => {
    if (maxOutputTokens === null) throw new Error(budgetError);
    if (timeoutMs === null) throw new Error(timeoutError);
    if (requestedIds.length && !selectedIds.has(sample.id)) {
      throw new Error("评估不能记录或调用未选择的样本 ID");
    }
    const identity = evaluationArtifactIdentity(sample.id, true);
    if (!identity || recordedIds.has(sample.id) || outputIds.has(identity.key)) {
      throw new Error("评估样本 ID 必须唯一、不是保留文件名，且仅含字母、数字、连字符或斜杠");
    }
    const outputId = identity.fileId;
    recordedIds.add(sample.id);
    outputIds.add(identity.key);
    const requestProgress = createEvaluationRequestProgress();
    const record = {
      schemaVersion: 4, suite, id: sample.id, mode: live ? "live" : "snapshot", model,
      apiFormat: format, recordedAt: new Date().toISOString(),
      input: sample.input, inputHash: hash(sample.input),
      assembledMessages: null as ReturnType<typeof checkSafeModelInput> | null, promptHash: null as string | null,
      rubric: sample.rubric,
      semanticReview: live ? "pending-human-review" : "not-evaluated",
      semanticReviewItems: sample.rubric.map((criterion) => ({ criterion, verdict: "pending", evidence: "" })),
      protocol: "not-run" as Protocol, raw: null as string | null, errorType: null as string | null,
      httpStatus: null as number | null, notRunReason: null as NotRunReason,
      observedHttpStatuses: [] as number[],
      // Additive diagnostic field; outcome does not replace protocol or semantic review.
      observedRequests: requestProgress.requests,
      supplementalProtocols: Object.fromEntries(Object.keys(sample.supplementalValidators ?? {}).map(name => [name, "not-run"])) as Record<string, SupplementalProtocol>,
      failureStage: null as FailureStage | null,
      responseError: null as EvaluationResponseError | null,
      observedUsage: null as LlmUsage | null,
      callDeadlineExceeded: null as boolean | null,
      elapsedMs: 0, maxOutputTokens, timeoutMs,
    };
    const started = Date.now();
    let stage: FailureStage = "input";
    try {
      record.assembledMessages = checkSafeModelInput(sample.system, sample.messages);
      record.promptHash = hash(record.assembledMessages);
      if (live && stopReason) {
        // 保留完整输入和 rubric；未发起调用不计为调用错误或语义通过。
        record.notRunReason = "prior-http-429";
        record.semanticReview = "not-evaluated";
      } else if (live) {
        stage = "call";
        const callDeadline = AbortSignal.timeout(timeoutMs);
        try {
          record.raw = await sample.call({
            signal: callDeadline, maxTokens: maxOutputTokens, requireJson: "strict",
            onHttpStatus: status => { record.observedHttpStatuses.push(status); },
            onUsage: usage => { record.observedUsage = evaluationObservedUsage(usage); },
            onRequestProgress: requestProgress.onProgress,
          });
        } finally {
          requestProgress.close();
          // 只记录本次调用结束时的专用期限信号；不按错误名/耗时猜测原因，
          // 也不让后续校验阶段影响本次观测。未调用的样本保持 null。
          record.callDeadlineExceeded = callDeadline.aborted;
        }
        stage = "validation";
        const parsed: unknown = JSON.parse(record.raw);
        record.protocol = sample.validate(parsed) ? "pass" : "fail";
        if (record.protocol === "fail") record.failureStage = stage;
        for (const [name, validate] of Object.entries(sample.supplementalValidators ?? {})) {
          record.supplementalProtocols[name] = validate(parsed);
        }
      }
    } catch (error) {
      record.protocol = "error";
      record.failureStage = stage;
      record.responseError = evaluationResponseError(error, stage);
      // 不将服务端原始错误消息或请求配置复制到报告/控制台。
      record.errorType = error instanceof Error ? error.name : "UnknownError";
      if (stage === "call") {
        if (error instanceof LlmHttpError) record.httpStatus = error.status;
        // 重试若在收到新响应前取消，仍保留此前明确的限流；已收到新状态则覆盖旧 429。
        // 最终 typed HTTP 错误优先，httpStatus 不以历史状态冒充取消/超时的终态。
        const lastStatus = record.httpStatus ?? record.observedHttpStatuses.at(-1);
        if (lastStatus === 429) stopReason = "http_429";
      }
    } finally {
      record.elapsedMs = Date.now() - started;
      save(`${outputId}.json`, record);
      for (const [name, protocol] of Object.entries(record.supplementalProtocols)) {
        const counts = supplementalProtocolCounts[name] ??= { "not-run": 0, pass: 0, fail: 0, missing: 0 };
        counts[protocol]++;
      }
      results.push({ id: record.id, protocol: record.protocol, failureStage: record.failureStage, semanticReview: record.semanticReview, notRunReason: record.notRunReason, callDeadlineExceeded: record.callDeadlineExceeded, responseError: record.responseError, observedUsage: record.observedUsage });
    }
    expect(record.protocol, "仅返回协议检查；语义质量仍需人工审阅输出报告").toBe(live ? "pass" : "not-run");
  };
}
