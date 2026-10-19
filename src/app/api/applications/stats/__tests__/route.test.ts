import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMP_PREFIX = "resume-life-applications-stats-route-test-";

let tempDir: string;
let db: DatabaseSync | undefined;

beforeEach(async () => {
  vi.resetModules();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", path.join(tempDir, "data"));
  db = (await import("@/lib/db")).getDb();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  // Windows 上删除仍被 SQLite 持有的文件会 EPERM，必须先关句柄
  db?.close();
  db = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  const resolved = path.resolve(tempDir);
  if (
    path.dirname(resolved) !== path.resolve(os.tmpdir())
    || !path.basename(resolved).startsWith(TEMP_PREFIX)
  ) {
    throw new Error(`Unsafe cleanup path: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
});

const request = () =>
  new Request("http://127.0.0.1/api/applications/stats", {
    method: "GET",
    headers: { origin: "http://127.0.0.1", host: "127.0.0.1" },
  });

const seedApplication = (stage: string, batchName = ""): void => {
  const ts = "2026-01-01T00:00:00.000Z";
  db?.prepare(
    "INSERT INTO applications (company, role, stage, created_at, updated_at, batch_name) VALUES (?, ?, ?, ?, ?, ?)"
  ).run("某公司", "前端工程师", stage, ts, ts, batchName);
};

describe("GET /api/applications/stats 投递统计", () => {
  it("空库返回全零统计结构", async () => {
    const route = await import("../route");
    const res = await route.GET(request());
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      counts: Record<string, number>;
      totalActive: number;
      funnel: { steps: unknown[] };
      rates: { appliedRate: number; interviewRate: number; offerRate: number };
    };
    expect(data.counts.interested).toBe(0);
    expect(data.totalActive).toBe(0);
    expect(data.funnel.steps.length).toBeGreaterThan(0);
    expect(data.rates.appliedRate).toBe(0);
  });

  it("有投递记录时按阶段计数", async () => {
    seedApplication("interested");
    seedApplication("applied");
    seedApplication("offer", "第一批");

    const route = await import("../route");
    const res = await route.GET(request());
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      counts: Record<string, number>;
      totalActive: number;
      funnel: { totalOffers: number };
    };
    expect(data.counts.interested).toBe(1);
    expect(data.counts.applied).toBe(1);
    expect(data.counts.offer).toBe(1);
    // totalActive = 总数 - (offer + rejected)：offer 属于已完结，不算在办
    expect(data.totalActive).toBe(2);
    expect(data.funnel.totalOffers).toBe(1);
  });
});
