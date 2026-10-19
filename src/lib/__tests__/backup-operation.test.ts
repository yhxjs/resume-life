import { afterEach, beforeEach, expect, it, vi } from "vitest";
const budget = vi.hoisted(() => ({ acquireBackupLease: vi.fn(), releaseBackupLease: vi.fn(), renewBackupLease: vi.fn() }));
vi.mock("../shared-budgets", () => budget);
import { createBackupOperation, createBackupDownloadStream, BackupOperationError } from "../backup-operation";
import { createEncryptedUploadSession, readExportRequestJson } from "../backup-request";

beforeEach(() => { vi.useFakeTimers(); budget.acquireBackupLease.mockReturnValue("backup-lease"); });
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

it("rejects busy admission before creating backup resources", () => {
  budget.acquireBackupLease.mockReturnValue(null);
  expect(() => createBackupOperation(new Request("http://localhost"))).toThrowError(expect.objectContaining({ status: 429 }));
  expect(budget.releaseBackupLease).not.toHaveBeenCalled();
});

it("times out idle operations, releases only on disposal, and removes timers", async () => {
  const operation = createBackupOperation(new Request("http://localhost"));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(() => operation.check()).toThrowError(expect.objectContaining({ status: 408 }));
  expect(budget.releaseBackupLease).not.toHaveBeenCalled();
  operation.dispose(); operation.dispose();
  expect(budget.releaseBackupLease).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("progress resets idle time without extending the overall deadline", async () => {
  const operation = createBackupOperation(new Request("http://localhost"));
  for (let i = 0; i < 30; i++) {
    await vi.advanceTimersByTimeAsync(59_000);
    operation.activity();
  }
  await vi.advanceTimersByTimeAsync(30_000);
  expect(() => operation.check()).toThrowError(expect.objectContaining({ status: 408 }));
  operation.dispose();
});

it.each(["upload", "export-json"])("request cancellation cancels a pending %s reader and releases its lock", async (kind) => {
  const controller = new AbortController();
  const cancel = vi.fn();
  let bodyController: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(value) { bodyController = value; }, cancel });
  const request = new Request("http://localhost", { method: "POST", body, duplex: "half", signal: controller.signal,
    headers: { "Content-Type": "application/json" } } as RequestInit);
  const upload = kind === "upload" ? createEncryptedUploadSession(request) : undefined;
  const result = (upload ? upload.source[Symbol.asyncIterator]().next() : readExportRequestJson(request))
    .then(() => null, (error: unknown) => error);
  controller.abort();
  // Drain microtasks without depending on a long real timer when the old reader never reacts.
  await vi.advanceTimersByTimeAsync(0);
  const cancelledBeforeCleanup = cancel.mock.calls.length;
  if (upload) await upload.finish(new Error("test cleanup"));
  else if (!cancelledBeforeCleanup) bodyController!.close();
  expect(cancelledBeforeCleanup).toBe(1);
  expect(await result).toBeInstanceOf(Error);
  expect(body.locked).toBe(false);
});

it("stalled uploads are cancelled by the operation idle deadline", async () => {
  const operation = createBackupOperation(new Request("http://localhost"));
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ cancel });
  const upload = createEncryptedUploadSession({ body, signal: operation.signal } as Request);
  const pending = upload.source[Symbol.asyncIterator]().next().catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(60_000);
  await upload.finish(new Error("cleanup"));
  expect(await pending).toBeInstanceOf(BackupOperationError);
  expect(cancel).toHaveBeenCalledOnce();
  expect(body.locked).toBe(false);
  operation.dispose();
});

it("stalled downloads close the producer before releasing admission", async () => {
  const operation = createBackupOperation(new Request("http://localhost"));
  const cleanup = Promise.withResolvers<void>();
  const closed = vi.fn();
  const source = (async function* () {
    try { yield new Uint8Array([1]); yield new Uint8Array([2]); yield new Uint8Array([3]); }
    finally { await cleanup.promise; closed(); }
  })();
  const reader = createBackupDownloadStream(source, operation).getReader();
  await reader.read();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(budget.releaseBackupLease).not.toHaveBeenCalled();
  await expect(reader.read()).rejects.toMatchObject({ status: 408 });
  cleanup.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(closed).toHaveBeenCalledOnce();
  expect(budget.releaseBackupLease).toHaveBeenCalledOnce();
  reader.releaseLock();
});

it("download cancellation closes even a producer that has not started", async () => {
  const operation = createBackupOperation(new Request("http://localhost"));
  const closeOwnedSource = vi.fn();
  const source = (async function* () { yield new Uint8Array([1]); })();
  const stream = createBackupDownloadStream(source, operation, closeOwnedSource);
  await stream.cancel();
  expect(closeOwnedSource).toHaveBeenCalledOnce();
  expect(budget.releaseBackupLease).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("failed download cleanup retains admission until a later retry closes the resource", async () => {
  const operation = createBackupOperation(new Request("http://localhost"));
  const close = vi.fn().mockRejectedValueOnce(new Error("close failed")).mockResolvedValue(undefined);
  const source = (async function* () { yield new Uint8Array([1]); })();
  await expect(createBackupDownloadStream(source, operation, close).cancel()).rejects.toThrow("close failed");
  expect(budget.releaseBackupLease).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(close).toHaveBeenCalledTimes(2);
  expect(budget.releaseBackupLease).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("deferred cleanup renews admission during persistent failure and releases only after recovery", async () => {
  const operation = createBackupOperation(new Request("http://localhost"));
  const cleanup = vi.fn().mockRejectedValue(new Error("resource busy"));
  operation.retryCleanup(cleanup);
  operation.dispose();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(budget.renewBackupLease).toHaveBeenCalled();
  expect(budget.releaseBackupLease).not.toHaveBeenCalled();
  cleanup.mockResolvedValue(undefined);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(budget.releaseBackupLease).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});
