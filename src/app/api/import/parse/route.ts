import { withRouteErrorHandling } from "@/lib/api-route";
import { NextResponse } from "next/server";
import { LlmConfigError } from "@/lib/llm";
import { extractContentFromPath, ParseBusyError } from "@/lib/parse-file";
import { FileFormatError } from "@/lib/parse-sandbox";
import { MODULE_LABELS } from "@/lib/modules";
import { validateGeneratedResumeImport, RESUME_IMPORT_SYSTEM_PROMPT, buildResumeImportMessages } from "@/lib/resume-import-llm";
import { safeChat, LLM_FEATURES } from "@/lib/safe-llm";
import { ModelInputBudgetError } from "@/lib/llm-input-budget";
import { RequestFormatError, RequestTooLargeError, readJsonBody } from "@/lib/request-limits";
import { logServerError, requestIdFrom } from "@/lib/server-errors";
import {
  isMultipartFormDataRequest,
  MultipartFormatError,
  parseMultipartUpload,
} from "@/lib/streaming-multipart";
import { errorMessage } from "@/lib/error-message";
import { resolveSession, sessionTokenFromRequest } from "@/lib/auth";
import { DataGenerationConflictError } from "@/lib/data-generation";
import { DocumentTableProvenanceError, type DocumentTableProvenance } from "@/lib/document-table-provenance";
import { isResumeImportSourceId, type ResumeImportSourceReceipt } from "@/lib/resume-import-source-contract";
import {
  issueResumeImportSource, resolveResumeImportSource,
  ResumeImportSourceInputError, ResumeImportSourceGoneError,
  ResumeImportSourceMismatchError, ResumeImportSourceCapacityError,
} from "@/lib/resume-import-source";

const forbiddenSourceFields = ["tableProvenance", "tableDocument", "segments", "provenance"];

function sourceFailure(error: unknown, recovery: Record<string, unknown>): Response | undefined {
  if (error instanceof ResumeImportSourceInputError) {
    return NextResponse.json({ error: error.message, ...recovery }, { status: 400 });
  }
  if (error instanceof ResumeImportSourceGoneError) {
    return NextResponse.json({ error: error.message, code: "IMPORT_SOURCE_EXPIRED", ...recovery }, { status: 410 });
  }
  if (error instanceof ResumeImportSourceMismatchError) {
    return NextResponse.json({ error: error.message, code: "IMPORT_SOURCE_MISMATCH", ...recovery }, { status: 409 });
  }
  if (error instanceof ResumeImportSourceCapacityError) {
    return NextResponse.json({ error: error.message, code: "IMPORT_SOURCE_CAPACITY", ...recovery },
      { status: 429, headers: { "Retry-After": String(error.retryAfter) } });
  }
}

async function handlePost(req: Request) {
  let text = "";
  let extractOnly = false;
  let provenance: DocumentTableProvenance | undefined;
  let sourceReceipt: ResumeImportSourceReceipt | undefined;
  let sourceId: string | undefined;
  let ownerTokenHash: string | undefined;
  let fileOcr: { engine: "vision" | "local"; pageCount: number; sourceType?: "pdf" | "image" } | undefined;
  const recovery = () => ({ ...(text ? { extractedText: text } : {}), ocr: fileOcr, sourceReceipt });
  const isMultipart = isMultipartFormDataRequest(req);
  let upload: Awaited<ReturnType<typeof parseMultipartUpload>> | undefined;
  try {
    if (isMultipart) {
      upload = await parseMultipartUpload(req);
      if ([...forbiddenSourceFields, "sourceReceipt"].some(key => Object.hasOwn(upload!.fields, key))) {
        return NextResponse.json({ error: "文件来源信息只能由服务器提取" }, { status: 400 });
      }
      extractOnly = upload.fields.extractOnly === "true";
      const file = upload.file;
      if (!file) {
        return NextResponse.json({ error: "未收到文件" }, { status: 400 });
      }
      const pdfMode = upload.fields.pdfMode;
      if (pdfMode !== undefined && pdfMode !== "auto" && pdfMode !== "image") {
        return NextResponse.json({ error: "PDF 读取方式无效" }, { status: 400 });
      }
      const extracted = await extractContentFromPath(file.filename, file.path, {
        signal: req.signal, ...(pdfMode === "image" ? { pdfMode } : {}),
      });
      text = extracted.text;
      fileOcr = extracted.ocr;
      provenance = extracted.tableProvenance;
    } else {
      const body = await readJsonBody<Record<string, unknown> | null>(req);
      if (body && forbiddenSourceFields.some(key => Object.hasOwn(body, key))) {
        return NextResponse.json({ error: "文件来源信息只能由服务器提取" }, { status: 400 });
      }
      if (body?.pdfMode !== undefined) {
        return NextResponse.json({ error: "PDF 读取方式仅适用于上传文件" }, { status: 400 });
      }
      text = typeof body?.text === "string" ? body.text : "";
      if (body && Object.hasOwn(body, "sourceReceipt")) {
        if (!isResumeImportSourceId(body.sourceReceipt) || typeof body.text !== "string") {
          return NextResponse.json({ error: "文件来源编号或原文格式无效" }, { status: 400 });
        }
        sourceId = body.sourceReceipt;
      }
    }
    if (sourceId || (provenance && text.trim())) {
      // Source references always belong to a real session, including in tests.
      const session = resolveSession(sessionTokenFromRequest(req));
      if (!session) return NextResponse.json({ error: "未登录或登录已过期，请重新登录", ...recovery() }, { status: 401 });
      ownerTokenHash = session.tokenHash;
      if (sourceId) {
        provenance = resolveResumeImportSource(ownerTokenHash, sourceId, text);
      } else {
        sourceReceipt = issueResumeImportSource(ownerTokenHash, text, provenance!);
        sourceId = sourceReceipt.id;
      }
    }
  } catch (err) {
    if (err instanceof DataGenerationConflictError) throw err;
    const sourceError = sourceFailure(err, recovery());
    if (sourceError) return sourceError;
    if (err instanceof ParseBusyError) {
      return NextResponse.json({ error: err.message }, { status: 429 });
    }
    if (err instanceof RequestTooLargeError) {
      return NextResponse.json({ error: "请求体或文件过大" }, { status: 413 });
    }
    if (err instanceof RequestFormatError || err instanceof MultipartFormatError) {
      return NextResponse.json({ error: "请求格式无效" }, { status: 400 });
    }
    if (err instanceof FileFormatError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    const requestId = logServerError("import.parse.request", err, {
      requestId: requestIdFrom(req),
      status: 500,
    });
    return NextResponse.json(
      { error: "简历文件处理失败，请稍后重试", requestId, ...recovery() },
      { status: 500 }
    );
  } finally {
    upload?.dispose();
  }

  if (!text.trim()) {
    return NextResponse.json({ error: "没有提取到文本内容" }, { status: 400 });
  }
  // 先交回完整原文；解析时按实际外发预算校验，不把前半份简历当成完整结果。
  if (extractOnly) return NextResponse.json(recovery());

  let raw = "";
  let modelError: unknown;
  let modelFailed = false;
  try {
    raw = await safeChat("parse", { feature: LLM_FEATURES.resumeImportParse }, RESUME_IMPORT_SYSTEM_PROMPT,
      buildResumeImportMessages(text, provenance), { signal: req.signal, requireJson: "strict" });
  } catch (err) {
    if (err instanceof DataGenerationConflictError || err instanceof DocumentTableProvenanceError) throw err;
    modelError = err;
    modelFailed = true;
  }
  // No transaction spans model I/O. Recheck revocation, expiry and restore before
  // returning either a usable draft or a retry response tied to this source.
  if (sourceId && ownerTokenHash) {
    try {
      const current = resolveResumeImportSource(ownerTokenHash, sourceId, text);
      if (JSON.stringify(current) !== JSON.stringify(provenance)) throw new DocumentTableProvenanceError();
    }
    catch (err) {
      if (err instanceof DataGenerationConflictError) throw err;
      const sourceError = sourceFailure(err, recovery());
      if (sourceError) return sourceError;
      throw err;
    }
  }
  if (modelFailed) {
    const message = modelError instanceof LlmConfigError ? modelError.message : `${errorMessage(modelError)}`;
    return NextResponse.json({ error: message, ...recovery() }, { status: modelError instanceof ModelInputBudgetError ? 413 : 502 });
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("应返回包含简历模块的 JSON 对象");
    }
  } catch (err) {
    return NextResponse.json(
      { error: `AI 解析结果异常：${errorMessage(err)}`, ...recovery() },
      { status: 502 }
    );
  }

  const result = validateGeneratedResumeImport(parsed);
  if (!result.ok) {
    const error = result.reason === "unknown-fields"
      ? "AI 解析结果异常：包含未声明字段，请根据保留的原文重试或手工整理"
      : result.reason === "invalid-module"
        ? `AI 解析结果异常：${MODULE_LABELS[result.moduleKey!]}结构无效，请根据保留的原文重试或手工整理`
        : result.reason === "invalid-text"
          ? `AI 解析结果异常：${MODULE_LABELS[result.moduleKey!]}含不可见或无效文本，请根据保留的原文重试或手工整理`
          : result.reason === "empty-item"
            ? `AI 解析结果异常：${MODULE_LABELS[result.moduleKey!]}包含空条目，请根据保留的原文重试或手工整理`
            : result.reason === "conflicting-description"
              ? `AI 解析结果异常：${MODULE_LABELS[result.moduleKey!]}正文与分条内容不一致，请根据保留的原文重试或手工整理`
            : result.reason === "too-large"
              ? "AI 解析结果过大，超过简历创建请求上限；请根据保留的原文缩短草稿后重试或手工整理"
              : "AI 未返回有效简历内容，请根据保留的原文手工整理或重新解析";
    return NextResponse.json({ error, ...recovery() }, { status: 502 });
  }
  return NextResponse.json({ title: result.title, modules: result.modules, ocr: fileOcr,
    ...(provenance ? recovery() : {}) });
}

export const POST = withRouteErrorHandling("POST /api/import/parse", handlePost);
