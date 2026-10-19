import { normalizeContent } from "@/lib/modules";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const model = vi.hoisted(() => ({ chat: vi.fn(), stream: vi.fn() }));
vi.mock("../safe-llm", async (original) => ({ ...await original<typeof import("../safe-llm")>(), safeChat: model.chat, safeChatStream: model.stream }));

let tempDir: string;
let db: DatabaseSync;
let first: number;
let second: number;

beforeEach(async () => {
  vi.resetModules();
  model.chat.mockReset();
  model.stream.mockReset();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-preparation-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", path.join(tempDir, "data"));
  db = (await import("@/lib/db")).getDb();
  db.exec("INSERT INTO resumes (id, title, created_at, updated_at) VALUES (1, '简历', '', '')");
  db.prepare("INSERT INTO resume_modules (resume_id, module_key, type, label, content, updated_at) VALUES (1, 'summary', 'summary', '自我评价', ?, '')").run(JSON.stringify(normalizeContent("summary", { text: "前端经验" })));
  (await import("@/lib/resume-versions")).publishResumeVersion(1, { name: "测试发布版本" });
  const { createApplication } = await import("@/lib/applications");
  first = createApplication({ company: "甲公司", role: "前端", jd: "同一份 JD", resume_id: 1 }).id;
  second = createApplication({ company: "乙公司", role: "前端", jd: "同一份 JD", resume_id: 1 }).id;
  db.exec("INSERT INTO intros (id, resume_id, jd, created_at) VALUES (1, 1, '同一份 JD', ''), (2, 1, '其他 JD', '')");
});

afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (path.dirname(tempDir) !== os.tmpdir() || !path.basename(tempDir).startsWith("resume-life-preparation-")) throw new Error("Unsafe cleanup path");
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("投递准备资料", () => {
  it("关联已有模考时保存旧错题归属，编辑投递绑定模考也生效", async () => {
    db.exec("INSERT INTO interviews (id, resume_id, jd, created_at) VALUES (1, 1, 'JD', ''); INSERT INTO interview_turns (id, interview_id, idx, question) VALUES (1, 1, 1, '旧问题'); INSERT INTO notebook_entries (id, source, source_id, question, created_at, updated_at) VALUES (1, 'interview', 1, '旧问题', '', '')");
    const prep = await import("@/lib/application-preparation");
    prep.linkPreparationResource(first, "interview", 1);
    const apps = await import("@/lib/applications");
    apps.updateApplication(second, { interview_id: 1 });
    expect(prep.listPreparationResources(first, "notebook").items[0]?.linked).toBe(false);
    db.exec("DELETE FROM interviews WHERE id = 1");
    expect(prep.listPreparationResources(first, "notebook").items[0]).toMatchObject({ title: "旧问题", linked: true });
    expect(prep.listPreparationResources(second, "notebook").items[0]?.title).toBe("旧问题");
  });

  it("备份恢复保留资料关联与已完成待办", async () => {
    const prep = await import("@/lib/application-preparation");
    prep.linkPreparationResource(first, "intro", 1);
    const task = prep.createPreparationTask(first, "练习表达");
    db.prepare("UPDATE application_preparation_tasks SET done = 1 WHERE id = ?").run(task.id);
    const before = prep.listPreparationTasks(first);
    const backup = await import("@/lib/backup");
    const records = await import("@/lib/backup-records");
    const { stageBackupRecordStream } = await import("@/lib/backup-staging");
    const chunks: Uint8Array[] = [];
    for await (const chunk of records.createBackupRecordStream(db)) chunks.push(chunk);
    async function* source() { for (const chunk of chunks) yield chunk; }
    const staged = await stageBackupRecordStream(source(), db);
    try {
      db.prepare("DELETE FROM applications WHERE id = ?").run(first);
      backup.restoreAllData(staged, false);
      expect(prep.listPreparationResources(first, "intro").items.map((item) => item.id)).toEqual([1]);
      expect(prep.listPreparationTasks(first)).toEqual(before);
    } finally { staged.dispose(); }
  });
  it("只汇总明确关联的资料，同简历同 JD 不会自动混入另一投递", async () => {
    const prep = await import("@/lib/application-preparation");
    prep.linkPreparationResource(first, "intro", 1);
    prep.linkPreparationResource(first, "intro", 1);
    expect(prep.listPreparationResources(first, "intro").items.map((item) => item.id)).toEqual([1]);
    expect(prep.listPreparationResources(second, "intro").items).toEqual([]);
    db.prepare("UPDATE applications SET jd = '新版 JD' WHERE id = ?").run(first);
    expect(prep.listPreparationResources(first, "intro").items[0]?.id).toBe(1);
    prep.unlinkPreparationResource(first, "intro", 1);
    expect(prep.listPreparationResources(first, "intro").items).toEqual([]);
    expect(db.prepare("SELECT id FROM intros WHERE id = 1").get()).toBeDefined();
  });

  it("候选资料稳定分页，并排除当前投递已关联的资料", async () => {
    const prep = await import("@/lib/application-preparation");
    const page = prep.listPreparationResources(first, "intro", { candidates: true, limit: 1 });
    expect(page.items.map((item) => item.id)).toEqual([2]);
    expect(page.nextCursor).toBe("2");
    expect(prep.listPreparationResources(first, "intro", { candidates: true, limit: 1, cursor: 2 }).items.map((item) => item.id)).toEqual([1]);
    prep.linkPreparationResource(first, "intro", 2);
    expect(prep.listPreparationResources(first, "intro", { candidates: true }).items.map((item) => item.id)).toEqual([1]);
  });

  it("删除资料自动清理关联，删除投递不删除共享的原资料", async () => {
    const prep = await import("@/lib/application-preparation");
    prep.linkPreparationResource(first, "intro", 1);
    prep.linkPreparationResource(first, "intro", 2);
    db.exec("DELETE FROM intros WHERE id = 1");
    expect(prep.listPreparationResources(first, "intro").items.map((item) => item.id)).toEqual([2]);
    db.prepare("DELETE FROM applications WHERE id = ?").run(first);
    expect(db.prepare("SELECT * FROM application_preparation_resources").all()).toHaveLength(0);
    expect(db.prepare("SELECT id FROM intros WHERE id = 2").get()).toBeDefined();
  });

  it("不存在的投递、资料和非法种类不能写入关联", async () => {
    const prep = await import("@/lib/application-preparation");
    expect(() => prep.linkPreparationResource(999, "intro", 1)).toThrow(/投递/);
    expect(() => prep.linkPreparationResource(first, "intro", 999)).toThrow(/资料/);
    expect(() => prep.parsePreparationKind("__proto__")).toThrow(/类型/);
    expect(() => prep.resolvePreparationApplication({ application_id: second }, { resumeId: 99, jd: "同一份 JD" })).toThrow(/简历/);
    expect(() => prep.resolvePreparationApplication({ application_id: first }, { resumeId: 1, jd: "过期 JD" })).toThrow(/JD/);
  });
});

describe("投递准备 API", () => {
  it("创建和修改待办拒绝无效截止时间，失败保留原记录", async () => {
    const route = await import("@/app/api/applications/[id]/preparation/tasks/route");
    const context = { params: Promise.resolve({ id: String(first) }) };
    const request = (method: string, body: unknown) => new Request("http://localhost/api/preparation/tasks", {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const invalidValues = ["not-a-date", "2026-02-30T10:00:00Z", "2026-09-30T25:00:00Z", "2026-09-30T10:00", 123, null];
    for (const due_time of invalidValues) {
      expect((await route.POST(request("POST", { title: "无效日期", due_time }), context)).status).toBe(400);
    }
    expect(db.prepare("SELECT id FROM application_preparation_tasks").all()).toHaveLength(0);
    const created = await route.POST(request("POST", { title: "时区测试", due_time: "2026-09-30T18:30:00+08:00" }), context);
    expect(created.status).toBe(201);
    const task = await created.json();
    expect(task.due_time).toBe("2026-09-30T10:30:00.000Z");
    for (const due_time of invalidValues) {
      expect((await route.PATCH(request("PATCH", { id: task.id, due_time, title: "不得保存" }), context)).status).toBe(400);
    }
    expect(db.prepare("SELECT title, due_time FROM application_preparation_tasks WHERE id = ?").get(task.id))
      .toMatchObject({ title: "时区测试", due_time: task.due_time });
    expect((await route.PATCH(request("PATCH", { id: task.id, due_time: "" }), context)).status).toBe(200);
    expect(db.prepare("SELECT due_time FROM application_preparation_tasks WHERE id = ?").get(task.id)).toMatchObject({ due_time: "" });
  });

  it("再次诊断沿用本投递岗位且生成新关联，同 JD 的另一投递拥有独立历史", async () => {
    model.chat.mockResolvedValue(JSON.stringify({ match: 7, summary: "诊断摘要", modules: [{ module_key: "summary", scores: { depth: 7, structure: 7, authenticity: 7, completeness: 7 }, gaps: "补充结果", suggestions: [] }] }));
    const route = await import("@/app/api/resumes/[id]/diagnose/route");
    const diagnose = async (applicationId: number, extra = {}) => {
      const response = await route.POST(new Request("http://localhost/api/resumes/1/diagnose", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ application_id: applicationId, jd: "同一份 JD", ...extra }) }), { params: Promise.resolve({ id: "1" }) });
      expect(response.status).toBe(200);
      return response.json();
    };
    const a = await diagnose(first);
    const b = await diagnose(second);
    const next = await diagnose(first, { job_id: a.current.job_id });
    expect(next.current.job_id).toBe(a.current.job_id);
    expect(next.current.job_id).not.toBe(b.current.job_id);
    const prep = await import("@/lib/application-preparation");
    expect(prep.listPreparationResources(first, "diagnosis").items).toHaveLength(2);
    expect(prep.listPreparationResources(second, "diagnosis").items).toHaveLength(1);
  });

  it("从准备页生成的自我介绍在同一事务中关联到投递", async () => {
    model.stream.mockResolvedValue(JSON.stringify({ versions: [{ kind: "30s", sentences: [{ text: "我擅长前端开发", comment: "清楚" }] }, { kind: "2min", sentences: [{ text: "我有项目经验", comment: "具体" }] }] }));
    const route = await import("@/app/api/intros/route");
    const response = await route.POST(new Request("http://localhost/api/intros", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ application_id: first, resume_id: 1, jd: "同一份 JD" }) }));
    const text = await response.text();
    expect(text).toContain("event: done");
    const prep = await import("@/lib/application-preparation");
    expect(prep.listPreparationResources(first, "intro").items).toHaveLength(1);
    expect(prep.listPreparationResources(second, "intro").items).toHaveLength(0);
  });

  it("投递上下文失效时在调用模型之前返回错误", async () => {
    const route = await import("@/app/api/tools/jd-portraits/route");
    const response = await route.POST(new Request("http://localhost/api/tools/jd-portraits", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ application_id: first, jd: "过期 JD" }) }));
    expect(response.status).toBe(409);
    expect(model.chat).not.toHaveBeenCalled();
  });

  it("生成过程中投递发生变更时回滚新资料与关联", async () => {
    model.stream.mockImplementation(async () => {
      db.prepare("UPDATE applications SET jd = '变更后的 JD' WHERE id = ?").run(first);
      return JSON.stringify({ versions: [{ kind: "30s", sentences: [{ text: "自我介绍", comment: "" }] }, { kind: "2min", sentences: [{ text: "详细介绍", comment: "" }] }] });
    });
    const route = await import("@/app/api/intros/route");
    const response = await route.POST(new Request("http://localhost/api/intros", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ application_id: first, resume_id: 1, jd: "同一份 JD" }) }));
    expect(await response.text()).toContain("event: error");
    expect(db.prepare("SELECT id FROM intros").all()).toHaveLength(2);
  });

  it("来自关联模拟面试的错题在源面试删除后仍留在准备页", async () => {
    db.exec("INSERT INTO interviews (id, resume_id, jd, created_at) VALUES (1, 1, '同一份 JD', ''); INSERT INTO interview_turns (id, interview_id, idx, question) VALUES (1, 1, 1, '解释闭包')");
    const prep = await import("@/lib/application-preparation");
    prep.linkPreparationResource(first, "interview", 1);
    const route = await import("@/app/api/notebook/route");
    const response = await route.POST(new Request("http://localhost/api/notebook", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: "interview", source_id: 1 }) }));
    expect(response.status).toBe(201);
    db.exec("DELETE FROM interviews WHERE id = 1");
    expect(prep.listPreparationResources(first, "notebook").items[0]?.title).toBe("解释闭包");
    expect(prep.listPreparationResources(second, "notebook").items).toHaveLength(0);
  });

  it("待办新增、完成、刷新、删除均归属当前投递，跨投递修改返回 404", async () => {
    const route = await import("@/app/api/applications/[id]/preparation/tasks/route");
    const context = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
    const request = (method: string, body: unknown) => new Request("http://localhost/api/preparation/tasks", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const created = await route.POST(request("POST", { title: "练习 30 秒自我介绍" }), context(first));
    expect(created.status).toBe(201);
    const task = await created.json();
    expect((await route.PATCH(request("PATCH", { id: task.id, done: true }), context(second))).status).toBe(404);
    expect((await route.PATCH(request("PATCH", { id: task.id, done: true }), context(first))).status).toBe(200);
    const overview = await import("@/app/api/applications/[id]/preparation/route");
    const data = await (await overview.GET(new Request("http://localhost/api/preparation"), context(first))).json();
    expect(data.tasks).toEqual([expect.objectContaining({ title: "练习 30 秒自我介绍", done: true })]);
    expect((await route.DELETE(request("DELETE", { id: task.id }), context(second))).status).toBe(404);
    expect((await route.DELETE(request("DELETE", { id: task.id }), context(first))).status).toBe(200);
    expect((await route.POST(request("POST", { title: " " }), context(first))).status).toBe(400);
    expect((await overview.GET(new Request("http://localhost/api/preparation"), context(999))).status).toBe(404);
  });
});
