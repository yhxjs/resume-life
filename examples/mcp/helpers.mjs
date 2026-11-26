import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

/** @returns {never} */
const invalid = message => { throw new Error(message); };
const natural = value => Number.isSafeInteger(value) && value >= 0;

/** Resolve catalog variables as data, never by evaluating JavaScript or template expressions. */
export function bindInputs(inputs, variables) {
  const visit = (value, depth) => {
    if (depth > 30) invalid("工作流参数嵌套过深");
    if (typeof value === "string" && value.startsWith("$")) {
      if (!/^\$[A-Za-z_]\w*(?:\.(?:[A-Za-z_]\w*|\d+))*$/.test(value)) invalid("工作流变量格式无效");
      let selected = variables;
      for (const key of value.slice(1).split(".")) {
        if (["__proto__", "prototype", "constructor"].includes(key) || selected === null || typeof selected !== "object" || !Object.hasOwn(selected, key)) invalid("工作流变量未提供：" + value);
        selected = selected[key];
      }
      if (selected === undefined) invalid("工作流变量未提供：" + value);
      return structuredClone(selected);
    }
    if (Array.isArray(value)) return value.map(item => visit(item, depth + 1));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => {
        if (["__proto__", "prototype", "constructor"].includes(key)) invalid("工作流参数字段无效");
        return [key, visit(item, depth + 1)];
      }));
    }
    return value;
  };
  return visit(inputs, 0);
}

/** Reads complete JSON with one revision. Preview tools place paging arguments under `page`. */
export async function readContext(call, name, args = {}, preview = false, { maxChars = 8 * 1024 * 1024, signal } = {}) {
  let offset = 0, first;
  const fragments = [];
  for (let index = 0; index < 4096; index++) {
    signal?.throwIfAborted();
    const paging = { offset, ...(first ? { expectedRevision: first.revision } : {}) };
    const part = await call(name, { ...args, ...(preview ? { page: { ...args.page, ...paging } } : paging) });
    if (part.encoding !== "json/utf-16" || part.offset !== offset || typeof part.text !== "string" || typeof part.revision !== "string" ||
      !natural(part.totalLength) || part.totalLength > maxChars) invalid("正文片段或大小无效");
    if (first && (part.revision !== first.revision || part.totalLength !== first.totalLength || part.previewToken !== first.previewToken)) invalid("正文版本在读取中发生变化");
    first ??= part;
    const end = offset + part.text.length;
    if (end > first.totalLength || (part.nextOffset === null ? end !== first.totalLength : part.nextOffset !== end || end <= offset || end >= first.totalLength)) invalid("正文游标没有按片段长度推进");
    fragments.push(part.text);
    if (part.nextOffset === null) return { revision: first.revision, previewToken: first.previewToken, value: JSON.parse(fragments.join("")) };
    offset = part.nextOffset;
  }
  invalid("正文分页超过上限");
}

/** Empty pages can still have a cursor, for example when inaccessible jobs were filtered. */
export async function readAllPages(call, name, args = {}, { maxItems = 100_000, maxPages = 10_000, signal } = {}) {
  const items = [], seen = new Set();
  let cursor = args.cursor;
  for (let index = 0; index < maxPages; index++) {
    signal?.throwIfAborted();
    const page = await call(name, { ...args, ...(cursor === undefined ? {} : { cursor }) });
    if (!Array.isArray(page.items) || items.length + page.items.length > maxItems) invalid("列表结果超过上限或格式无效");
    items.push(...page.items);
    if (page.nextCursor === null) return items;
    if (typeof page.nextCursor !== "string" || !page.nextCursor || page.nextCursor === cursor || seen.has(page.nextCursor)) invalid("列表游标循环或格式无效");
    seen.add(page.nextCursor); cursor = page.nextCursor;
  }
  invalid("列表分页超过上限");
}

/** Binary offsets count bytes; each chunk is decoded separately and the complete digest is checked. */
export async function readArtifact(call, artifact, { maxBytes = 20 * 1024 * 1024, signal } = {}) {
  if (!natural(artifact.byteLength) || artifact.byteLength > maxBytes || !/^[a-f0-9]{64}$/.test(artifact.sha256 ?? "") || !/^[a-f0-9]{64}$/.test(artifact.artifactId ?? "")) invalid("产物描述或大小无效");
  const parts = [];
  let offset = 0;
  do {
    signal?.throwIfAborted();
    const page = await call("read_export_artifact", { artifactId: artifact.artifactId, offset });
    if (page.offset !== offset || page.artifactId !== artifact.artifactId || page.sha256 !== artifact.sha256 || page.byteLength !== artifact.byteLength || page.encoding !== "base64" ||
      typeof page.data !== "string" || page.data.length > 10668) invalid("产物片段不匹配");
    const bytes = Buffer.from(page.data, "base64");
    if (bytes.toString("base64") !== page.data || bytes.length > 8000) invalid("产物片段编码无效");
    const end = offset + bytes.length;
    if (end > artifact.byteLength || (page.nextOffset === null ? end !== artifact.byteLength : page.nextOffset !== end || end <= offset || end >= artifact.byteLength)) invalid("产物游标没有按字节推进");
    parts.push(bytes); offset = end;
    if (page.nextOffset === null) break;
  } while (offset < artifact.byteLength);
  const bytes = Buffer.concat(parts);
  if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) invalid("产物校验和不一致");
  return bytes;
}

/**
 * Resume by invoking again with the same key and original bytes after reconnect.
 * The helper queries the server offset; an ambiguous append never requires a new upload key.
 */
export async function uploadBytes(call, { bytes, filename, purpose, idempotencyKey }, { signal } = {}) {
  if (!(bytes instanceof Uint8Array)) invalid("上传内容必须是字节数组");
  const original = Buffer.from(bytes);
  if (original.length < 1 || original.length > (purpose === "avatar" ? 5 : 10) * 1024 * 1024) invalid("上传文件大小超出范围");
  const sha256 = createHash("sha256").update(original).digest("hex");
  const args = { filename, purpose, idempotencyKey, byteLength: original.length, sha256 };
  signal?.throwIfAborted();
  const started = await call("begin_mcp_upload", args);
  const validate = current => {
    if (!/^[a-f0-9]{64}$/.test(started.uploadId ?? "") || current.uploadId !== started.uploadId || current.byteLength !== original.length ||
        current.sha256 !== sha256 || current.purpose !== purpose || current.filename !== filename || !natural(current.receivedBytes) ||
        current.receivedBytes > original.length || !natural(current.maxChunkBytes) || current.maxChunkBytes < 1 || current.maxChunkBytes > 49152) invalid("上传描述与本地文件不一致");
    if (!["uploading", "complete"].includes(current.status)) throw Object.assign(new Error("上传已过期或恢复失效，请核对原提交后使用新的上传键"), { code: "CONFLICT" });
    if (current.status === "complete" && current.receivedBytes !== original.length) invalid("上传完成状态无效");
  };
  let current = await call("get_mcp_upload", { uploadId: started.uploadId }); validate(current);
  while (current.receivedBytes < original.length) {
    signal?.throwIfAborted();
    const offset = current.receivedBytes, end = Math.min(original.length, offset + current.maxChunkBytes);
    current = await call("append_mcp_upload", { uploadId: started.uploadId, offset, data: original.subarray(offset, end).toString("base64") });
    validate(current); if (current.receivedBytes !== end) invalid("上传游标未按本次片段推进");
  }
  signal?.throwIfAborted();
  current = await call("complete_mcp_upload", { uploadId: started.uploadId }); validate(current);
  if (current.status !== "complete") invalid("上传未完成");
  return current;
}

/** Persist this JSON before submitting. Recovery always replays the exact same parameters and key. */
export function createReceipt(name, args) {
  const copy = JSON.parse(JSON.stringify(args));
  const identity = name === "start_mcp_job" ? copy.arguments : copy;
  if (!identity || !(typeof identity.idempotencyKey === "string" && /^[A-Za-z0-9._:-]{8,128}$/.test(identity.idempotencyKey) ||
    name === "submit_review" && typeof identity.requestId === "string" && /^[0-9a-f-]{36}$/i.test(identity.requestId))) invalid("回执恢复需要原操作的幂等键或复习 requestId");
  return { version: 1, name, arguments: copy };
}

/**
 * persist(record) must durably save the pending request; it may contain private candidate data.
 * @param {Function} call
 * @param {{version: number, name: string, arguments: object}} receipt
 * @param {{persist?: (record: {status: string, [key: string]: unknown}) => Promise<void>, reconnect?: () => Promise<void>, attempts?: number, backoffMs?: number, signal?: AbortSignal}} [options]
 */
export async function recoverReceipt(call, receipt, { persist, reconnect, attempts = 3, backoffMs = 200, signal } = {}) {
  if (receipt.version !== 1 || !Number.isInteger(attempts) || attempts < 1 || attempts > 10 || !natural(backoffMs) || backoffMs > 30_000) invalid("回执恢复参数无效");
  const original = createReceipt(receipt.name, receipt.arguments);
  if (persist) await persist({ ...original, status: "pending" });
  for (let attempt = 0; attempt < attempts; attempt++) {
    signal?.throwIfAborted();
    let result;
    try { result = await call(original.name, structuredClone(original.arguments)); }
    catch (error) {
      const ambiguousTransport = ["ECONNRESET", "EPIPE", "ETIMEDOUT", -32000, -32001].includes(error?.code);
      if (error?.retryable === false || attempt + 1 >= attempts || !["BUSY", "TIMEOUT", "CANCELLED"].includes(error?.code) && !ambiguousTransport) throw error;
      if (ambiguousTransport && reconnect) await reconnect();
      await delay(Math.min(30_000, backoffMs * 2 ** attempt), undefined, { signal }); continue;
    }
    if (persist) await persist({ ...original, status: "succeeded", result });
    return result;
  }
}

/** A client wait timeout does not cancel a persisted server job; keep jobId for reconnection. */
export async function waitForJob(call, jobId, { timeoutMs = 600_000, intervalMs = 500, signal } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000 || !natural(intervalMs) || intervalMs < 1 || intervalMs > 30_000) invalid("任务等待参数无效");
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    const job = await call("get_mcp_job", { jobId });
    if (job.jobId !== jobId || !["running", "succeeded", "failed", "cancelled", "interrupted", "invalidated"].includes(job.status)) invalid("任务状态无效");
    if (job.status !== "running") return { job, result: job.status === "succeeded" && job.resultAvailable ? (await readContext(call, "get_mcp_job_result", { jobId }, false, { signal })).value : null };
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw Object.assign(new Error("客户端等待结束，使用同一 jobId 继续查询"), { code: "JOB_WAIT_TIMEOUT", jobId });
    await delay(Math.min(intervalMs, remaining), undefined, { signal });
  }
}
