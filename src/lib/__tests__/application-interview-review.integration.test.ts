import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const model = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock("@/lib/llm", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/llm")>(),
  chat: model.chat,
}));

let directory: string;
let db: DatabaseSync;
let first: number;
let second: number;
let roundId: number;

const question = { question: "如何处理高并发？", answer: "用了缓存", stuck: "没有解释一致性", feedback: "希望说明失效策略" };
const result = {
  mistakes: [{ question_index: 1, gap: "缺少一致性说明", improved_answer: "说明缓存失效与回源保护" }],
  drills: [{ question_index: 1, question: "缓存失效时如何避免击穿？" }],
  resume_suggestions: [{ question_index: 1, suggestion: "补充缓存方案的具体指标与个人职责" }],
};

function request(method: string, body?: unknown, url = "http://localhost/api/applications/1/interviews/1/review") {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function context(appId = first, interviewId = roundId) {
  return { params: Promise.resolve({ id: String(appId), interviewId: String(interviewId) }) };
}

async function attachResume(submitted = false) {
  const timestamp = new Date().toISOString();
  const id = Number(db.prepare("INSERT INTO resumes (title, created_at, updated_at) VALUES (?, ?, ?)")
    .run("PRIVATE_DOCUMENT_TITLE", timestamp, timestamp).lastInsertRowid);
  const basic = { name: "PRIVATE_NAME", phone: "PRIVATE_PHONE", email: "PRIVATE_EMAIL", location: "PRIVATE_ADDRESS",
    birthday: "PRIVATE_BIRTHDAY", links: "PRIVATE_LINK", avatar: "/api/uploads/PRIVATE_AVATAR.png" };
  const insert = db.prepare("INSERT INTO resume_modules (resume_id, module_key, type, label, sort, content, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
  insert.run(id, "basic", "basic", "基本信息", 0, JSON.stringify(basic), timestamp);
  insert.run(id, "extra-basic", "basic", "其他联系方式", 1, JSON.stringify(basic), timestamp);
  insert.run(id, "skills", "skills", "技能", 2, JSON.stringify({ items: ["TypeScript", "缓存设计"] }), timestamp);
  insert.run(id, "summary", "summary", "自我评价", 3, JSON.stringify({ text: "发布时的职业经历" }), timestamp);
  insert.run(id, "work", "work", "工作经历", 4, JSON.stringify([{ company: "职业公司", title: "软件工程师",
    description: "优化响应性能", subItems: [{ label: "所属部门", value: "原有职业部门" }] }]), timestamp);
  const versions = await import("@/lib/resume-versions");
  const version = versions.publishResumeVersion(id, { name: "投递版本" });
  const applications = await import("@/lib/applications");
  applications.updateApplication(first, { resume_id: id, resume_version_id: version.id, ...(submitted ? { stage: "applied" } : {}) });
  return { id, version };
}

async function savedReview() {
  const review = await import("@/lib/application-interview-review");
  const initial = review.getInterviewReview(first, roundId);
  return { review, saved: review.saveInterviewQuestions(first, roundId, [question], initial.input_hash) };
}

beforeEach(async () => {
  vi.resetModules();
  model.chat.mockReset();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-real-review-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("@/lib/db")).getDb();
  const applications = await import("@/lib/applications");
  first = applications.createApplication({ company: "甲公司", role: "前端工程师", jd: "缓存与性能" }).id;
  second = applications.createApplication({ company: "乙公司", role: "后端工程师" }).id;
  roundId = applications.createApplicationInterview(first, { round_name: "技术一面", status: "completed" }).id;
});

afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-real-review-")) throw new Error("Unsafe cleanup path");
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("真实面试逐题复盘", () => {
  it("保存可增删的逐题草稿，并拒绝跨投递或过期版本写入", async () => {
    const route = await import("@/app/api/applications/[id]/interviews/[interviewId]/review/route");
    const initial = await (await route.GET(request("GET"), context())).json();
    expect(initial).toMatchObject({ questions: [], latest: null, history: [] });
    const saved = await route.PUT(request("PUT", { expected_hash: initial.input_hash, questions: [question, { ...question, question: "二题" }] }), context());
    expect(saved.status).toBe(200);
    expect((await saved.json()).questions).toHaveLength(2);
    expect((await route.PUT(request("PUT", { expected_hash: initial.input_hash, questions: [question] }), context())).status).toBe(409);
    expect((await route.PUT(request("PUT", { expected_hash: initial.input_hash, questions: [question] }), context(second))).status).toBe(404);
    const current = await (await route.GET(request("GET"), context())).json();
    const reduced = await route.PUT(request("PUT", { expected_hash: current.input_hash, questions: [question] }), context());
    expect((await reduced.json()).questions).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) AS total FROM application_interview_questions WHERE interview_id = ?").get(roundId)).toEqual({ total: 1 });
  });

  it("确认后保存三类结果与原始题目快照，重复确认不再次调用模型", async () => {
    model.chat.mockResolvedValue(JSON.stringify(result));
    const route = await import("@/app/api/applications/[id]/interviews/[interviewId]/review/route");
    const initial = await (await route.GET(request("GET"), context())).json();
    const saved = await (await route.PUT(request("PUT", { expected_hash: initial.input_hash, questions: [question] }), context())).json();
    const confirmed = await route.POST(request("POST", { expected_hash: saved.input_hash }), context());
    expect(confirmed.status).toBe(200);
    const payload = await confirmed.json();
    expect(payload.latest).toMatchObject({ application_id: first, interview_id: roundId, questions: [question], result });
    expect(model.chat).toHaveBeenCalledTimes(1);
    const messages = model.chat.mock.calls[0]?.[1] as { role: string; content: string }[];
    expect(messages[1]?.content).toContain("<interview_question>");
    expect(messages[1]?.content).toContain("如何处理高并发？");
    const repeated = await route.POST(request("POST", { expected_hash: saved.input_hash }), context());
    expect(repeated.status).toBe(200);
    expect((await repeated.json()).latest.id).toBe(payload.latest.id);
    expect(model.chat).toHaveBeenCalledTimes(1);
    const revisited = await (await route.GET(request("GET"), context())).json();
    expect(revisited.latest.result.drills[0].question).toBe("缓存失效时如何避免击穿？");
  });

  it.each([false, true])("模型使用固定职业内容，排除身份、标题与排版且不修改快照（已投递=%s）", async (submitted) => {
    const { id, version } = await attachResume(submitted);
    const original = db.prepare("SELECT submitted_resume FROM applications WHERE id = ?").get(first);
    const storedVersion = db.prepare("SELECT snapshot FROM resume_versions WHERE id = ?").get(version.id);
    db.prepare("UPDATE resume_modules SET content = ? WHERE resume_id = ? AND type = 'summary'")
      .run(JSON.stringify({ text: "尚未发布的新经历" }), id);
    if (submitted) {
      const { publishResumeVersion } = await import("@/lib/resume-versions");
      const { updateApplication } = await import("@/lib/applications");
      updateApplication(first, { resume_version_id: publishResumeVersion(id, { name: "后来绑定的版本" }).id });
    }
    model.chat.mockResolvedValue(JSON.stringify(result));
    const { review, saved } = await savedReview();
    await review.confirmInterviewReview(first, roundId, saved.input_hash);
    const messages = model.chat.mock.calls[0]![1] as { role: string; content: string }[];
    const outgoing = messages.map((message) => message.content).join("\n");
    expect(outgoing).toContain("TypeScript");
    expect(outgoing).toContain("发布时的职业经历");
    expect(outgoing).not.toContain("尚未发布的新经历");
    for (const marker of ["PRIVATE_NAME", "PRIVATE_PHONE", "PRIVATE_EMAIL", "PRIVATE_ADDRESS", "PRIVATE_BIRTHDAY",
      "PRIVATE_LINK", "PRIVATE_AVATAR", "PRIVATE_DOCUMENT_TITLE", "style_overrides", "resolved_style"]) {
      expect(outgoing).not.toContain(marker);
    }
    expect(db.prepare("SELECT submitted_resume FROM applications WHERE id = ?").get(first)).toEqual(original);
    expect(db.prepare("SELECT snapshot FROM resume_versions WHERE id = ?").get(version.id)).toEqual(storedVersion);
  });

  it.each(["company", "role", "jd", "resume_version", "resume_subitems"] as const)("仅更改 %s 也使旧复盘过期，新结果仍保留历史且幂等", async (field) => {
    const { id } = await attachResume();
    model.chat.mockResolvedValue(JSON.stringify(result));
    const { review, saved } = await savedReview();
    const old = (await review.confirmInterviewReview(first, roundId, saved.input_hash)).latest!;
    const applications = await import("@/lib/applications");
    if (field === "resume_version" || field === "resume_subitems") {
      const type = field === "resume_version" ? "summary" : "work";
      const content = field === "resume_version" ? { text: "新发布的职业内容" }
        : [{ company: "职业公司", title: "软件工程师", description: "优化响应性能", subItems: [{ label: "所属部门", value: "更新后的职业部门" }] }];
      db.prepare("UPDATE resume_modules SET content = ? WHERE resume_id = ? AND type = ?")
        .run(JSON.stringify(content), id, type);
      const { publishResumeVersion } = await import("@/lib/resume-versions");
      applications.updateApplication(first, { resume_version_id: publishResumeVersion(id, { name: "新版本" }).id });
    } else {
      applications.updateApplication(first, { [field]: `更新后的${field}` });
    }
    const current = review.getInterviewReview(first, roundId);
    expect(current.input_hash).not.toBe(saved.input_hash);
    expect(current.questions).toEqual([question]);
    await expect(review.confirmInterviewReview(first, roundId, saved.input_hash)).rejects.toMatchObject({ status: 409 });
    const regenerated = await review.confirmInterviewReview(first, roundId, current.input_hash);
    expect(regenerated.latest!.id).not.toBe(old.id);
    expect(regenerated.history).toHaveLength(2);
    expect(review.getInterviewReview(first, roundId, old.id).selected).toMatchObject({ questions: [question], result });
    await review.confirmInterviewReview(first, roundId, current.input_hash);
    expect(model.chat).toHaveBeenCalledTimes(2);
  });

  it("上下文变更使过期草稿保存返回 409，当前题目不被覆盖", async () => {
    const { saved } = await savedReview();
    const { updateApplication } = await import("@/lib/applications");
    updateApplication(first, { jd: "更新后的岗位要求" });
    const route = await import("@/app/api/applications/[id]/interviews/[interviewId]/review/route");
    const response = await route.PUT(request("PUT", { expected_hash: saved.input_hash, questions: [{ ...question, answer: "过期编辑" }] }), context());
    expect(response.status).toBe(409);
    expect((await (await route.GET(request("GET"), context())).json()).questions).toEqual([question]);
  });

  it("仅身份与排版变更不使相同职业输入重复生成", async () => {
    const { id } = await attachResume();
    model.chat.mockResolvedValue(JSON.stringify(result));
    const { review, saved } = await savedReview();
    const old = (await review.confirmInterviewReview(first, roundId, saved.input_hash)).latest!;
    db.prepare("UPDATE resumes SET title = '新标题', style_overrides = '{\"entryGap\":8}' WHERE id = ?").run(id);
    db.prepare("UPDATE resume_modules SET content = ? WHERE resume_id = ? AND type = 'basic'")
      .run(JSON.stringify({ name: "新姓名", phone: "新电话" }), id);
    const { publishResumeVersion } = await import("@/lib/resume-versions");
    const { updateApplication } = await import("@/lib/applications");
    updateApplication(first, { resume_version_id: publishResumeVersion(id, { name: "仅调整身份和排版" }).id });
    const current = review.getInterviewReview(first, roundId);
    expect(current.input_hash).toBe(saved.input_hash);
    expect((await review.confirmInterviewReview(first, roundId, current.input_hash)).latest!.id).toBe(old.id);
    expect(model.chat).toHaveBeenCalledTimes(1);
  });

  it.each(["jd", "resume_version"] as const)("生成等待期间 %s 变化时拒绝归档", async (field) => {
    const { id } = await attachResume();
    const { review, saved } = await savedReview();
    model.chat.mockImplementationOnce(async () => {
      const { updateApplication } = await import("@/lib/applications");
      if (field === "jd") updateApplication(first, { jd: "生成期间变更的 JD" });
      else {
        db.prepare("UPDATE resume_modules SET content = ? WHERE resume_id = ? AND type = 'summary'")
          .run(JSON.stringify({ text: "生成期间的新职业内容" }), id);
        const { publishResumeVersion } = await import("@/lib/resume-versions");
        updateApplication(first, { resume_version_id: publishResumeVersion(id, { name: "并发发布" }).id });
      }
      return JSON.stringify(result);
    });
    await expect(review.confirmInterviewReview(first, roundId, saved.input_hash)).rejects.toMatchObject({ status: 409 });
    expect(review.getInterviewReview(first, roundId).history).toEqual([]);
  });

  it("用户确认后可分别导出错题、追练和简历待办，重试不重复创建", async () => {
    model.chat.mockResolvedValue(JSON.stringify(result));
    const reviewRoute = await import("@/app/api/applications/[id]/interviews/[interviewId]/review/route");
    const exportRoute = await import("@/app/api/applications/[id]/interviews/[interviewId]/review/export/route");
    const initial = await (await reviewRoute.GET(request("GET"), context())).json();
    const saved = await (await reviewRoute.PUT(request("PUT", { expected_hash: initial.input_hash, questions: [question] }), context())).json();
    const recap = (await (await reviewRoute.POST(request("POST", { expected_hash: saved.input_hash }), context())).json()).latest;
    const url = `http://localhost/api/applications/${first}/interviews/${roundId}/review/export`;
    const run = (action: string, appId = first) => exportRoute.POST(request("POST", { recap_id: recap.id, action }, url), context(appId));

    expect((await run("mistakes")).status).toBe(200);
    const notebook = db.prepare("SELECT source, source_label, question, answer, comment, reference FROM notebook_entries").get();
    expect(notebook).toMatchObject({ source: "application_interview", question: question.question, answer: question.answer,
      comment: result.mistakes[0]!.gap, reference: result.mistakes[0]!.improved_answer });
    expect(db.prepare("SELECT COUNT(*) AS total FROM application_preparation_resources WHERE application_id = ?").get(first)).toEqual({ total: 1 });
    expect(db.prepare("SELECT COUNT(*) AS total FROM review_cards WHERE notebook_id IS NOT NULL").get()).toEqual({ total: 1 });

    const drill = await run("drills");
    expect(drill.status).toBe(200);
    const drillId = (await drill.json()).drill_id;
    expect(db.prepare("SELECT source, focus FROM drills WHERE id = ?").get(drillId)).toMatchObject({ source: "interview" });
    expect(db.prepare("SELECT question FROM drill_questions WHERE drill_id = ?").all(drillId)).toEqual([{ question: result.drills[0]!.question }]);

    expect((await run("resume_suggestions")).status).toBe(200);
    expect(db.prepare("SELECT title FROM application_preparation_tasks WHERE application_id = ?").all(first)).toEqual([
      { title: expect.stringContaining(result.resume_suggestions[0]!.suggestion) },
    ]);
    await run("mistakes"); await run("drills"); await run("resume_suggestions");
    expect(db.prepare("SELECT COUNT(*) AS total FROM notebook_entries").get()).toEqual({ total: 1 });
    expect(db.prepare("SELECT COUNT(*) AS total FROM drills").get()).toEqual({ total: 1 });
    expect(db.prepare("SELECT COUNT(*) AS total FROM application_preparation_tasks").get()).toEqual({ total: 1 });
    const revisited = await (await reviewRoute.GET(request("GET"), context())).json();
    expect(revisited.latest.exports).toEqual({ mistakes: true, drills: drillId, resume_suggestions: true });
    const backup = await import("@/lib/__tests__/backup-fixture");
    const payload = backup.exportAllData();
    expect(payload.data.application_interview_recap_exports).toHaveLength(3);
    expect(backup.validateBackupPayload(payload).valid).toBe(true);
    expect((await run("mistakes", second)).status).toBe(404);
    expect((await run("unknown")).status).toBe(400);
  });

  it("导出历史版本使用该版本原题，删除错题后可重新加入", async () => {
    model.chat.mockResolvedValue(JSON.stringify(result));
    const reviewRoute = await import("@/app/api/applications/[id]/interviews/[interviewId]/review/route");
    const exportRoute = await import("@/app/api/applications/[id]/interviews/[interviewId]/review/export/route");
    const initial = await (await reviewRoute.GET(request("GET"), context())).json();
    const firstDraft = await (await reviewRoute.PUT(request("PUT", { expected_hash: initial.input_hash, questions: [question] }), context())).json();
    const oldRecap = (await (await reviewRoute.POST(request("POST", { expected_hash: firstDraft.input_hash }), context())).json()).latest;
    const changed = { ...question, answer: "补充了新的回答" };
    const secondDraft = await (await reviewRoute.PUT(request("PUT", { expected_hash: firstDraft.input_hash, questions: [changed] }), context())).json();
    const newRecap = (await (await reviewRoute.POST(request("POST", { expected_hash: secondDraft.input_hash }), context())).json()).latest;
    const exportOld = () => exportRoute.POST(request("POST", { recap_id: oldRecap.id, action: "mistakes" }), context());

    const exported = await exportOld();
    expect(exported.status).toBe(200);
    const response = await exported.json();
    expect(response.selected.exports.mistakes).toBe(true);
    expect(response.latest.id).toBe(newRecap.id);
    expect(response.latest.exports.mistakes).toBe(false);
    const firstEntry = db.prepare("SELECT id, answer FROM notebook_entries").get() as { id: number; answer: string };
    expect(firstEntry.answer).toBe(question.answer);
    db.prepare("DELETE FROM notebook_entries WHERE id = ?").run(firstEntry.id);
    expect((await exportOld()).status).toBe(200);
    const recreated = db.prepare("SELECT id, answer FROM notebook_entries").get() as { id: number; answer: string };
    expect(recreated.id).not.toBe(firstEntry.id);
    expect(recreated.answer).toBe(question.answer);
    expect(db.prepare("SELECT COUNT(*) AS total FROM notebook_entries").get()).toEqual({ total: 1 });
  });

  it("拒绝无效 AI 输出，且生成期间题目变更时不归档旧结果", async () => {
    const route = await import("@/app/api/applications/[id]/interviews/[interviewId]/review/route");
    const initial = await (await route.GET(request("GET"), context())).json();
    const saved = await (await route.PUT(request("PUT", { expected_hash: initial.input_hash, questions: [question] }), context())).json();
    model.chat.mockResolvedValueOnce(JSON.stringify({ ...result, mistakes: [{ question_index: 9, gap: "无来源", improved_answer: "错误" }] }));
    expect((await route.POST(request("POST", { expected_hash: saved.input_hash }), context())).status).toBe(502);
    expect(db.prepare("SELECT COUNT(*) AS total FROM application_interview_recaps").get()).toEqual({ total: 0 });
    model.chat.mockImplementationOnce(async () => {
      const review = await import("@/lib/application-interview-review");
      review.saveInterviewQuestions(first, roundId, [{ ...question, question: "已修改" }], saved.input_hash);
      return JSON.stringify(result);
    });
    expect((await route.POST(request("POST", { expected_hash: saved.input_hash }), context())).status).toBe(409);
    expect(db.prepare("SELECT COUNT(*) AS total FROM application_interview_recaps").get()).toEqual({ total: 0 });
  });

  it("删除轮次级联清理逐题与结果，备份保留完整关联", async () => {
    model.chat.mockResolvedValue(JSON.stringify(result));
    const route = await import("@/app/api/applications/[id]/interviews/[interviewId]/review/route");
    const initial = await (await route.GET(request("GET"), context())).json();
    const saved = await (await route.PUT(request("PUT", { expected_hash: initial.input_hash, questions: [question] }), context())).json();
    await route.POST(request("POST", { expected_hash: saved.input_hash }), context());
    const backup = await import("@/lib/__tests__/backup-fixture");
    const payload = backup.exportAllData();
    expect(payload.data.application_interview_questions).toHaveLength(1);
    expect(payload.data.application_interview_recaps).toHaveLength(1);
    expect(backup.validateBackupPayload(payload).valid).toBe(true);
    const records = await import("@/lib/backup-records");
    const { stageBackupRecordStream } = await import("@/lib/backup-staging");
    const chunks: Uint8Array[] = [];
    for await (const chunk of records.createBackupRecordStream(db)) chunks.push(chunk);
    async function* source() { for (const chunk of chunks) yield chunk; }
    const staged = await stageBackupRecordStream(source(), db);
    db.prepare("DELETE FROM application_interviews WHERE id = ?").run(roundId);
    expect(db.prepare("SELECT COUNT(*) AS total FROM application_interview_questions").get()).toEqual({ total: 0 });
    expect(db.prepare("SELECT COUNT(*) AS total FROM application_interview_recaps").get()).toEqual({ total: 0 });
    try {
      backup.restoreAllData(staged, false);
      const restored = await (await route.GET(request("GET"), context())).json();
      expect(restored.questions).toEqual([question]);
      expect(restored.latest.result).toEqual(result);
    } finally { staged.dispose(); }
  });
});
