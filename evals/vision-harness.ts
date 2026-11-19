import { afterAll, beforeAll, expect } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkSafeVisionModelInput, LLM_FEATURES, safeVisionChat, type LlmUsage } from "@/lib/safe-llm";
import { parseMaxOutputTokens, VALID_API_FORMATS, type ApiFormat } from "@/lib/settings-constants";
import { renderVisionPage } from "./vision-fixtures";
import { hasOcrText } from "@/lib/ocr-output";
import { evaluationArtifactIdentity } from "./artifact-identity";
import { evaluationObservedUsage, evaluationResponseError, type EvaluationResponseError } from "./failure-diagnostics";

type Protocol = "not-run" | "pass" | "fail" | "error";
type FailureStage = "input" | "call" | "validation";
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

export function createVisionEvaluationSuite(expectedSamples: number) {
  const output = path.resolve(process.env.VISION_EVAL_OUTPUT || ".");
  if (path.dirname(output) !== path.resolve(os.tmpdir()) || !path.basename(output).startsWith("resume-life-vision-eval-") ||
      process.env.RESUME_LIFE_DATA_DIR !== path.join(output, "data")) {
    throw new Error("请使用 npm run eval:vision 启动隔离评估");
  }
  const live = process.env.VISION_EVAL_LIVE === "1";
  const model = live ? process.env.VISION_EVAL_MODEL?.trim() : null;
  const format = process.env.VISION_EVAL_API_FORMAT || "openai_chat";
  const configuredBudget = process.env.VISION_EVAL_MAX_OUTPUT_TOKENS;
  const maxOutputTokens = configuredBudget === undefined ? 2400 : parseMaxOutputTokens(configuredBudget);
  const budgetError = "VISION_EVAL_MAX_OUTPUT_TOKENS 必须是正安全整数";
  const results: { id: string; protocol: Protocol; failureStage: FailureStage | null; responseError: EvaluationResponseError | null; observedUsage: LlmUsage | null }[] = [];
  const ids = new Set<string>();
  const save = (name: string, value: unknown) => fs.writeFileSync(path.join(output, name), JSON.stringify(value, null, 2), { mode: 0o600 });

  beforeAll(async () => {
    if (maxOutputTokens === null) throw new Error(budgetError);
    if (!live) return;
    if (!model || !process.env.VISION_EVAL_API_KEY?.trim() || !process.env.VISION_EVAL_BASE_URL?.trim() || !VALID_API_FORMATS.has(format as ApiFormat)) {
      throw new Error("视觉评估模型环境配置无效");
    }
    const { writeSettings } = await import("@/lib/settings");
    writeSettings({
      base_url: process.env.VISION_EVAL_BASE_URL, api_key: process.env.VISION_EVAL_API_KEY,
      api_format: format, model_parse: model, max_output_tokens: String(maxOutputTokens),
      proxy_enabled: Boolean(process.env.VISION_EVAL_PROXY_URL?.trim()),
      proxy_url: process.env.VISION_EVAL_PROXY_URL ?? "",
      proxy_username: process.env.VISION_EVAL_PROXY_USERNAME ?? "",
      proxy_password: process.env.VISION_EVAL_PROXY_PASSWORD ?? "",
    });
  });

  afterAll(() => {
    const protocolCounts: Record<Protocol, number> = { "not-run": 0, pass: 0, fail: 0, error: 0 };
    for (const result of results) protocolCounts[result.protocol]++;
    save("summary.json", {
      schemaVersion: 1, suite: "vision-ocr", mode: live ? "live" : "snapshot", model, apiFormat: format,
      expectedSamples, maxOutputTokens, recordedSamples: results.length, missingSamples: Math.max(0, expectedSamples - results.length),
      status: results.length !== expectedSamples ? "incomplete" : protocolCounts.fail + protocolCounts.error ? "failed" : "completed",
      protocolCounts, results, semanticQuality: live ? "pending-human-review" : "not-evaluated",
      note: "协议通过仅说明返回非空可见文本；转录准确率、顺序和指令边界必须对照保存的图片逐项审阅。",
    });
    // 先保留不完整报告，再让漏跑、跳过或多记样本的评估以非零状态结束。
    expect(results.length, "视觉评估记录数必须与预期样本数一致，详情见 summary.json").toBe(expectedSamples);
  });

  return async (sample: {
    id: string; system: string; pages: readonly { pageNumber: number; svg: string }[];
    referenceText: string; rubric: readonly string[];
  }) => {
    if (maxOutputTokens === null) throw new Error(budgetError);
    const identity = evaluationArtifactIdentity(sample.id);
    if (!identity || ids.has(identity.key)) throw new Error("视觉评测 ID 必须唯一、不是保留文件名，且仅含小写字母、数字和连字符");
    ids.add(identity.key);
    const record = {
      schemaVersion: 1, suite: "vision-ocr", id: sample.id, mode: live ? "live" : "snapshot", model, apiFormat: format,
      recordedAt: new Date().toISOString(),
      pages: [] as { pageNumber: number; file: string; sha256: string; sourceHash: string; bytes: number }[],
      assembledMessages: null as unknown, promptHash: null as string | null,
      referenceText: sample.referenceText, rubric: sample.rubric,
      semanticReview: live ? "pending-human-review" : "not-evaluated",
      semanticReviewItems: sample.rubric.map(criterion => ({ criterion, verdict: "pending", evidence: "" })),
      protocol: "not-run" as Protocol, raw: null as string | null, errorType: null as string | null,
      responseError: null as EvaluationResponseError | null,
      observedUsage: null as LlmUsage | null,
      failureStage: null as FailureStage | null, elapsedMs: 0, maxOutputTokens, timeoutMs: 60_000,
    };
    const start = Date.now();
    let stage: FailureStage = "input";
    try {
      const images = [];
      for (const [index, page] of sample.pages.entries()) {
        const buffer = await renderVisionPage(page.svg);
        const file = `${sample.id}-${index + 1}.png`;
        fs.writeFileSync(path.join(output, file), buffer, { mode: 0o600 });
        record.pages.push({ pageNumber: page.pageNumber, file, sha256: hash(buffer), sourceHash: hash(page.svg), bytes: buffer.length });
        images.push({ pageNumber: page.pageNumber, dataUrl: `data:image/png;base64,${buffer.toString("base64")}` });
      }
      const assembled = checkSafeVisionModelInput(sample.system, images);
      record.promptHash = hash(JSON.stringify(assembled));
      let imageIndex = 0;
      record.assembledMessages = assembled.map(message => ({
        ...message,
        content: typeof message.content === "string" ? message.content : message.content.map(part => {
          if (part.type === "text") return part;
          const page = record.pages[imageIndex++];
          if (!page) throw new Error("视觉输入图片与报告索引不一致");
          return { type: "image_reference", file: page.file, sha256: page.sha256, pageNumber: page.pageNumber, detail: part.image_url.detail };
        }),
      }));
      if (live) {
        stage = "call";
        record.raw = await safeVisionChat("parse", { feature: LLM_FEATURES.resumeImportParse }, sample.system, images,
          { signal: AbortSignal.timeout(60_000), maxTokens: maxOutputTokens,
            onUsage: usage => { record.observedUsage = evaluationObservedUsage(usage); } });
        stage = "validation";
        // 内容正确性不由关键词判断；保留未经截断、改写的安全调用层原文供人工审阅。
        record.protocol = hasOcrText(record.raw) ? "pass" : "fail";
        if (record.protocol === "fail") record.failureStage = stage;
      }
    } catch (error) {
      record.protocol = "error";
      record.failureStage = stage;
      record.responseError = evaluationResponseError(error, stage);
      record.errorType = error instanceof Error ? error.name : "UnknownError";
    } finally {
      record.elapsedMs = Date.now() - start;
      save(`${sample.id}.json`, record);
      results.push({ id: record.id, protocol: record.protocol, failureStage: record.failureStage, responseError: record.responseError, observedUsage: record.observedUsage });
    }
    expect(record.protocol, "仅校验调用协议；视觉转录质量仍需人工审阅").toBe(live ? "pass" : "not-run");
  };
}
