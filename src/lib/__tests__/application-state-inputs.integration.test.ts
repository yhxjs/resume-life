import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let directory: string;
let db: DatabaseSync;
let applicationId: number;
let roundId: number;
const prefix = "resume-life-application-state-inputs-";
const invalidStates: unknown[] = [null, false, true, 0, 1, [], ["applied"], {}, "", "unknown"];

beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("@/lib/db")).getDb();
  const domain = await import("@/lib/applications");
  applicationId = domain.createApplication({ company: "原公司", role: "原岗位", stage: "applied", jd: "投递时 JD", notes: "原备注" }).id;
  roundId = domain.createApplicationInterview(applicationId, {
    round_name: "原轮次", interview_time: "2026-12-01T10:00:00.000Z", notes: "原轮次备注",
  }).id;
});
afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(prefix)) throw new Error("Unsafe cleanup path");
  fs.rmSync(resolved, { recursive: true, force: true });
});
function snapshot() {
  return ["applications", "application_interviews", "application_stage_history"].map(table =>
    db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
  );
}
function request(method: string, body: unknown) {
  return new Request("http://localhost/api/applications", {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}
const context = () => ({ params: Promise.resolve({ id: String(applicationId) }) });
const roundContext = () => ({ params: Promise.resolve({ id: String(applicationId), interviewId: String(roundId) }) });

describe("非法状态必须整组拒绝，不可丢弃状态后保存其他字段", () => {
  it.each(invalidStates.map(value => [value]))("投递 PATCH stage=%j 返回 400，材料、快照和历史不变", async stage => {
    const { PATCH } = await import("@/app/api/applications/[id]/route");
    const before = snapshot();
    const response = await PATCH(request("PATCH", { stage, company: "不能部分保存", jd: "不能替换", notes: "不能保存" }), context());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "投递阶段无效" });
    expect(snapshot()).toEqual(before);
  });
  it.each(invalidStates.map(value => [value]))("轮次 PATCH status=%j 返回 400，不改变排期及备注", async status => {
    const { PATCH } = await import("@/app/api/applications/[id]/interviews/[interviewId]/route");
    const before = snapshot();
    const response = await PATCH(request("PATCH", { status, interview_time: "2026-12-02T10:00:00.000Z", notes: "不能部分保存" }), roundContext());
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "面试轮次状态无效" });
    expect(snapshot()).toEqual(before);
  });
  it.each(invalidStates.map(value => [value]))("领域更新也拒绝非法状态 %j，并使用输入错误类型", async value => {
    const domain = await import("@/lib/applications");
    const before = snapshot();
    const applicationInput = { stage: value, company: "不能部分保存", jd: "不能替换" } as Parameters<typeof domain.updateApplication>[1];
    expect(() => domain.updateApplication(applicationId, applicationInput)).toThrow(domain.ApplicationInputError);
    expect(snapshot()).toEqual(before);
    const roundInput = { status: value, interview_time: "2026-12-02T10:00:00.000Z", notes: "不能部分保存" } as Parameters<typeof domain.updateApplicationInterview>[1];
    expect(() => domain.updateApplicationInterview(roundId, roundInput)).toThrow(domain.ApplicationInputError);
    expect(snapshot()).toEqual(before);
  });
  it.each(invalidStates.filter(value => value !== null && value !== "").map(value => [value]))("领域创建也拒绝错误类型或未知状态 %j，不写入记录", async value => {
    const domain = await import("@/lib/applications");
    const before = snapshot();
    expect(() => domain.createApplication({ company: "不能创建", role: "岗位", stage: value } as Parameters<typeof domain.createApplication>[0])).toThrow(domain.ApplicationInputError);
    expect(() => domain.createApplicationInterview(applicationId, { round_name: "不能创建", status: value } as Parameters<typeof domain.createApplicationInterview>[1])).toThrow(domain.ApplicationInputError);
    expect(snapshot()).toEqual(before);
  });
});

describe("合法状态与创建默认兼容", () => {
  it.each([undefined, null, ""])("POST stage/status=%j 保留默认阶段与待面试状态", async value => {
    const applications = await import("@/app/api/applications/route");
    const rounds = await import("@/app/api/applications/[id]/interviews/route");
    const created = await applications.POST(request("POST", { company: "新公司", role: "新岗位", stage: value }));
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ stage: "interested", flow_status: "active" });
    const round = await rounds.POST(request("POST", { round_name: "新轮次", status: value }), context());
    expect(round.status).toBe(201);
    expect(await round.json()).toMatchObject({ status: "scheduled" });
    const domain = await import("@/lib/applications");
    expect(domain.createApplication({ company: "领域默认", role: "岗位", stage: value } as Parameters<typeof domain.createApplication>[0]))
      .toMatchObject({ stage: "interested", flow_status: "active" });
    expect(domain.createApplicationInterview(applicationId, { round_name: "领域默认", status: value } as Parameters<typeof domain.createApplicationInterview>[1]))
      .toMatchObject({ status: "scheduled" });
  });
  it("PATCH 省略状态保留当前值，仍可正常保存材料和排期", async () => {
    const applications = await import("@/app/api/applications/[id]/route");
    const rounds = await import("@/app/api/applications/[id]/interviews/[interviewId]/route");
    const updated = await applications.PATCH(request("PATCH", { notes: "已更新备注" }), context());
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ stage: "applied", notes: "已更新备注" });
    const round = await rounds.PATCH(request("PATCH", { interview_time: "2026-12-02T10:00:00.000Z" }), roundContext());
    expect(round.status).toBe(200);
    expect(await round.json()).toMatchObject({ status: "scheduled", interview_time: "2026-12-02T10:00:00.000Z" });
    expect((await import("@/lib/applications")).getApplicationById(applicationId)).toMatchObject({ stage: "applied", next_interview_at: "2026-12-02T10:00:00.000Z" });
  });
  it("所有合法阶段、终止归因、重新开启和轮次排期同步均可用", async () => {
    const domain = await import("@/lib/applications");
    const applications = await import("@/app/api/applications/[id]/route");
    const rounds = await import("@/app/api/applications/[id]/interviews/[interviewId]/route");
    for (const stage of domain.APPLICATION_STAGES) {
      const body = stage === "rejected" ? { stage, terminal_stage: "technical_interview", terminal_reason: "不匹配" } : { stage };
      const response = await applications.PATCH(request("PATCH", body), context());
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ stage });
    }
    const reopened = await applications.PATCH(request("PATCH", { stage: "applied" }), context());
    expect(reopened.status).toBe(200);
    expect(await reopened.json()).toMatchObject({ stage: "applied", flow_status: "active", terminal_stage: null, terminal_reason: "" });
    for (const status of domain.INTERVIEW_ROUND_STATUSES) {
      const response = await rounds.PATCH(request("PATCH", { status }), roundContext());
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ status });
      expect(domain.getApplicationById(applicationId)?.next_interview_at).toBe(status === "scheduled" ? "2026-12-01T10:00:00.000Z" : "");
    }
    expect(domain.getApplicationVersions(applicationId)).toMatchObject({ submitted: { jd: "投递时 JD" } });
  });
});
