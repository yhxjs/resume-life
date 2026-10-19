import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-budgets-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", path.join(root, "data"));
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.resetModules();
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith("resume-life-budgets-")) {
    throw new Error("Unsafe cleanup path");
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("shared process budgets", () => {
  it("keeps a backup slot occupied while failed cleanup renews its lease", async () => {
    const budget = await import("../shared-budgets");
    const token = budget.acquireBackupLease({ now: 1_000, maxConcurrent: 1, leaseMs: 100 });
    expect(token).not.toBeNull();
    budget.renewBackupLease(token!, { now: 1_050, leaseMs: 100 });
    expect(budget.acquireBackupLease({ now: 1_101, maxConcurrent: 1, leaseMs: 100 })).toBeNull();
    expect(budget.acquireBackupLease({ now: 1_151, maxConcurrent: 1, leaseMs: 100 })).not.toBeNull();
  });
  it("shares backup admission across module instances independently of LLM and reclaims expiry", async () => {
    const first = await import("../shared-budgets");
    const token = first.acquireBackupLease({ now: 1_000, maxConcurrent: 1, leaseMs: 100 });
    expect(token).not.toBeNull();
    vi.resetModules();
    const second = await import("../shared-budgets");
    expect(second.acquireBackupLease({ now: 1_001, maxConcurrent: 1, leaseMs: 100 })).toBeNull();
    const llm = second.acquireLlmLease({ now: 1_001, maxConcurrent: 1, leaseMs: 100 });
    expect(llm).not.toBeNull();
    if (token) second.releaseBackupLease(token);
    expect(second.acquireBackupLease({ now: 1_002, maxConcurrent: 1, leaseMs: 100 })).not.toBeNull();
    expect(second.acquireBackupLease({ now: 1_103, maxConcurrent: 1, leaseMs: 100 })).not.toBeNull();
    if (llm) second.releaseLlmLease(llm);
  });
  it("uses a private temporary directory without chmodding the shared root and cleans it on exit", async () => {
    vi.stubEnv("RESUME_LIFE_DATA_DIR", "");
    vi.spyOn(os, "tmpdir").mockReturnValue(root);
    // Exercise the POSIX branch safely: no chmod call may reach the real filesystem.
    const chmod = vi.spyOn(fs, "chmodSync").mockImplementation(() => {});
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    const exitListeners = new Set(process.listeners("exit"));
    try {
      const first = await import("../shared-budgets");
      const token = first.acquireLlmLease({ now: 1_000, maxConcurrent: 1, leaseMs: 10_000 });
      expect(token).not.toBeNull();
      const directories = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
      expect(directories).toHaveLength(1);
      const directory = path.join(root, directories[0]!.name);
      expect(fs.existsSync(path.join(directory, "process-budgets.db"))).toBe(true);
      expect(chmod).toHaveBeenCalledWith(directory, 0o700);
      expect(chmod.mock.calls.some(([target]) => target === root)).toBe(false);

      vi.resetModules();
      const second = await import("../shared-budgets");
      expect(second.acquireLlmLease({ now: 1_001, maxConcurrent: 1, leaseMs: 10_000 })).toBeNull();
      if (token) second.releaseLlmLease(token);
      const cleanup = process.listeners("exit").filter((listener) => !exitListeners.has(listener));
      expect(cleanup).toHaveLength(1);
      cleanup[0]!(0);
      process.removeListener("exit", cleanup[0]!);
      expect(fs.existsSync(directory)).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", platform);
      for (const listener of process.listeners("exit")) {
        if (!exitListeners.has(listener)) {
          listener(0);
          process.removeListener("exit", listener);
        }
      }
    }
  });

  it("persists authentication failures and active leases across module instances", async () => {
    const first = await import("../shared-budgets");
    const firstLease = first.acquireAuthPasswordCheck({ now: 1_000, windowMs: 60_000, maxFailures: 5, maxActive: 2, leaseMs: 10_000 });
    expect(firstLease.kind).toBe("acquired");
    if (firstLease.kind !== "acquired") return;

    vi.resetModules();
    const second = await import("../shared-budgets");
    const secondLease = second.acquireAuthPasswordCheck({ now: 1_001, windowMs: 60_000, maxFailures: 5, maxActive: 2, leaseMs: 10_000 });
    expect(secondLease.kind).toBe("acquired");
    expect(second.acquireAuthPasswordCheck({ now: 1_002, windowMs: 60_000, maxFailures: 5, maxActive: 2, leaseMs: 10_000 }).kind).toBe("busy");

    if (secondLease.kind === "acquired") second.completeAuthPasswordCheck(secondLease.token, false);
    first.completeAuthPasswordCheck(firstLease.token, true);
    expect(second.acquireAuthPasswordCheck({ now: 1_003, windowMs: 60_000, maxFailures: 5, maxActive: 2, leaseMs: 10_000 }).kind).toBe("acquired");
  });

  it("shares the LLM concurrency lease and reclaims expired leases", async () => {
    const budget = await import("../shared-budgets");
    const lease = budget.acquireLlmLease({ now: 1_000, maxConcurrent: 1, leaseMs: 100 });
    expect(lease).not.toBeNull();
    expect(budget.acquireLlmLease({ now: 1_001, maxConcurrent: 1, leaseMs: 100 })).toBeNull();
    expect(budget.acquireLlmLease({ now: 1_101, maxConcurrent: 1, leaseMs: 100 })).not.toBeNull();
    if (lease) budget.releaseLlmLease(lease);
  });

  it("creates the sidecar with private POSIX permissions", async () => {
    const budget = await import("../shared-budgets");
    const token = budget.acquireLlmLease({ maxConcurrent: 1, leaseMs: 100 });
    expect(token).not.toBeNull();
    if (process.platform === "win32") return;
    const database = fs.statSync(path.join(root, "data", "process-budgets.db"));
    expect(database.mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(root, "data")).mode & 0o777).toBe(0o700);
    if (token) budget.releaseLlmLease(token);
  });
});
