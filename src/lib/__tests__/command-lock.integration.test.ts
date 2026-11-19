import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PREFIX = "resume-life-command-lock-";
let directory: string;
let db: DatabaseSync;
const releases: (() => void)[] = [];

beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
});

afterEach(() => {
  for (const release of releases.splice(0)) release();
  db.close();
  vi.unstubAllEnvs();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith(PREFIX)) {
    throw new Error("Unsafe cleanup path");
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

function generation(value: string) {
  db.prepare("INSERT INTO runtime_state (id,data_generation) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET data_generation=excluded.data_generation")
    .run(value);
}

async function acquire(key: string) {
  const release = (await import("../db")).acquireCommandLock(key);
  if (release) releases.push(release);
  return release;
}

describe("命令锁的数据范围", () => {
  it("同世代重复命令拒绝，不同命令仍可执行，释放后可重试", async () => {
    const first = await acquire("interview-answer:1");
    expect(first).not.toBeNull();
    expect(await acquire("interview-answer:1")).toBeNull();
    expect(await acquire("interview-answer:2")).not.toBeNull();
    expect(await acquire("interview-series:1")).not.toBeNull();
    first!();
    expect(await acquire("interview-answer:1")).not.toBeNull();
  });

  it.each([null, "restored-before"])("从 %s 世代恢复后可执行同名命令，旧释放不能解除新锁", async (initial) => {
    if (initial !== null) generation(initial);
    const old = await acquire("real-interview-review:1");
    expect(old).not.toBeNull();
    generation("restored-current");
    const current = await acquire("real-interview-review:1");
    expect(current).not.toBeNull();
    old!();
    expect(await acquire("real-interview-review:1")).toBeNull();
    current!();
    expect(await acquire("real-interview-review:1")).not.toBeNull();
  });

  it("不同数据目录的同世代、同名命令互不阻塞", async () => {
    expect(await acquire("salary-negotiation:1")).not.toBeNull();
    const otherDirectory = path.join(directory, "other-data");
    vi.stubEnv("RESUME_LIFE_DATA_DIR", otherDirectory);
    vi.resetModules();
    const otherDb = await import("../db");
    const connection = otherDb.getDb();
    try {
      const other = otherDb.acquireCommandLock("salary-negotiation:1");
      if (other) releases.push(other);
      expect(other).not.toBeNull();
      expect(otherDb.acquireCommandLock("salary-negotiation:1")).toBeNull();
    } finally {
      connection.close();
    }
  });
});
