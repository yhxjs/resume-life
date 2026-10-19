import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tempDir: string;
let db: DatabaseSync;

beforeEach(async () => {
  vi.resetModules();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-fields-"));
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
    !path.basename(tempDir).startsWith("resume-life-fields-")
  ) {
    throw new Error("Unsafe cleanup path");
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("当前数据库字段读写", () => {
it("application_interviews 支持 location, meeting_url, reminder_minutes 的插入与更新", async () => {
    const { createApplication, createApplicationInterview, updateApplicationInterview, getApplicationInterviewById } =
      await import("@/lib/applications");

    const app = createApplication({ company: "阿里巴巴", role: "资深技术专家" });
    const round = createApplicationInterview(app.id, {
      round_name: "技术一面",
      interview_time: "2026-10-01T10:00:00.000Z",
      location: "阿里钉钉会议",
      meeting_url: "https://meeting.dingtalk.com/j/123456",
      reminder_minutes: 30,
    });

    expect(round.location).toBe("阿里钉钉会议");
    expect(round.meeting_url).toBe("https://meeting.dingtalk.com/j/123456");
    expect(round.reminder_minutes).toBe(30);

    const updated = updateApplicationInterview(round.id, {
      location: "望京科技中心B座",
      reminder_minutes: 60,
    });
    expect(updated.location).toBe("望京科技中心B座");
    expect(updated.reminder_minutes).toBe(60);
    expect(updated.meeting_url).toBe("https://meeting.dingtalk.com/j/123456");

    const fetched = getApplicationInterviewById(round.id);
    expect(fetched?.location).toBe("望京科技中心B座");
    expect(fetched?.reminder_minutes).toBe(60);
  });

it("application_preparation_tasks 支持 due_time 的持久化与列表排序", async () => {
    const { createApplication } = await import("@/lib/applications");
    const { createPreparationTask, listPreparationTasks } = await import("@/lib/application-preparation");

    const app = createApplication({ company: "美团", role: "架构师" });
    const task = createPreparationTask(app.id, "复习分布式事务与Sagas模式", "2026-09-30T18:00:00.000Z");
    expect(task.title).toBe("复习分布式事务与Sagas模式");
    expect(task.due_time).toBe("2026-09-30T18:00:00.000Z");

    const list = listPreparationTasks(app.id);
    expect(list.length).toBe(1);
    expect(list[0]?.due_time).toBe("2026-09-30T18:00:00.000Z");
  });
});
