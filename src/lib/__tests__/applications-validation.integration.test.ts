import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tempDir: string;
let db: DatabaseSync;

// 沿用 notebook-pagination.integration.test.ts 的隔离范式：
// vi.resetModules + vi.stubEnv 必须在 import 数据层之前生效，故路由模块在用例内动态导入。
beforeEach(async () => {
  vi.resetModules();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-applications-validation-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", path.join(tempDir, "data"));
  db = (await import("@/lib/db")).getDb();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (path.dirname(tempDir) !== os.tmpdir() || !path.basename(tempDir).startsWith("resume-life-applications-validation-")) {
    throw new Error("Unsafe cleanup path");
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const jsonRequest = (method: string, body: unknown) =>
  new Request("http://127.0.0.1/api/applications", {
    method,
    headers: { "content-type": "application/json", origin: "http://127.0.0.1", host: "127.0.0.1" },
    body: JSON.stringify(body),
  });

const idContext = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

async function createOne(): Promise<number> {
  const route = await import("@/app/api/applications/route");
  const res = await route.POST(jsonRequest("POST", { company: "A", role: "B" }));
  return (await res.json()).id as number;
}

describe("applications 入参校验", () => {
  it.each([0.5, -1, Number.MAX_SAFE_INTEGER + 1, null, "15"])("轮次 POST 拒绝非法提醒值 %j 且不写库", async (reminder) => {
    const id = await createOne();
    const route = await import("@/app/api/applications/[id]/interviews/route");
    const before = db.prepare("SELECT * FROM applications WHERE id = ?").get(id);
    const res = await route.POST(jsonRequest("POST", { round_name: "一面", reminder_minutes: reminder }), idContext(id));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("提醒");
    expect(db.prepare("SELECT COUNT(*) AS count FROM application_interviews").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT * FROM applications WHERE id = ?").get(id)).toEqual(before);
  });

  it.each([0.5, -1, Number.MAX_SAFE_INTEGER + 1, null, "15"])("轮次 PATCH 拒绝非法提醒值 %j 且保留旧值", async (reminder) => {
    const id = await createOne();
    const { createApplicationInterview } = await import("@/lib/applications");
    const round = createApplicationInterview(id, { round_name: "一面", interview_time: "", reminder_minutes: 15 });
    const route = await import("@/app/api/applications/[id]/interviews/[interviewId]/route");
    const before = db.prepare("SELECT * FROM application_interviews WHERE id = ?").get(round.id);
    const res = await route.PATCH(jsonRequest("PATCH", { reminder_minutes: reminder }), {
      params: Promise.resolve({ id: String(id), interviewId: String(round.id) }),
    });
    expect(res.status).toBe(400);
    expect(db.prepare("SELECT * FROM application_interviews WHERE id = ?").get(round.id)).toEqual(before);
  });

  it("领域入口自身拒绝非整数，合法提醒值以 INTEGER 保存", async () => {
    const id = await createOne();
    const domain = await import("@/lib/applications");
    expect(() => domain.createApplicationInterview(id, { round_name: "一面", interview_time: "", reminder_minutes: 0.5 })).toThrow(domain.ApplicationInputError);
    for (const reminder of [0, 15, Number.MAX_SAFE_INTEGER]) {
      const round = domain.createApplicationInterview(id, { round_name: "一面", interview_time: "", reminder_minutes: reminder });
      expect(db.prepare("SELECT reminder_minutes, typeof(reminder_minutes) AS type FROM application_interviews WHERE id = ?").get(round.id))
        .toEqual({ reminder_minutes: reminder, type: "integer" });
      expect(() => domain.updateApplicationInterview(round.id, { reminder_minutes: 0.5 })).toThrow(domain.ApplicationInputError);
    }
  });

  it("创建轮次并推进阶段时，后一步失败必须整体回滚", async () => {
    const id = await createOne();
    const before = db.prepare("SELECT * FROM applications WHERE id = ?").get(id);
    const historyBefore = db.prepare("SELECT * FROM application_stage_history WHERE application_id = ?").all(id);
    db.exec("CREATE TRIGGER fail_stage BEFORE UPDATE OF stage ON applications WHEN NEW.stage != OLD.stage BEGIN SELECT RAISE(ABORT, 'injected stage failure'); END");
    const route = await import("@/app/api/applications/[id]/interviews/route");
    const res = await route.POST(jsonRequest("POST", {
      round_name: "一面", interview_time: "2026-12-01T10:00:00.000Z", advance_stage: true,
    }), idContext(id));
    expect(res.status).toBe(500);
    expect(db.prepare("SELECT COUNT(*) AS count FROM application_interviews").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT * FROM applications WHERE id = ?").get(id)).toEqual(before);
    expect(db.prepare("SELECT * FROM application_stage_history WHERE application_id = ?").all(id)).toEqual(historyBefore);
  });

  it("创建轮次并推进阶段成功时，轮次、阶段和下次时间一致", async () => {
    const id = await createOne();
    const route = await import("@/app/api/applications/[id]/interviews/route");
    const time = "2026-12-01T10:00:00.000Z";
    const res = await route.POST(jsonRequest("POST", { round_name: "一面", interview_time: time, advance_stage: true }), idContext(id));
    expect(res.status).toBe(201);
    expect(db.prepare("SELECT stage,next_interview_at FROM applications WHERE id = ?").get(id)).toEqual({ stage: "interview", next_interview_at: time });
    expect(db.prepare("SELECT COUNT(*) AS count FROM application_interviews WHERE application_id = ?").get(id)).toEqual({ count: 1 });
  });

  it("POST 拒绝非整数的关联 ID（400，而非持久层 TypeError）", async () => {
    const route = await import("@/app/api/applications/route");
    const res = await route.POST(jsonRequest("POST", { company: "A", role: "B", resume_id: "12a" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("ID");
  });

  it("POST 拒绝非法 stage（400，不落到 DB CHECK）", async () => {
    const route = await import("@/app/api/applications/route");
    const res = await route.POST(jsonRequest("POST", { company: "A", role: "B", stage: "hacked" }));
    expect(res.status).toBe(400);
  });

  it("POST 接受合法 stage", async () => {
    const route = await import("@/app/api/applications/route");
    const res = await route.POST(jsonRequest("POST", { company: "A", role: "B", stage: "applied" }));
    expect(res.status).toBe(201);
  });

  it("PATCH 拒绝非整数的关联 ID", async () => {
    const id = await createOne();
    const route = await import("@/app/api/applications/[id]/route");
    const res = await route.PATCH(jsonRequest("PATCH", { interview_id: "abc" }), idContext(id));
    expect(res.status).toBe(400);
  });

  it("PATCH 的持久层异常收敛为 500 + requestId（不再伪装成 400）", async () => {
    const id = await createOne();
    const route = await import("@/app/api/applications/[id]/route");
    // ESM 命名空间导出无法 spyOn，故沿用项目既有手法：spy 原型方法注入故障
    const original = DatabaseSync.prototype.prepare;
    const spy = vi
      .spyOn(DatabaseSync.prototype, "prepare")
      .mockImplementation(function (this: DatabaseSync, sql: string) {
        if (/FROM applications/i.test(sql)) throw new Error("SQLITE_IOERR: disk I/O error");
        return original.call(this, sql);
      });

    const res = await route.PATCH(jsonRequest("PATCH", { notes: "x" }), idContext(id));
    const payload = await res.json();

    expect(res.status).toBe(500);
    expect(payload.requestId).toMatch(/^[A-Za-z0-9._:-]{1,128}$/);
    expect(JSON.stringify(payload)).not.toContain("SQLITE_IOERR");

    spy.mockRestore();
  });
});
