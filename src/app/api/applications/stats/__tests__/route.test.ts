import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readApplicationStats } from "@/lib/application-stats";

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
  it("读取时选最近的未来 scheduled 轮次，不因缓存排期过期漏报，也不写回投递", async () => {
    const { createApplication, createApplicationInterview, getApplicationStats, getApplicationById } = await import("@/lib/applications");
    vi.useFakeTimers();
    const start = Date.now();
    const app = createApplication({ company: "跨时刻多轮", role: "开发", stage: "interview" });
    const first = new Date(start + 20 * 60_000).toISOString(), second = new Date(start + 120 * 60_000).toISOString();
    createApplicationInterview(app.id, { round_name: "一面", interview_time: first });
    createApplicationInterview(app.id, { round_name: "二面", interview_time: second });
    const before = getApplicationById(app.id);
    vi.setSystemTime(start + 30 * 60_000);
    try {
      const data = getApplicationStats();
      expect(data.upcomingInterviews).toHaveLength(1);
      expect(data.upcomingInterviews[0]).toMatchObject({ id: app.id, next_interview_at: second });
      expect(data.upcomingInterviews[0]!.interviews).toHaveLength(2);
      expect(readApplicationStats(data)).toEqual(data);
      expect(getApplicationById(app.id)).toEqual(before);
    } finally { vi.useRealTimers(); }
  });
  it("按实际时刻处理跨时区的上下界、多轮先后与旧排期，返回时间原文", async () => {
    const { createApplication, createApplicationInterview, getApplicationStats, getApplicationById } = await import("@/lib/applications");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-18T00:00:00Z"));
    try {
      const add = (company: string, time = "") => createApplication({ company, role: "开发", stage: "interview", next_interview_at: time });
      const middle = add("多轮");
      for (const time of ["2026-11-18T00:45:00-04:00", "2026-11-18T08:20:00+08:00", "2026-11-18T07:59:59+08:00"]) {
        createApplicationInterview(middle.id, { round_name: "面试", interview_time: time });
      }
      const first = add("窗口起点", "2026-11-17T19:00:00-05:00");
      const last = add("窗口终点", "2026-11-25T08:00:00+08:00");
      const nearEnd = add("临近终点");
      createApplicationInterview(nearEnd.id, { round_name: "终面", interview_time: "2026-11-25T07:30:00+08:00" });
      add("已超出", "2026-11-24T19:00:01-05:00");
      expect(getApplicationStats().upcomingInterviews.map(app => [app.id, app.next_interview_at])).toEqual([
        [first.id, "2026-11-17T19:00:00-05:00"], [middle.id, "2026-11-18T08:20:00+08:00"],
        [nearEnd.id, "2026-11-25T07:30:00+08:00"], [last.id, "2026-11-25T08:00:00+08:00"],
      ]);
      expect(getApplicationById(middle.id)?.next_interview_at).toBe("2026-11-18T08:20:00+08:00");
    } finally { vi.useRealTimers(); }
  });

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
    expect(readApplicationStats(data)).toEqual(data);
  });

  it("同一家公司的多条记录按投递计数，批次与 Offer 分母保持一致", async () => {
    seedApplication("interested");
    seedApplication("applied");
    seedApplication("offer", "第一批");

    const route = await import("../route");
    const res = await route.GET(request());
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      counts: Record<string, number>;
      totalActive: number;
      funnel: { totalApplications: number; totalCompleted: number; totalOffers: number; winRate: number; overallYieldRate: number };
      batchStats: { batchName: string; totalApplications: number; totalOffers: number }[];
    };
    expect(data.counts.interested).toBe(1);
    expect(data.counts.applied).toBe(1);
    expect(data.counts.offer).toBe(1);
    // totalActive = 总数 - (offer + rejected)：offer 属于已完结，不算在办
    expect(data.totalActive).toBe(2);
    expect(data.funnel.totalOffers).toBe(1);
    expect(data.funnel).toMatchObject({ totalApplications: 3, totalCompleted: 1, winRate: 100, overallYieldRate: 33 });
    expect(data.batchStats).toEqual(expect.arrayContaining([
      expect.objectContaining({ batchName: "", totalApplications: 2, totalOffers: 0 }),
      expect.objectContaining({ batchName: "第一批", totalApplications: 1, totalOffers: 1 }),
    ]));
    expect(readApplicationStats(data)).toEqual(data);
  });

  it("真实履历推进、终止重开和旧日程快照均通过整份读取校验", async () => {
    const { createApplication, updateApplication, getApplicationStats } = await import("@/lib/applications");
    const a = createApplication({ company: "同公司", role: "开发", batch_name: "A" });
    const b = createApplication({ company: "同公司", role: "测试", stage: "applied", batch_name: "B" });
    const verify = () => { const data = getApplicationStats(); expect(readApplicationStats(data)).toEqual(data); };
    verify();
    updateApplication(a.id, { stage: "applied" }); verify();
    updateApplication(a.id, { stage: "interview", hiring_stage: "technical_interview" }); verify();
    updateApplication(a.id, { hiring_stage: "hr_interview" }); verify();
    updateApplication(b.id, { stage: "rejected", terminal_stage: "resume_screening", terminal_reason: "原始 <T> 原因" }); verify();
    updateApplication(a.id, { stage: "offer" }); verify();
    updateApplication(b.id, { stage: "applied" }); verify();
    // 日程 API 仍可返回 Offer 的历史排期，不能按 totalActive 限制其数量。
    const upcoming = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    db!.prepare("UPDATE applications SET next_interview_at = ? WHERE id = ?").run(upcoming, a.id);
    const route = await import("../route");
    const data = await (await route.GET(request())).json();
    expect(data.upcomingInterviews).toHaveLength(1);
    expect(readApplicationStats(data)).toEqual(data);
  });
});
