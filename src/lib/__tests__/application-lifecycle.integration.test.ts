import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tempDir: string;
let db: DatabaseSync;

beforeEach(async () => {
  vi.resetModules();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-application-lifecycle-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", path.join(tempDir, "data"));
  db = (await import("@/lib/db")).getDb();
});

afterEach(() => {
  vi.useRealTimers();
  db?.close();
  vi.unstubAllEnvs();
  if (path.dirname(tempDir) !== os.tmpdir() || !path.basename(tempDir).startsWith("resume-life-application-lifecycle-")) {
    throw new Error("Unsafe cleanup path");
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const request = (method: string, body: unknown) =>
  new Request("http://127.0.0.1/api/applications", {
    method,
    headers: { "content-type": "application/json", origin: "http://127.0.0.1", host: "127.0.0.1" },
    body: JSON.stringify(body),
  });

const idContext = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

describe("application lifecycle tracking", () => {
  it("记录真实变更时间；备注、批次更新及重复阶段保存不产生虚假履历", async () => {
    const { createApplication, updateApplication } = await import("@/lib/applications");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-01T00:00:00Z"));
    const app = createApplication({ company: "时钟", role: "工程师" });
    vi.setSystemTime(new Date("2026-09-02T00:00:00Z"));
    const moved = updateApplication(app.id, { stage: "applied" });
    expect(moved.stage_changed_at).toBe("2026-09-02T00:00:00.000Z");
    vi.setSystemTime(new Date("2026-09-03T00:00:00Z"));
    const edited = updateApplication(app.id, { notes: "等待回复", stage: "applied" });
    expect(edited.stage_changed_at).toBe(moved.stage_changed_at);
    expect(edited.stage_history).toHaveLength(2);
    vi.setSystemTime(new Date("2026-09-04T00:00:00Z"));
    const regrouped = updateApplication(app.id, { batch_name: " 春招 " });
    expect(regrouped.batch_name).toBe("春招");
    expect(regrouped.updated_at).toBe("2026-09-04T00:00:00.000Z");
    expect(regrouped.stage_changed_at).toBe(moved.stage_changed_at);
    expect(regrouped.stage_history).toHaveLength(2);
  });

  it("终止后重开清空当前终止字段，但保留此前时间、阶段与原因", async () => {
    const { createApplication, updateApplication, getApplicationStats } = await import("@/lib/applications");
    const app = createApplication({ company: "重开", role: "工程师", stage: "interview", hiring_stage: "technical_interview" });
    const closed = updateApplication(app.id, { stage: "rejected", terminal_stage: "technical_interview", terminal_reason: "HC 取消" });
    expect(closed.terminal_at).toBeTruthy();
    const reopened = updateApplication(app.id, { stage: "interview" });
    expect(reopened).toMatchObject({ flow_status: "active", terminal_stage: null, terminal_reason: "", terminal_at: "" });
    expect(reopened.stage_history).toHaveLength(3);
    expect(reopened.stage_history![1]).toMatchObject({ reason: "HC 取消", terminal_stage: "technical_interview" });
    expect(getApplicationStats().funnel!.hiringSteps[1]).toMatchObject({ active: 1, terminated: 0 });
    expect(updateApplication(app.id, { stage: "offer" }).flow_status).toBe("passed");
  });

  it("同一看板阶段可从技术面推进 HR 面，明确记录招聘环节时间", async () => {
    const { createApplication, updateApplication, getApplicationStats } = await import("@/lib/applications");
    const app = createApplication({ company: "环节", role: "工程师", stage: "interview", hiring_stage: "technical_interview" });
    const moved = updateApplication(app.id, { hiring_stage: "hr_interview" });
    expect(moved.stage_history![1]).toMatchObject({ from_stage: "interview", to_stage: "interview", from_hiring_stage: "technical_interview", to_hiring_stage: "hr_interview" });
    const steps = getApplicationStats().funnel!.hiringSteps;
    expect(steps[1]).toMatchObject({ active: 0, passed: 1 });
    expect(steps[2]).toMatchObject({ active: 1, passed: 0 });
  });

  it("履历写入失败时阶段更新与投递快照均回滚", async () => {
    const { createApplication, updateApplication, getApplicationById } = await import("@/lib/applications");
    const app = createApplication({ company: "回滚", role: "工程师" });
    db.exec("CREATE TRIGGER fail_history BEFORE INSERT ON application_stage_history BEGIN SELECT RAISE(ABORT, 'history unavailable'); END");
    expect(() => updateApplication(app.id, { stage: "applied" })).toThrow("history unavailable");
    expect(getApplicationById(app.id)).toMatchObject({ stage: "interested", submitted_at: null, stage_changed_at: app.stage_changed_at });
    expect(getApplicationById(app.id)!.stage_history).toHaveLength(1);
  });

  it("统计包含第 51 份以后的投递，按批次隔离结果", async () => {
    const { createApplication, getApplicationStats, listApplications } = await import("@/lib/applications");
    for (let i = 0; i < 53; i++) createApplication({ company: `春招 ${i}`, role: "工程师", stage: "applied", batch_name: "春招" });
    createApplication({ company: "秋招 Offer", role: "工程师", stage: "offer", batch_name: "秋招" });
    expect(listApplications().items).toHaveLength(50);
    const stats = getApplicationStats();
    expect(stats.funnel!.totalApplications).toBe(54);
    expect(stats.batchStats!.find(b => b.batchName === "春招")).toMatchObject({ totalActive: 53, totalRejected: 0, totalOffers: 0 });
    expect(stats.batchStats!.find(b => b.batchName === "秋招")).toMatchObject({ totalActive: 0, totalOffers: 1 });
  });

  it.each([{ batch_name: 23 }, { hiring_stage: "HR" }, { terminal_stage: "interview" }, { terminal_reason: null },
    { stage: "rejected", terminal_stage: "hr_interview", terminal_reason: "  " }])("新增字段拒绝非法输入且不改动记录：%j", async body => {
    const { createApplication, getApplicationById } = await import("@/lib/applications");
    const app = createApplication({ company: "校验", role: "工程师" });
    const route = await import("@/app/api/applications/[id]/route");
    const result = await route.PATCH(request("PATCH", body), idContext(app.id));
    expect(result.status).toBe(400);
    expect(getApplicationById(app.id)).toEqual(app);
  });

  it("终止记录更新始终校验归因，失败时不写入备注", async () => {
    const { createApplication, updateApplication, getApplicationById } = await import("@/lib/applications");
    const app = createApplication({ company: "校验", role: "工程师", stage: "rejected", terminal_stage: "hr_interview", terminal_reason: "岗位关闭" });
    db.prepare("UPDATE applications SET terminal_stage = NULL WHERE id = ?").run(app.id);
    expect(() => updateApplication(app.id, { notes: "不应保存" })).toThrow("请选择终止阶段");
    expect(getApplicationById(app.id)!.notes).toBe("");
    db.prepare("UPDATE applications SET terminal_stage = 'hr_interview', terminal_reason = '' WHERE id = ?").run(app.id);
    expect(() => updateApplication(app.id, { notes: "不应保存" })).toThrow("请填写终止原因");
    expect(getApplicationById(app.id)!.notes).toBe("");
  });

  it("creates a batch-tagged application with an initial stage history entry", async () => {
    const route = await import("@/app/api/applications/route");
    const res = await route.POST(request("POST", {
      company: "甲公司",
      role: "前端工程师",
      stage: "applied",
      batch_name: "春招海投",
    }));

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({
      batch_name: "春招海投",
      stage: "applied",
      flow_status: "active",
      terminal_stage: null,
      terminal_reason: "",
    });

    const history = db.prepare(
      "SELECT from_stage, to_stage, reason FROM application_stage_history WHERE application_id = ?",
    ).all(body.id);
    expect(history).toEqual([{ from_stage: null, to_stage: "applied", reason: "" }]);
  });

  it("requires a termination stage and reason, then records both in the history", async () => {
    const applications = await import("@/lib/applications");
    const app = applications.createApplication({ company: "乙公司", role: "后端工程师", stage: "interview" });
    const route = await import("@/app/api/applications/[id]/route");

    const missing = await route.PATCH(request("PATCH", { stage: "rejected" }), idContext(app.id));
    expect(missing.status).toBe(400);

    const terminated = await route.PATCH(request("PATCH", {
      stage: "rejected",
      terminal_stage: "technical_interview",
      terminal_reason: "技术面未通过",
    }), idContext(app.id));
    expect(terminated.status).toBe(200);
    expect(await terminated.json()).toMatchObject({
      flow_status: "terminated",
      terminal_stage: "technical_interview",
      terminal_reason: "技术面未通过",
    });

    const history = db.prepare(
      "SELECT from_stage, to_stage, reason FROM application_stage_history WHERE application_id = ? ORDER BY id",
    ).all(app.id);
    expect(history).toEqual([
      { from_stage: null, to_stage: "interview", reason: "" },
      { from_stage: "interview", to_stage: "rejected", reason: "技术面未通过" },
    ]);
  });
});
