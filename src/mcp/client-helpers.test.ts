import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { bindInputs, createReceipt, readAllPages, readArtifact, readContext, recoverReceipt, waitForJob, uploadBytes } from "../../examples/mcp/helpers.mjs";

const revision = "a".repeat(64);
it("resumes an ambiguous upload append using the same key, exact bytes and server offset", async () => {
  const bytes = Buffer.from("一份包含 Unicode 的文件。".repeat(4000));
  const args = { bytes, filename: "文件.txt", purpose: "resume", idempotencyKey: "upload-helper-fixture" };
  let received = 0, disconnected = false;
  const parts: Buffer[] = [];
  const descriptor = () => ({ uploadId: revision, filename: args.filename, purpose: args.purpose, byteLength: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), maxChunkBytes: 49152, receivedBytes: received, status: received === bytes.length ? "complete" : "uploading" });
  const call = vi.fn(async (name: string, input: Record<string, unknown>) => {
    if (name === "begin_mcp_upload") expect(input.idempotencyKey).toBe(args.idempotencyKey);
    if (name === "append_mcp_upload") {
      expect(input.offset).toBe(received);
      const part = Buffer.from(String(input.data), "base64"); parts.push(part); received += part.length;
      if (!disconnected) { disconnected = true; throw Object.assign(new Error("lost response"), { code: "ECONNRESET" }); }
    }
    return descriptor();
  });
  await expect(uploadBytes(call, args)).rejects.toThrow("lost response");
  const result = await uploadBytes(call, args);
  expect(result.status).toBe("complete"); expect(Buffer.concat(parts)).toEqual(bytes);
  expect(call.mock.calls.filter(([name]) => name === "append_mcp_upload").map(([, args]) => args.offset)).toEqual([0, 49152, 98304]);
  const bad = vi.fn(async () => ({ ...descriptor(), receivedBytes: bytes.length + 1 }));
  await expect(uploadBytes(bad, args)).rejects.toThrow("不一致");
});
function section(text: string, offset: number, totalLength: number, nextOffset: number | null) {
  return { encoding: "json/utf-16", revision, text, offset, totalLength, nextOffset };
}
it("assembles complete Unicode context with frozen paging and nested preview arguments", async () => {
  const text = JSON.stringify({ text: "资料😀，完整正文。" }), split = text.indexOf("，");
  const call = vi.fn().mockResolvedValueOnce({ ...section(text.slice(0, split), 0, text.length, split), previewToken: revision })
    .mockResolvedValueOnce({ ...section(text.slice(split), split, text.length, null), previewToken: revision });
  expect(await readContext(call, "preview", { proposal: true }, true)).toEqual({ revision, previewToken: revision, value: JSON.parse(text) });
  expect(call.mock.calls[1]![1]).toEqual({ proposal: true, page: { offset: split, expectedRevision: revision } });
});
it.each(["revision", "previewToken", "offset", "totalLength", "nextOffset"])("rejects a changed or malformed context %s", async field => {
  const first = { ...section('{"x":', 0, 7, 5), previewToken: revision };
  const second = { ...section("1}", 5, 7, null), previewToken: revision, [field]: field === "revision" || field === "previewToken" ? "b".repeat(64) : 0 };
  const call = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  await expect(readContext(call, "context")).rejects.toThrow();
});
it("limits context allocation before requesting subsequent pages", async () => {
  const call = vi.fn().mockResolvedValue(section("{}", 0, 1e9, 2));
  await expect(readContext(call, "context")).rejects.toThrow(/大小/); expect(call).toHaveBeenCalledTimes(1);
});
it("continues through empty filtered pages and rejects cyclic list cursors", async () => {
  const call = vi.fn().mockResolvedValueOnce({ items: [], nextCursor: "2" }).mockResolvedValueOnce({ items: [{ id: 1 }], nextCursor: null });
  expect(await readAllPages(call, "list")).toEqual([{ id: 1 }]);
  const cycle = vi.fn().mockResolvedValue({ items: [], nextCursor: "2" });
  await expect(readAllPages(cycle, "list")).rejects.toThrow(/游标/); expect(cycle).toHaveBeenCalledTimes(2);
});
it("decodes independently padded binary chunks and verifies metadata, length and digest", async () => {
  const bytes = Buffer.from("中文😀跨分段内容");
  const descriptor = { artifactId: revision, sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length };
  const call = vi.fn(async (_name: string, { offset }: { offset: number }) => {
    const end = Math.min(bytes.length, offset + 4);
    return { ...descriptor, encoding: "base64", offset, data: bytes.subarray(offset, end).toString("base64"), nextOffset: end < bytes.length ? end : null };
  });
  expect(await readArtifact(call, descriptor)).toEqual(bytes);
  await expect(readArtifact(async () => ({ ...descriptor, encoding: "base64", offset: 0, data: "!!!!", nextOffset: 4 }), descriptor)).rejects.toThrow(/编码/);
  await expect(readArtifact(async () => ({ ...descriptor, encoding: "base64", offset: 0, data: bytes.toString("base64"), nextOffset: 1 }), descriptor)).rejects.toThrow(/游标/);
});
it("persists the pending receipt before replay, retaining original parameters after timeout", async () => {
  const args = { idempotencyKey: "fixed-request-key", text: "原稿" }, receipt = createReceipt("save_generated_intro", args);
  args.text = "后来改稿";
  const events: string[] = [], seen: unknown[] = [];
  const result = await recoverReceipt(async (_name: string, input: unknown) => {
    events.push("call"); seen.push(input);
    if (seen.length === 1) throw Object.assign(new Error("late"), { code: "TIMEOUT" });
    return { id: 1 };
  }, receipt, { backoffMs: 0, persist: async (value: { status: string }) => { events.push(value.status); } });
  expect(result).toEqual({ id: 1 }); expect(events).toEqual(["pending", "call", "call", "succeeded"]);
  expect(seen).toEqual([{ idempotencyKey: "fixed-request-key", text: "原稿" }, { idempotencyKey: "fixed-request-key", text: "原稿" }]);
});
it("does not retry conflicts or writes without a replay identity", async () => {
  expect(() => createReceipt("update", { expectedRevision: revision })).toThrow(/幂等/);
  const call = vi.fn().mockRejectedValue(Object.assign(new Error("changed"), { code: "CONFLICT" }));
  await expect(recoverReceipt(call, createReceipt("save", { idempotencyKey: "fixed-request" }), { backoffMs: 0 })).rejects.toMatchObject({ code: "CONFLICT" });
  expect(call).toHaveBeenCalledTimes(1);
});
it.each(["BUSY", "TIMEOUT", "CANCELLED", "ECONNRESET"])("does not replay an explicitly non-retryable %s", async code => {
  const failure = Object.assign(new Error("terminal"), { code, retryable: false });
  const call = vi.fn().mockRejectedValue(failure), reconnect = vi.fn();
  await expect(recoverReceipt(call, createReceipt("save", { idempotencyKey: "terminal-request" }), { backoffMs: 0, reconnect })).rejects.toBe(failure);
  expect(call).toHaveBeenCalledTimes(1); expect(reconnect).not.toHaveBeenCalled();
});
it.each([true, undefined])("replays a temporary BUSY response with retryable=%s", async retryable => {
  const call = vi.fn().mockRejectedValueOnce(Object.assign(new Error("pending"), { code: "BUSY", retryable })).mockResolvedValue({ id: 1 });
  expect(await recoverReceipt(call, createReceipt("save", { idempotencyKey: "pending-request" }), { backoffMs: 0 })).toEqual({ id: 1 });
  expect(call).toHaveBeenCalledTimes(2);
});
it("returns interrupted tasks and times out waiting without cancelling server work", async () => {
  expect(await waitForJob(async () => ({ jobId: revision, status: "interrupted", resultAvailable: false }), revision)).toMatchObject({ result: null });
  const call = vi.fn(async () => ({ jobId: revision, status: "running" }));
  await expect(waitForJob(call, revision, { timeoutMs: 1, intervalMs: 1 })).rejects.toMatchObject({ code: "JOB_WAIT_TIMEOUT", jobId: revision });
  expect(call.mock.calls.every(([name]: unknown[]) => name === "get_mcp_job")).toBe(true);
});
it("binds nested catalog data without interpreting values as code or exposing prototypes", () => {
  const variables = { id: 1, persisted: { key: "stable-key" }, content: "$literal $(not executed)" };
  expect(bindInputs({ source: { id: "$id" }, key: "$persisted.key", text: "$content" }, variables))
    .toEqual({ source: { id: 1 }, key: "stable-key", text: "$literal $(not executed)" });
  expect(() => bindInputs({ value: "$persisted.constructor" }, variables)).toThrow();
  expect(() => bindInputs({ value: "$missing" }, variables)).toThrow();
});
