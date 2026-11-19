import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const model = vi.hoisted(() => ({ chat: vi.fn(), stream: vi.fn() }));
vi.mock("@/lib/llm", async (original) => ({
  ...await original<typeof import("@/lib/llm")>(), chat: model.chat, chatStream: model.stream,
}));

let directory: string;
let db: DatabaseSync;
beforeEach(async () => {
  vi.resetModules();
  model.chat.mockReset(); model.stream.mockReset();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-consumer-versions-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("@/lib/db")).getDb();
  db.prepare("INSERT INTO resumes (id, title, created_at, updated_at) VALUES (1, '发布标题', '', '')").run();
  db.prepare("INSERT INTO resume_modules (resume_id, module_key, type, label, sort, content, updated_at) VALUES (1, 'summary', 'summary', '评价', 0, ?, '')").run(JSON.stringify({ text: "发布内容" }));
});
afterEach(() => {
  db?.close(); vi.unstubAllEnvs();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-consumer-versions-")) throw new Error("Unsafe cleanup path");
  fs.rmSync(directory, { recursive: true, force: true });
});

const request = (body: unknown, method = "POST") => new Request("http://localhost/api/test", {
  method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const context = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
async function publish() {
  return (await import("@/lib/resume-versions")).publishResumeVersion(1, { name: "已投递版本" });
}
function editDraft() {
  db.prepare("UPDATE resumes SET title = '草稿标题' WHERE id = 1").run();
  db.prepare("UPDATE resume_modules SET content = ? WHERE resume_id = 1").run(JSON.stringify({ text: "草稿内容" }));
}

it("未发布简历不能创建投递，返回发布提示", async () => {
  const { POST } = await import("@/app/api/applications/route");
  const response = await POST(request({ company: "公司", role: "岗位", resume_id: 1 }));
  expect(response.status).toBe(400);
  expect((await response.json()).error).toContain("发布");
  expect(db.prepare("SELECT COUNT(*) AS total FROM applications").get()?.total).toBe(0);
});

it("投递当前内容与提交快照绑定发布版本，普通更新不改变绑定", async () => {
  const version = await publish();
  const { createApplication, getApplicationVersions, updateApplication } = await import("@/lib/applications");
  const app = createApplication({ company: "公司", role: "岗位", resume_id: 1 });
  expect(app.resume_version_id).toBe(version.id);
  editDraft();
  await publish();
  expect(updateApplication(app.id, { notes: "备注", resume_id: 1 }).resume_version_id).toBe(version.id);
  updateApplication(app.id, { stage: "applied" });
  const versions = getApplicationVersions(app.id)!;
  expect(versions.current.resume?.title).toBe("发布标题");
  expect(versions.submitted?.resume?.title).toBe("发布标题");
});

it("拒绝跨简历版本，准备页也拒绝同简历但不同版本的生成", async () => {
  const first = await publish();
  editDraft(); const second = await publish();
  const { createApplication } = await import("@/lib/applications");
  const app = createApplication({ company: "公司", role: "岗位", resume_id: 1, resume_version_id: first.id, jd: "JD" });
  const { resolvePreparationApplication } = await import("@/lib/application-preparation");
  expect(() => resolvePreparationApplication({ application_id: app.id }, { resumeId: 1, resumeVersionId: second.id, jd: "JD" })).toThrow("版本");
  db.prepare("INSERT INTO resumes (id, title, created_at, updated_at) VALUES (2, '其他简历', '', '')").run();
  const { POST } = await import("@/app/api/applications/route");
  expect((await POST(request({ company: "公司", role: "岗位", resume_id: 2, resume_version_id: first.id }))).status).toBe(400);
});

it("自我介绍创建及重新生成沿用已选版本", async () => {
  const version = await publish(); editDraft();
  const output = JSON.stringify({ versions: [{ kind: "30s", sentences: [{ text: "介绍。", comment: "点评" }] }, { kind: "2min", sentences: [{ text: "介绍。", comment: "点评" }] }] });
  model.stream.mockResolvedValue(output);
  model.chat.mockResolvedValue(JSON.stringify({ versions: [{ kind: "30s", sentences: [{ text: "介绍。", comment: "点评" }] }] }));
  const { POST } = await import("@/app/api/intros/route");
  const response = await POST(request({ resume_id: 1, resume_version_id: version.id, jd: "JD" }));
  expect(await response.text()).toContain('"id":1');
  expect(db.prepare("SELECT resume_version_id FROM intros WHERE id = 1").get()?.resume_version_id).toBe(version.id);
  expect(JSON.stringify(model.stream.mock.calls)).toContain("发布内容");
  expect(JSON.stringify(model.stream.mock.calls)).not.toContain("草稿内容");
  await publish();
  const regenerate = await import("@/app/api/intros/[id]/regenerate/route");
  expect((await regenerate.POST(request({ kind: "30s" }), context(1))).status).toBe(200);
  expect(JSON.stringify(model.chat.mock.calls)).toContain("发布内容");
  expect(JSON.stringify(model.chat.mock.calls)).not.toContain("草稿内容");
});

it.each(["gentle", "mining"])("%s 面试首题启用 JSON 校验后保存绑定版本", async (style) => {
  const version = await publish();
  model.stream.mockResolvedValue('{"question":"请介绍一段真实经历"}');
  const { POST } = await import("@/app/api/interviews/route");
  const response = await POST(request({ resume_id: 1, resume_version_id: version.id, jd: "JD", style }));
  expect(await response.text()).toContain('"question":"请介绍一段真实经历"');
  expect(model.stream.mock.calls[0]?.[3]).toMatchObject({ requireJson: "strict", signal: expect.any(AbortSignal) });
  expect(db.prepare("SELECT resume_version_id FROM interviews WHERE id = 1").get()?.resume_version_id).toBe(version.id);
  expect(db.prepare("SELECT question FROM interview_turns WHERE interview_id = 1").get()?.question).toBe("请介绍一段真实经历");
});

it.each(["gentle", "mining", "series"])("%s 首题超长不展示、不创建记录，修正后保留完整上限题干", async (mode) => {
  const version = await publish();
  const { INTERVIEW_QUESTION_MAX_CHARS } = await import("../prompt-guidelines");
  const question = "A".repeat(INTERVIEW_QUESTION_MAX_CHARS);
  const raw = JSON.stringify({ question: `${question}A` });
  model.stream.mockImplementationOnce(async (_model, _messages, onDelta) => { onDelta(raw); return raw; });
  const { POST } = await import("@/app/api/interviews/route");
  const body = { resume_id: 1, resume_version_id: version.id, jd: "JD", style: mode, mode: mode === "series" ? "series" : "single" };
  const events = await (await POST(request(body))).text();
  expect(events).toContain("不能超过 800 字符");
  expect(events).not.toContain("event: delta");
  expect(events).not.toContain("event: done");
  for (const table of ["interviews", "interview_series", "interview_turns"]) {
    expect(db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get()?.total).toBe(0);
  }
  model.stream.mockResolvedValueOnce(JSON.stringify({ question: ` \n${question}\t ` }));
  const retried = await (await POST(request(body))).text();
  expect(retried).toContain(`event: delta\ndata: ${JSON.stringify({ text: question })}`);
  expect(retried).toContain("event: done");
  expect(db.prepare("SELECT question FROM interview_turns").get()).toEqual({ question });
  expect(model.stream.mock.calls[0]![1][0].content).toContain("不超过 800 字符");
});

it("进阶面试下一轮沿用首轮绑定版本", async () => {
  const version = await publish(); editDraft();
  model.stream.mockResolvedValue('{"question":"首题"}'); model.chat.mockResolvedValue('{"question":"下一轮"}');
  const { POST } = await import("@/app/api/interviews/route");
  const response = await POST(request({ resume_id: 1, resume_version_id: version.id, jd: "JD", mode: "series" }));
  expect(await response.text()).toContain('"id":1');
  expect(model.stream.mock.calls[0]?.[3]).toMatchObject({ requireJson: "strict" });
  expect(db.prepare("SELECT resume_version_id FROM interview_series WHERE id = 1").get()?.resume_version_id).toBe(version.id);
  db.prepare("UPDATE interviews SET status = 'finished', report = ? WHERE id = 1").run(JSON.stringify({ overall: 8, strengths: "优势", weaknesses: "短板", suggestions: "建议" }));
  await publish();
  const { advanceSeries } = await import("@/lib/interview-commands/advance-series");
  await advanceSeries(1, 1, new AbortController().signal);
  expect(db.prepare("SELECT resume_version_id FROM interviews WHERE id = 2").get()?.resume_version_id).toBe(version.id);
  expect(JSON.stringify(model.chat.mock.calls)).toContain("发布内容");
  expect(JSON.stringify(model.chat.mock.calls)).not.toContain("草稿内容");
});

it("排雷持久化所选版本并读取固定内容", async () => {
  const version = await publish(); editDraft();
  model.chat.mockResolvedValue('{"risk_level":"low","overall_roast":"总体","items":[]}');
  const { POST } = await import("@/app/api/tools/resume-defenses/route");
  const response = await POST(request({ resumeId: 1, resume_version_id: version.id }));
  expect(response.status).toBe(200);
  expect(db.prepare("SELECT resume_version_id FROM resume_defenses WHERE id = 1").get()?.resume_version_id).toBe(version.id);
  expect(JSON.stringify(model.chat.mock.calls)).toContain("发布内容");
  expect(JSON.stringify(model.chat.mock.calls)).not.toContain("草稿内容");
});

it("排雷不能提交没有所属简历的版本 ID", async () => {
  const version = await publish();
  const response = await (await import("@/app/api/tools/resume-defenses/route")).POST(request({ resume_version_id: version.id, resumeContent: "手动输入" }));
  expect(response.status).toBe(400);
  expect(model.chat).not.toHaveBeenCalled();
});

it.each([true, false, "1", "1e0", " ", "12a", ["1"], [[1]], [], {}, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]
  .map(resumeId => ({ resumeId, label: JSON.stringify(resumeId) })))("排雷拒绝非正安全整数简历 ID $label，不回退为其他简历或调用模型", async ({ resumeId }) => {
  await publish();
  const response = await (await import("@/app/api/tools/resume-defenses/route")).POST(request({
    resumeId, resumeContent: "手动输入不可替代非法简历 ID",
  }));
  expect(response.status).toBe(400);
  expect((await response.json()).error).toContain("有效的简历");
  expect(model.chat).not.toHaveBeenCalled();
  expect(db.prepare("SELECT COUNT(*) AS total FROM resume_defenses").get()?.total).toBe(0);
});

it.each(["interviews", "intros", "diagnose", "defense"])("%s 在调用模型前拒绝未发布简历", async (kind) => {
  let response: Response;
  if (kind === "diagnose") response = await (await import("@/app/api/resumes/[id]/diagnose/route")).POST(request({ jd: "JD" }), context(1));
  else if (kind === "defense") response = await (await import("@/app/api/tools/resume-defenses/route")).POST(request({ resumeId: 1 }));
  else {
    const route = kind === "interviews" ? await import("@/app/api/interviews/route") : await import("@/app/api/intros/route");
    response = await route.POST(request({ resume_id: 1, jd: "JD" }));
  }
  expect(response.status).toBe(400);
  expect((await response.json()).error).toContain("发布");
  expect(model.chat).not.toHaveBeenCalled(); expect(model.stream).not.toHaveBeenCalled();
});

it("诊断记录和模型输入绑定所选旧版本", async () => {
  const version = await publish(); editDraft(); await publish();
  model.chat.mockResolvedValue(JSON.stringify({ match: 7, summary: "诊断", modules: [{ module_key: "summary", scores: { depth: 7, structure: 7, authenticity: 7, completeness: 7 }, gaps: "", suggestions: [] }] }));
  const response = await (await import("@/app/api/resumes/[id]/diagnose/route")).POST(request({ jd: "JD", resume_version_id: version.id }), context(1));
  expect(response.status).toBe(200);
  expect((await response.json()).resume_snapshot.modules[0].content.text).toBe("发布内容");
  expect(db.prepare("SELECT resume_version_id FROM resume_diagnoses WHERE id = 1").get()?.resume_version_id).toBe(version.id);
  expect(JSON.stringify(model.chat.mock.calls)).toContain("发布内容");
  expect(JSON.stringify(model.chat.mock.calls)).not.toContain("草稿内容");
});

it.each(["岗位原文", "岗位转义", "简历原文", "简历转义"])("诊断%s 超预算时返回 413、零调用零写入，缩短后可重试", async (source) => {
  const route = await import("@/app/api/resumes/[id]/diagnose/route");
  const output = JSON.stringify({ match: 7, summary: "依据已有材料诊断", modules: [{
    module_key: "summary", scores: { depth: 7, structure: 7, authenticity: 7, completeness: 7 }, gaps: "", suggestions: [],
  }] });
  const firstVersion = await publish();
  model.chat.mockResolvedValue(output);
  expect((await route.POST(request({ jd: "岗位要求", resume_version_id: firstVersion.id }), context(1))).status).toBe(200);
  const oversized = source.endsWith("转义") ? "&".repeat(14_000) : "文".repeat(64_001);
  let jd = "岗位要求";
  let version = firstVersion;
  if (source.startsWith("岗位")) jd = oversized;
  else {
    db.prepare("UPDATE resume_modules SET content = ? WHERE resume_id = 1").run(JSON.stringify({ text: oversized }));
    version = await publish();
  }
  const before = {
    diagnoses: db.prepare("SELECT * FROM resume_diagnoses ORDER BY id").all(),
    versions: db.prepare("SELECT * FROM resume_versions ORDER BY id").all(),
    modules: db.prepare("SELECT * FROM resume_modules ORDER BY id").all(),
  };
  model.chat.mockClear();
  const response = await route.POST(request({ jd, resume_version_id: version.id }), context(1));
  expect(response.status).toBe(413);
  expect((await response.json()).error).toContain("64000");
  expect(model.chat).not.toHaveBeenCalled();
  expect(db.prepare("SELECT * FROM resume_diagnoses ORDER BY id").all()).toEqual(before.diagnoses);
  expect(db.prepare("SELECT * FROM resume_versions ORDER BY id").all()).toEqual(before.versions);
  expect(db.prepare("SELECT * FROM resume_modules ORDER BY id").all()).toEqual(before.modules);
  if (source.startsWith("简历")) {
    db.prepare("UPDATE resume_modules SET content = ? WHERE resume_id = 1").run(JSON.stringify({ text: "仅参与联调，尚未上线" }));
    version = await publish();
  }
  const retried = await route.POST(request({ jd: "精简后的岗位要求", resume_version_id: version.id }), context(1));
  expect(retried.status).toBe(200);
  expect(model.chat).toHaveBeenCalledOnce();
  expect(db.prepare("SELECT COUNT(*) AS total FROM resume_diagnoses").get()?.total).toBe(2);
  expect(db.prepare("SELECT * FROM resume_diagnoses WHERE id = ?").get(before.diagnoses[0]!.id!)).toEqual(before.diagnoses[0]);
});

it.each(["answer", "finish", "evaluator-report", "reverse", "retry", "reference"])("面试 %s 始终向模型传入原绑定版本", async (action) => {
  const version = await publish(); editDraft(); await publish();
  db.prepare("INSERT INTO interviews (id, resume_id, resume_version_id, jd, created_at) VALUES (1, 1, ?, 'JD', '')").run(version.id);
  db.prepare("INSERT INTO interview_turns (id, interview_id, idx, question, answer, answered_at, scores) VALUES (1, 1, 1, '问题', '旧回答', ?, ?)")
    .run(action === "answer" ? "" : "2026-09-27", action === "answer" ? "" : JSON.stringify({ depth: 7, structure: 8, authenticity: 7, completeness: 8 }));
  const originalInterview = db.prepare("SELECT * FROM interviews WHERE id=1").get();
  const originalTurn = db.prepare("SELECT * FROM interview_turns WHERE id=1").get();
  const { LlmConfigError } = await import("@/lib/llm");
  model.chat.mockRejectedValue(new LlmConfigError("停止于模型边界"));
  model.stream.mockRejectedValue(new LlmConfigError("停止于模型边界"));
  const req = request({ turn_id: 1, answer: "新回答", question: "反问" });
  let response: Response;
  if (action === "retry") response = await (await import("@/app/api/interviews/[id]/turns/[tid]/retry/route")).POST(req, { params: Promise.resolve({ id: "1", tid: "1" }) });
  else if (action === "reference") response = await (await import("@/app/api/interviews/[id]/turns/[tid]/reference/route")).POST(req, { params: Promise.resolve({ id: "1", tid: "1" }) });
  else {
    const route = action === "answer" ? await import("@/app/api/interviews/[id]/answer/route") : action === "finish" ? await import("@/app/api/interviews/[id]/finish/route") : action === "reverse" ? await import("@/app/api/interviews/[id]/reverse/route") : await import("@/app/api/interviews/[id]/evaluator-report/route");
    response = await route.POST(req, context(1));
  }
  await response.text();
  const calls = JSON.stringify([...model.chat.mock.calls, ...model.stream.mock.calls]);
  expect(calls).toContain("发布内容");
  expect(calls).not.toContain("草稿内容");
  expect(model.chat.mock.calls.length + model.stream.mock.calls.length).toBe(1);
  expect(db.prepare("SELECT * FROM interviews WHERE id=1").get()).toEqual(originalInterview);
  expect(db.prepare("SELECT * FROM interview_turns WHERE id=1").get()).toEqual(originalTurn);
});
