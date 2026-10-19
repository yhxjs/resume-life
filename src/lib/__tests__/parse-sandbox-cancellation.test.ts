import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const factories = vi.hoisted(() => ({ worker: vi.fn(), spawn: vi.fn() }));
vi.mock("node:worker_threads", () => ({
  Worker: class { constructor() { return factories.worker(); } },
}));
vi.mock("node:child_process", () => ({ spawn: factories.spawn }));

import { runInSandboxedProcess, runInSandboxedWorker } from "../parse-sandbox";

const workerLimits = { timeoutMs: 1_000, maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 };
const processLimits = { timeoutMs: 1_000, maxOldSpaceSizeMb: 64 };

beforeEach(() => { vi.useFakeTimers(); factories.worker.mockReset(); factories.spawn.mockReset(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("sandbox cancellation resource lifecycle", () => {
  it("pre-cancelled work creates neither Worker nor process", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled before extraction");
    controller.abort(reason);
    await expect(runInSandboxedWorker("", {}, workerLimits, "timeout", (message) => message, {
      signal: controller.signal,
    })).rejects.toBe(reason);
    await expect(runInSandboxedProcess("", "", Buffer.alloc(0), processLimits, "timeout", (value) => value, {
      signal: controller.signal,
    })).rejects.toBe(reason);
    expect(factories.worker).not.toHaveBeenCalled();
    expect(factories.spawn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("Worker cancellation waits for termination and clears the abort listener and timer", async () => {
    const worker = Object.assign(new EventEmitter(), { terminate: vi.fn() });
    let completeTermination!: () => void;
    worker.terminate.mockReturnValue(new Promise<void>((resolve) => { completeTermination = resolve; }));
    factories.worker.mockReturnValue(worker);
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const reason = new Error("cancelled running worker");
    const settled = vi.fn();
    const readMessage = vi.fn((message) => message);
    const pending = runInSandboxedWorker("", {}, workerLimits, "timeout", readMessage, {
      signal: controller.signal,
    });
    const outcome = pending.then(settled, (error) => { settled(); return error; });
    controller.abort(reason);
    worker.emit("message", "late result");
    expect(readMessage).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    completeTermination();
    expect(await outcome).toBe(reason);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("normal Worker completion removes the abort listener and timeout", async () => {
    const worker = Object.assign(new EventEmitter(), { terminate: vi.fn().mockResolvedValue(0) });
    factories.worker.mockReturnValue(worker);
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const pending = runInSandboxedWorker("", {}, workerLimits, "timeout", (message) => message, {
      signal: controller.signal,
    });
    worker.emit("message", "ok");
    await expect(pending).resolves.toBe("ok");
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    controller.abort();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("process cancellation kills it and holds settlement until resources close", async () => {
    const child = Object.assign(new EventEmitter(), {
      kill: vi.fn(),
      stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    factories.spawn.mockReturnValue(child);
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const reason = new Error("cancelled running process");
    const settled = vi.fn();
    const pending = runInSandboxedProcess("", "", Buffer.alloc(0), processLimits, "timeout", (value) => value, {
      signal: controller.signal,
    });
    const outcome = pending.then(settled, (error) => { settled(); return error; });
    controller.abort(reason);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    child.emit("close", null);
    expect(await outcome).toBe(reason);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(child.kill).toHaveBeenCalledOnce();
  });
});
