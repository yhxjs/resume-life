import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tempDir: string;
let db: DatabaseSync;

beforeEach(async () => {
  vi.resetModules();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-app-interviews-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", path.join(tempDir, "data"));
  db = (await import("@/lib/db")).getDb();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (
    path.dirname(tempDir) !== os.tmpdir() ||
    !path.basename(tempDir).startsWith("resume-life-app-interviews-")
  ) {
    throw new Error("Unsafe cleanup path");
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

const jsonRequest = (url: string, method: string, body?: unknown) =>
  new Request(url, {
    method,
    headers: {
      "content-type": "application/json",
      origin: "http://127.0.0.1",
      host: "127.0.0.1",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

describe("求职看板面试阶段与独立子表 application_interviews", () => {
  it("支持创建 stage 为 interview（面试中）的投递记录", async () => {
    const { createApplication, getApplicationById } = await import("@/lib/applications");
    const app = createApplication({
      company: "字节跳动",
      role: "前端研发工程师",
      stage: "interview",
    });

    expect(app.stage).toBe("interview");
    const fetched = getApplicationById(app.id);
    expect(fetched?.stage).toBe("interview");
  });

  it("支持为投递创建多轮面试，并自动同步 next_interview_at", async () => {
    const {
      createApplication,
      createApplicationInterview,
      listApplicationInterviews,
      getApplicationById,
    } = await import("@/lib/applications");

    const app = createApplication({
      company: "阿里巴巴",
      role: "资深技术专家",
      stage: "interviewing",
    });

    // 登记一面：时间在明天
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const round1 = createApplicationInterview(app.id, {
      round_name: "一面（技术初试）",
      interview_time: tomorrow,
      status: "scheduled",
      interviewer: "张老师 · 腾讯会议",
      notes: "重点考察工程架构与前端性能优化",
    });

    expect(round1.id).toBeGreaterThan(0);
    expect(round1.status).toBe("scheduled");

    // 检查主表 next_interview_at 是否自动联动同步
    const appAfterRound1 = getApplicationById(app.id);
    expect(appAfterRound1?.next_interview_at).toBe(tomorrow);
    expect(appAfterRound1?.latest_round).toBe("一面（技术初试）");
    expect(appAfterRound1?.interview_rounds_count).toBe(1);

    // 登记二面：时间在 3 天后
    const in3Days = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    const round2 = createApplicationInterview(app.id, {
      round_name: "二面（总监复试）",
      interview_time: in3Days,
      status: "scheduled",
    });

    const rounds = listApplicationInterviews(app.id);
    expect(rounds.length).toBe(2);
    expect(rounds[0]!.round_name).toBe("一面（技术初试）");
    expect(rounds[1]!.round_name).toBe("二面（总监复试）");
    expect(rounds[1]!.id).toBe(round2.id);

    // next_interview_at 仍保持最近未完成的 tomorrow
    const appAfterRound2 = getApplicationById(app.id);
    expect(appAfterRound2?.next_interview_at).toBe(tomorrow);
  });

  it("更新轮次状态并重新计算下次待面时间", async () => {
    const {
      createApplication,
      createApplicationInterview,
      updateApplicationInterview,
      getApplicationById,
    } = await import("@/lib/applications");

    const app = createApplication({ company: "美团", role: "架构师" });
    const time1 = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const time2 = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

    const round1 = createApplicationInterview(app.id, {
      round_name: "一面",
      interview_time: time1,
      status: "scheduled",
    });

    createApplicationInterview(app.id, {
      round_name: "二面",
      interview_time: time2,
      status: "scheduled",
    });

    // 将一面标记为已通过 passed
    updateApplicationInterview(round1.id, { status: "passed" });

    // 主表 next_interview_at 应该自动向前推进到二面的时间 time2
    const appAfterPassed = getApplicationById(app.id);
    expect(appAfterPassed?.next_interview_at).toBe(time2);
    expect(appAfterPassed?.latest_round).toBe("二面");
  });

  it("删除投递主记录时级联删除所有关联面试轮次", async () => {
    const {
      createApplication,
      createApplicationInterview,
      deleteApplication,
      listApplicationInterviews,
    } = await import("@/lib/applications");

    const app = createApplication({ company: "腾讯", role: "前端工程师" });
    createApplicationInterview(app.id, { round_name: "一面", status: "scheduled" });
    createApplicationInterview(app.id, { round_name: "HR面", status: "scheduled" });

    expect(listApplicationInterviews(app.id).length).toBe(2);

    deleteApplication(app.id);
    expect(listApplicationInterviews(app.id).length).toBe(0);
  });

  it("API 路由 POST /api/applications/[id]/interviews 校验与流转", async () => {
    const { createApplication } = await import("@/lib/applications");
    const app = createApplication({
      company: "小红书",
      role: "前端研发",
      stage: "interviewing",
    });

    const route = await import("@/app/api/applications/[id]/interviews/route");
    const params = Promise.resolve({ id: String(app.id) });

    // 空轮次名称返回 400
    const failRes = await route.POST(
      jsonRequest("http://127.0.0.1/api/applications/" + app.id + "/interviews", "POST", {
        round_name: "  ",
      }),
      { params }
    );
    expect(failRes.status).toBe(400);

    // 非法状态返回 400
    const failStatusRes = await route.POST(
      jsonRequest("http://127.0.0.1/api/applications/" + app.id + "/interviews", "POST", {
        round_name: "一面",
        status: "invalid_status",
      }),
      { params }
    );
    expect(failStatusRes.status).toBe(400);

    // 成功创建并自动推进到 interview 阶段
    const succRes = await route.POST(
      jsonRequest("http://127.0.0.1/api/applications/" + app.id + "/interviews", "POST", {
        round_name: "一面",
        status: "scheduled",
        advance_stage: true,
      }),
      { params }
    );
    expect(succRes.status).toBe(201);
    const createdRound = await succRes.json();
    expect(createdRound.round_name).toBe("一面");

    const { getApplicationById } = await import("@/lib/applications");
    const afterApp = getApplicationById(app.id);
    expect(afterApp?.stage).toBe("interview");
  });

  it("API 路由 PATCH & DELETE /api/applications/[id]/interviews/[interviewId]", async () => {
    const { createApplication, createApplicationInterview } = await import("@/lib/applications");
    const app = createApplication({ company: "快手", role: "音视频前端" });
    const round = createApplicationInterview(app.id, { round_name: "一面", status: "scheduled" });

    const route = await import("@/app/api/applications/[id]/interviews/[interviewId]/route");
    const params = Promise.resolve({ id: String(app.id), interviewId: String(round.id) });

    // PATCH 更新状态为 passed
    const patchRes = await route.PATCH(
      jsonRequest("http://127.0.0.1/api/applications/" + app.id + "/interviews/" + round.id, "PATCH", {
        status: "passed",
        notes: "表现优秀，通过初试",
      }),
      { params }
    );
    expect(patchRes.status).toBe(200);
    const updated = await patchRes.json();
    expect(updated.status).toBe("passed");
    expect(updated.notes).toBe("表现优秀，通过初试");

    // DELETE 删除该轮次
    const delRes = await route.DELETE(
      jsonRequest("http://127.0.0.1/api/applications/" + app.id + "/interviews/" + round.id, "DELETE"),
      { params }
    );
    expect(delRes.status).toBe(200);
    const { getApplicationInterviewById } = await import("@/lib/applications");
    expect(getApplicationInterviewById(round.id)).toBeNull();
  });
});
