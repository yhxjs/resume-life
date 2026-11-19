import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let directory: string;
let db: DatabaseSync;
let applicationId: number;
let roundId: number;
const prefix = "resume-life-application-material-types-";
const badValues: unknown[] = [null, 0, true, [], ["原文"], {}];
const applicationFields = ["company", "role", "salary_range", "jd", "next_interview_at", "notes"] as const;
const roundFields = ["round_name", "interview_time", "interviewer", "location", "meeting_url", "notes"] as const;

beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("@/lib/db")).getDb();
  const domain = await import("@/lib/applications");
  applicationId = domain.createApplication({ company: "原公司", role: "原岗位", jd: "原 JD <T> &amp;", notes: "原备注", stage: "applied" }).id;
  roundId = domain.createApplicationInterview(applicationId, {
    round_name: "原轮次", interview_time: "2026-12-01T10:00:00.000Z", interviewer: "原面试官",
    location: "原地点", meeting_url: "https://example.com/original", notes: "原轮次备注", reminder_minutes: 15,
  }).id;
  domain.createApplication({ company: "其他公司", role: "其他岗位" });
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

describe("投递材料不能丢弃错误字段后报告保存成功", () => {
  it("领域写入自身拒绝错误材料，不依赖 route 过滤", async () => {
    const domain = await import("@/lib/applications");
    const before = snapshot();
    for (const field of applicationFields) {
      for (const value of badValues) {
        const input = { company: "新公司", role: "新岗位", notes: "不可部分保存", [field]: value } as Parameters<typeof domain.createApplication>[0];
        expect(() => domain.createApplication(input)).toThrow(domain.ApplicationInputError);
        expect(() => domain.updateApplication(applicationId, input)).toThrow(domain.ApplicationInputError);
      }
    }
    expect(snapshot()).toEqual(before);
  });
  it("合法文字保留内部原文，省略可选值沿用默认，PATCH 空串可清空文字", async () => {
    const create = await import("@/app/api/applications/route");
    const update = await import("@/app/api/applications/[id]/route");
    const response = await create.POST(request("POST", { company: "  C++ <T> &amp;  ", role: "  内部  空格  " }));
    expect(response.status).toBe(201);
    const created = await response.json();
    expect(created).toMatchObject({ company: "C++ <T> &amp;", role: "内部  空格", salary_range: "", jd: "", notes: "", next_interview_at: "", stage: "interested" });
    const ctx = { params: Promise.resolve({ id: String(created.id) }) };
    const text = "材料  <T> &amp;\n下一行";
    const changed = await update.PATCH(request("PATCH", { jd: `  ${text}  `, notes: text, salary_range: "  30k  " }), ctx);
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ company: created.company, role: created.role, jd: text, notes: text, salary_range: "30k" });
    const cleared = await update.PATCH(request("PATCH", { jd: "", notes: "  ", salary_range: "", next_interview_at: "" }), ctx);
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ company: created.company, role: created.role, jd: "", notes: "", salary_range: "", next_interview_at: "" });
  });
  it.each(applicationFields.flatMap(field => badValues.map(value => [field, value] as const)))("%s=%j 整组拒绝创建及更新", async (field, value) => {
    const create = await import("@/app/api/applications/route");
    const update = await import("@/app/api/applications/[id]/route");
    const before = snapshot();
    const body = { company: "新公司", role: "新岗位", stage: "interview", notes: "不能部分写入", [field]: value };
    for (const response of [await create.POST(request("POST", body)), await update.PATCH(request("PATCH", body), context())]) {
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: expect.any(String) });
    }
    expect(snapshot()).toEqual(before);
  });
  it.each([null, [], "原语", 1, true].map(value => [value]))("非对象 %j 在四个入口拒绝", async value => {
    const create = await import("@/app/api/applications/route");
    const update = await import("@/app/api/applications/[id]/route");
    const rounds = await import("@/app/api/applications/[id]/interviews/route");
    const round = await import("@/app/api/applications/[id]/interviews/[interviewId]/route");
    const before = snapshot();
    for (const response of [await create.POST(request("POST", value)), await update.PATCH(request("PATCH", value), context()),
      await rounds.POST(request("POST", value), context()), await round.PATCH(request("PATCH", value), roundContext())]) {
      expect(response.status).toBe(400);
    }
    expect(snapshot()).toEqual(before);
  });
});

describe("面试排期材料与阶段推进开关", () => {
  it("领域排期入口拒绝错误文字和推进参数，原存档及阶段历史不变", async () => {
    const domain = await import("@/lib/applications");
    const before = snapshot();
    for (const field of roundFields) {
      for (const value of badValues) {
        const input = { round_name: "新轮次", interview_time: "", notes: "不可部分保存", [field]: value } as Parameters<typeof domain.createApplicationInterview>[1];
        expect(() => domain.createApplicationInterview(applicationId, input)).toThrow(domain.ApplicationInputError);
        expect(() => domain.updateApplicationInterview(roundId, input)).toThrow(domain.ApplicationInputError);
      }
    }
    expect(() => domain.createApplicationInterview(applicationId, { round_name: "新轮次", interview_time: "" }, { advanceStage: "false" as unknown as boolean }))
      .toThrow(domain.ApplicationInputError);
    expect(snapshot()).toEqual(before);
  });
  it("合法排期保留原文、零分钟提醒与缺省状态，空串清空可选字段", async () => {
    const create = await import("@/app/api/applications/[id]/interviews/route");
    const update = await import("@/app/api/applications/[id]/interviews/[interviewId]/route");
    const text = "原文  <T> &amp;\n下一行";
    const response = await create.POST(request("POST", { round_name: "  终面 <T>  ", interviewer: `  ${text}  `,
      location: text, meeting_url: "https://example.com/?q=%26", notes: text, reminder_minutes: 0 }), context());
    expect(response.status).toBe(201);
    const created = await response.json();
    expect(created).toMatchObject({ round_name: "终面 <T>", interview_time: "", interviewer: text, location: text,
      meeting_url: "https://example.com/?q=%26", notes: text, reminder_minutes: 0, status: "scheduled" });
    const cleared = await update.PATCH(request("PATCH", { interviewer: "", location: "  ", meeting_url: "", notes: "" }), {
      params: Promise.resolve({ id: String(applicationId), interviewId: String(created.id) }),
    });
    expect(cleared.status).toBe(200);
    expect(await cleared.json()).toMatchObject({ round_name: created.round_name, interviewer: "", location: "", meeting_url: "", notes: "", reminder_minutes: 0 });
  });
  it.each(roundFields.flatMap(field => badValues.map(value => [field, value] as const)))("%s=%j 不创建轮次或部分更新排期", async (field, value) => {
    const create = await import("@/app/api/applications/[id]/interviews/route");
    const update = await import("@/app/api/applications/[id]/interviews/[interviewId]/route");
    const before = snapshot();
    const body = { round_name: "新轮次", interview_time: "2026-12-02T10:00:00.000Z", notes: "不能部分写入", advance_stage: true, [field]: value };
    for (const response of [await create.POST(request("POST", body), context()), await update.PATCH(request("PATCH", body), roundContext())]) {
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: expect.any(String) });
    }
    expect(snapshot()).toEqual(before);
  });
  it.each(["false", "true", 0, 1, null, [], {}].map(value => [value]))("推进阶段 %j 须为布尔值", async value => {
    const { POST } = await import("@/app/api/applications/[id]/interviews/route");
    const before = snapshot();
    const response = await POST(request("POST", { round_name: "新轮次", advance_stage: value }), context());
    expect(response.status).toBe(400);
    expect(snapshot()).toEqual(before);
  });
  it.each([undefined, false, true])("合法推进阶段 %j 保留实际开关语义", async advanceStage => {
    const { POST } = await import("@/app/api/applications/[id]/interviews/route");
    const response = await POST(request("POST", { round_name: "新轮次", advance_stage: advanceStage }), context());
    expect(response.status).toBe(201);
    expect(db.prepare("SELECT stage FROM applications WHERE id = ?").get(applicationId)).toEqual({ stage: advanceStage ? "interview" : "applied" });
  });
});
