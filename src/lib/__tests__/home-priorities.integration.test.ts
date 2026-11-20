import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readHomePriorities } from "../home-priorities-contract";

const reference = new Date("2026-11-20T09:00:00Z");
let directory: string;
let db: DatabaseSync;
let priorities: typeof import("../home-priorities").getHomePriorities;
beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-home-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  priorities = (await import("../home-priorities")).getHomePriorities;
});
afterEach(() => {
  db?.close();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-home-")) throw new Error("Unsafe cleanup path");
  fs.rmSync(directory, { recursive: true, force: true });
});

function application(id: number, time = "", stage = "applied") {
  db.prepare("INSERT INTO applications (id, company, role, stage, next_interview_at, created_at, updated_at) VALUES (?, ?, '前端工程师', ?, ?, '', '')")
    .run(id, `公司${id}`, stage, time);
}
function round(appId: number, time: string, status = "scheduled") {
  db.prepare("INSERT INTO application_interviews (application_id, round_name, interview_time, status, created_at, updated_at) VALUES (?, '技术面', ?, ?, '', '')")
    .run(appId, time, status);
}
function review(id: number, date: string, count = 1) {
  db.prepare("INSERT INTO notebook_entries (id, source, source_id, question, created_at, updated_at) VALUES (?, 'interview', ?, '事务隔离', '', '')").run(id, id);
  db.prepare("INSERT INTO review_cards (notebook_id, next_review_date, review_count, created_at) VALUES (?, ?, ?, '')").run(id, date, count);
}
function ready(id: number) {
  db.prepare("INSERT INTO resumes (id, title, created_at, updated_at) VALUES (?, '简历', '', '')").run(id);
  db.prepare("INSERT INTO resume_versions (id, resume_id, version, name, snapshot, created_at) VALUES (?, ?, 1, '发布版', '{}', '')").run(id, id);
  db.prepare("UPDATE applications SET jd = '岗位要求', resume_id = ?, resume_version_id = ? WHERE id = ?").run(id, id, id);
  db.prepare("INSERT INTO intros (id, resume_id, created_at) VALUES (?, ?, '')").run(id, id);
  db.prepare("INSERT INTO jd_portraits (id, jd, created_at) VALUES (?, '岗位要求', '')").run(id);
  db.prepare("INSERT INTO resume_diagnoses (id, resume_id, jd, report, resume_snapshot, created_at) VALUES (?, ?, '岗位要求', '{}', '{}', '')").run(id, id);
  db.prepare("INSERT INTO application_preparation_resources (application_id, intro_id) VALUES (?, ?)").run(id, id);
  db.prepare("INSERT INTO application_preparation_resources (application_id, portrait_id) VALUES (?, ?)").run(id, id);
  db.prepare("INSERT INTO application_preparation_resources (application_id, diagnosis_id) VALUES (?, ?)").run(id, id);
}
function read() {
  const result = priorities(reference, "Asia/Hong_Kong");
  expect(readHomePriorities(result)).toEqual(result);
  return result.items;
}

describe("首页今日重点", () => {
  it("在全部候选中取前三项：临近面试、逾期复习、其他近期面试", () => {
    application(1); application(2, "2026-11-25T09:00:00Z"); application(3, "2026-11-20T20:00:00Z");
    review(1, "2026-11-19"); review(2, "2026-11-20");
    const items = read();
    expect(items.map(item => item.id)).toEqual(["application-3", "reviews", "application-2"]);
    expect(items[0]).toMatchObject({ href: "/applications/3/prepare", kind: "interview", urgent: true, badge: "明天面试" });
    expect(items[0]!.reason).toContain("岗位 JD");
    expect(items[1]).toMatchObject({ title: "复习 2 道到期题目", badge: "1 题已逾期" });
    expect(items[1]!.reason).toContain("错题 2 题、追练 0 题");
  });

  it("不足三项不凑数，同一岗位多轮只提示最近一轮并合并资料缺口", () => {
    application(1, "2026-11-20T09:01:00Z");
    round(1, "2026-11-22T09:00:00Z"); round(1, "2026-11-21T12:00:00+08:00");
    const items = read();
    expect(items).toHaveLength(1);
    expect(items[0]!.reason).toContain("11/21 12:00");
    expect(items[0]!.reason).toContain("自我介绍");
  });

  it.each([
    ["Asia/Hong_Kong", "2026-11-20T10:00:00", "11/20 20:00"],
    ["America/Los_Angeles", "2026-11-20T03:00:00", "11/20 03:00"],
    ["UTC", "2026-11-20T10:00:00", "11/20 10:00"],
  ])("%s 下混合历史本地时间与带时区轮次，按同一时刻规则选择最近面试", async (zone, legacyTime, expectedSchedule) => {
    vi.stubEnv("TZ", zone);
    const { createApplication, createApplicationInterview } = await import("../applications");
    const app = createApplication({ company: "混合时间格式", role: "研发工程师", stage: "interview" });
    createApplicationInterview(app.id, { round_name: "历史轮次", interview_time: legacyTime });
    createApplicationInterview(app.id, { round_name: "新轮次", interview_time: "2026-11-20T12:00:00Z" });
    const before = db.prepare("SELECT * FROM application_interviews ORDER BY id").all();

    const items = priorities(reference, zone).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: `application-${app.id}`, kind: "interview", urgent: true, badge: "今天面试" });
    expect(items[0]!.reason).toContain(`${expectedSchedule} 面试。`);
    expect(db.prepare("SELECT * FROM application_interviews ORDER BY id").all()).toEqual(before);
  });

  it("跳过无效、取消和已过期的轮次，并在当前轮次经过后继续提醒下一轮", () => {
    application(1, "2026-11-20T09:01:00Z"); ready(1);
    round(1, "invalid");
    round(1, "2026-11-20T10:00:00Z", "cancelled");
    round(1, "2026-11-20T08:00:00Z");
    round(1, "2026-11-20T12:00:00Z");
    round(1, "2026-11-21T12:00:00Z");
    expect(read()[0]!.reason).toContain("11/20 20:00 面试。");
    expect(priorities(new Date("2026-11-20T12:00:01Z"), "Asia/Hong_Kong").items[0]!.reason).toContain("11/21 20:00 面试。");
    expect(priorities(new Date("2026-11-21T12:00:01Z"), "Asia/Hong_Kong").items).toEqual([]);
  });

  it.each(["cancelled", "completed", "passed", "failed"])("%s 轮次不会被遗留的汇总时间重新推荐为面试", status => {
    application(1, "2026-11-20T09:30:00Z"); ready(1);
    round(1, "2026-11-20T09:30:00Z", status);
    expect(read()).toEqual([]);
  });

  it("忽略终止、无效日期、过期和超出七天的面试", () => {
    application(1, "2026-11-20T10:00:00Z", "rejected");
    for (const [id, time] of [[3, "invalid"], [4, "2026-11-20T08:59:00Z"], [5, "2026-11-27T09:00:01Z"]] as const) {
      application(id, time); ready(id);
    }
    expect(read()).toEqual([]);
  });

  it.each(["summary", "round"])("Offer 岗位保留 %s 中的待面试日程，不单独推荐补齐资料", source => {
    application(1, source === "summary" ? "2026-11-20T10:00:00Z" : "", "offer");
    application(2, "", "offer");
    if (source === "round") round(1, "2026-11-20T10:00:00Z");
    expect(read()).toMatchObject([{ id: "application-1", kind: "interview", href: "/applications/1/prepare", urgent: true }]);
    // 即使资料仍缺失，日程结束后也不再推荐已获 Offer 的岗位。
    expect(priorities(new Date("2026-11-20T10:00:01Z"), "Asia/Hong_Kong").items).toEqual([]);
  });

  it("多条历史非正 ID 提醒均提供可用的看板入口，同一岗位仍只展示一次", () => {
    application(-1, "2026-11-20T10:00:00Z"); round(-1, "2026-11-20T10:30:00Z");
    application(0);
    expect(read()).toMatchObject([
      { id: "application--1", kind: "interview", href: "/applications", action: "查看投递看板" },
      { id: "application-0", kind: "materials", href: "/applications", action: "查看投递看板" },
    ]);
  });

  it("按实际时刻而非 ISO 字符串排序，同时间以 ID 稳定排序", () => {
    application(3, "2026-11-20T11:00:00Z"); application(1, "2026-11-20T20:00:00+08:00"); application(2, "2026-11-20T11:00:00Z");
    expect(read().map(item => item.id)).toEqual(["application-2", "application-3", "application-1"]);
  });

  it("缺失简历或 JD 阻塞准备时排在今日复习前，其余资料排在复习后", () => {
    application(1); ready(1);
    db.prepare("DELETE FROM application_preparation_resources WHERE application_id = 1 AND intro_id IS NOT NULL").run();
    application(2); review(1, "2026-11-20");
    expect(read().map(item => item.id)).toEqual(["application-2", "reviews", "application-1"]);
    expect(read()[2]!.reason).toContain("还缺自我介绍。");
  });

  it("资料只认明确归属，补齐后移出；只有草稿仍提示关联发布版本", () => {
    application(1); ready(1); application(2);
    db.prepare("UPDATE applications SET resume_id = 1, jd = '岗位要求' WHERE id = 2").run();
    const missing = read();
    expect(missing).toHaveLength(1);
    expect(missing[0]!.reason).toContain("已发布的简历版本");
    expect(missing[0]!.reason).toContain("自我介绍");
    ready(2);
    expect(read()).toEqual([]);
    round(2, "2026-11-20T10:00:00Z");
    expect(read()[0]!.reason).toContain("准备资料已齐");
  });

  it("当地日期决定到期；新卡可立即复习而不误标逾期，复习后退出", () => {
    review(1, "2026-11-20");
    const instant = new Date("2026-11-19T20:00:00Z");
    expect(priorities(instant, "America/Los_Angeles").items).toEqual([]);
    expect(priorities(instant, "Asia/Hong_Kong")).toMatchObject({ date: "2026-11-20", items: [{ badge: "今日到期" }] });
    db.prepare("UPDATE review_cards SET review_count = 0, next_review_date = '2026-11-01'").run();
    expect(read()[0]!.badge).toBe("今日到期");
    db.prepare("UPDATE review_cards SET review_count = 1, next_review_date = '2026-11-21'").run();
    expect(read()).toEqual([]);
  });

  it("端点返回不可缓存的结果，拒绝坏时区；查询失败不冒充空列表", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(reference);
    const { GET } = await import("@/app/api/home/priorities/route");
    const response = await GET(new Request("http://localhost/api/home/priorities?time_zone=Asia/Hong_Kong"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(await response.json()).toEqual({ date: "2026-11-20", items: [] });
    expect((await GET(new Request("http://localhost/api/home/priorities?time_zone=bad-zone"))).status).toBe(400);
    vi.spyOn(console, "error").mockImplementation(() => {});
    db.exec("DROP TABLE review_attempts");
    const failure = await GET(new Request("http://localhost/api/home/priorities"));
    expect(failure.status).toBe(500);
    expect(await failure.text()).not.toContain("review_attempts");
  });
});
