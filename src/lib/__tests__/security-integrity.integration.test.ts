import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { emptySummary } from "../summary";

const llm = vi.hoisted(() => ({ chat: vi.fn(), chatStream: vi.fn() }));
vi.mock("@/lib/llm", () => ({ ...llm, extractJson: JSON.parse, LlmConfigError: class extends Error {} }));

let directory: string;
let db: DatabaseSync;
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-remediation-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", path.join(directory, "data"));
  db = (await import("@/lib/db")).getDb();
});
afterEach(() => {
  db.close();
  vi.unstubAllEnvs();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-remediation-")) throw new Error("Unsafe cleanup path");
  fs.rmSync(directory, { recursive: true, force: true });
});

const resumeParams = { params: Promise.resolve({ id: "1" }) };
const questionParams = { params: Promise.resolve({ id: "1", qid: "1" }) };
const patch = (body: unknown) => new Request("http://localhost/api/resumes/1", {
  method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const answer = (value: string) => new Request("http://localhost/api/drills/1/questions/1", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answer: value }),
});
const grade = (score: number) => JSON.stringify({
  depth: score, structure: score, authenticity: score, completeness: score, comment: "点评", reference: "参考",
});
function seedResume() {
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'简历','old','old')");
  db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,content,updated_at) VALUES (1,'basic','basic',?,'old')")
    .run(JSON.stringify({ name: "原姓名", email: "原邮箱" }));
}
function seedDrill() {
  db.exec("INSERT INTO drills (id,source,direction,created_at) VALUES (1,'bank','前端','old'); INSERT INTO drill_questions (id,drill_id,idx,question) VALUES (1,1,1,'原题')");
}
function gate() {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("安全与完整性：简历条件保存与输入校验", () => {
  it("两个旧标签页保存同一模块时返回冲突且保留先保存的字段", async () => {
    seedResume();
    const { GET, PATCH } = await import("@/app/api/resumes/[id]/route");
    const initial = await (await GET(new Request("http://localhost/api/resumes/1"), resumeParams)).json();
    const revision = initial.modules[0].revision;
    expect(revision).toMatch(/^[0-9a-f]{64}$/);
    const first = await PATCH(patch({ modules: { basic: { ...initial.modules[0].content, name: "新姓名" } }, moduleRevisions: { basic: revision } }), resumeParams);
    expect(first.status).toBe(200);
    const second = await PATCH(patch({ modules: { basic: { ...initial.modules[0].content, email: "新邮箱" } }, moduleRevisions: { basic: revision } }), resumeParams);
    expect(second.status).toBe(409);
    const final = await (await GET(new Request("http://localhost/api/resumes/1"), resumeParams)).json();
    expect(final.modules[0].content.name).toBe("新姓名");
    expect(final.modules[0].content.email).toBe("原邮箱");
  });

  it("旧标签页不能覆盖另一页已保存的标题", async () => {
    seedResume();
    const { GET, PATCH } = await import("@/app/api/resumes/[id]/route");
    const initial = await (await GET(new Request("http://localhost/api/resumes/1"), resumeParams)).json();
    expect((await PATCH(patch({ title: "先保存的标题", titleRevision: initial.resume.titleRevision }), resumeParams)).status).toBe(200);
    expect((await PATCH(patch({ title: "旧标签页标题", titleRevision: initial.resume.titleRevision }), resumeParams)).status).toBe(409);
    expect(db.prepare("SELECT title FROM resumes WHERE id = 1").get()).toEqual({ title: "先保存的标题" });
  });

  it.each([null, [], { name: 42 }, { email: null }])("拒绝错误 basic 内容 %j 且不修改时间戳", async (content) => {
    seedResume();
    const { GET, PATCH } = await import("@/app/api/resumes/[id]/route");
    const initial = await (await GET(new Request("http://localhost/api/resumes/1"), resumeParams)).json();
    const response = await PATCH(patch({ modules: { basic: content }, moduleRevisions: { basic: initial.modules[0].revision } }), resumeParams);
    expect(response.status).toBe(400);
    expect(db.prepare("SELECT content, updated_at FROM resume_modules WHERE id = 1").get()).toEqual({
      content: JSON.stringify({ name: "原姓名", email: "原邮箱" }), updated_at: "old",
    });
  });

  it("显式空对象仍可清空基本信息", async () => {
    seedResume();
    const { GET, PATCH } = await import("@/app/api/resumes/[id]/route");
    const initial = await (await GET(new Request("http://localhost/api/resumes/1"), resumeParams)).json();
    expect((await PATCH(patch({ modules: { basic: {} }, moduleRevisions: { basic: initial.modules[0].revision } }), resumeParams)).status).toBe(200);
    expect(JSON.parse((db.prepare("SELECT content FROM resume_modules WHERE id = 1").get() as { content: string }).content).name).toBe("");
  });

  it.each([{}, [null], [{ school: 7 }]])("拒绝错误教育经历结构 %j", async (content) => {
    seedResume();
    db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,content,updated_at) VALUES (1,'education','education',?,'old')")
      .run(JSON.stringify([{ id: "e1", school: "原学校" }]));
    const { GET, PATCH } = await import("@/app/api/resumes/[id]/route");
    const initial = await (await GET(new Request("http://localhost/api/resumes/1"), resumeParams)).json();
    const revision = initial.modules.find((module: { key: string }) => module.key === "education").revision;
    expect((await PATCH(patch({ modules: { education: content }, moduleRevisions: { education: revision } }), resumeParams)).status).toBe(400);
    expect(db.prepare("SELECT content, updated_at FROM resume_modules WHERE module_key = 'education'").get()).toEqual({
      content: JSON.stringify([{ id: "e1", school: "原学校" }]), updated_at: "old",
    });
  });
});

describe("安全与完整性：练习评分提交", () => {
  it("迟到评分不覆盖较新的答案", async () => {
    seedDrill();
    const slow = gate();
    llm.chat.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(grade(8));
    const { POST } = await import("@/app/api/drills/[id]/questions/[qid]/route");
    const old = POST(answer("旧回答"), questionParams);
    await vi.waitFor(() => expect(llm.chat).toHaveBeenCalledTimes(1));
    const latest = await POST(answer("新回答"), questionParams);
    expect(latest.status).toBe(200);
    slow.resolve(grade(3));
    expect((await old).status).toBe(409);
    expect(db.prepare("SELECT answer FROM drill_questions WHERE id = 1").get()).toEqual({ answer: "新回答" });
  });

  it("等待期间删除题目后不报告评分成功", async () => {
    seedDrill();
    const slow = gate();
    llm.chat.mockReturnValueOnce(slow.promise);
    const { POST } = await import("@/app/api/drills/[id]/questions/[qid]/route");
    const pending = POST(answer("回答"), questionParams);
    await vi.waitFor(() => expect(llm.chat).toHaveBeenCalledTimes(1));
    db.exec("DELETE FROM drill_questions WHERE id = 1");
    slow.resolve(grade(5));
    expect((await pending).status).toBe(404);
  });

  it("备份恢复同 ID 且内容相同的题目后旧评分也必须失效", async () => {
    seedDrill();
    const { exportAllData, restoreAllData } = await import("@/lib/__tests__/backup-fixture");
    const payload = exportAllData();
    const slow = gate();
    llm.chat.mockReturnValueOnce(slow.promise);
    const { POST } = await import("@/app/api/drills/[id]/questions/[qid]/route");
    const pending = POST(answer("恢复前回答"), questionParams);
    await vi.waitFor(() => expect(llm.chat).toHaveBeenCalledTimes(1));
    const handle = {
      stats: payload.meta.stats,
      sequences: payload.meta.sequences!,
      files: [],
      readTableBatch(table: string, afterRowId = 0, limit = 200) {
        return (payload.data[table] ?? []).map((data, index) => ({ cursor: index + 1, data }))
          .filter((row) => row.cursor > afterRowId).slice(0, limit);
      },
      readFileBytes() { throw new Error("No files"); },
    };
    restoreAllData(handle, false);
    slow.resolve(grade(4));
    expect((await pending).status).toBe(409);
    expect(db.prepare("SELECT answer FROM drill_questions WHERE id = 1").get()).toEqual({ answer: "" });
  });
});

describe("安全与完整性：AI 总结协议", () => {
  // 现行协议（summary.ts isGeneratedProjectSummary）：五维其一非空即放行，仅接受全空/类型错误的结构
  it.each(["[]", "null", '{"overview":42}'])("拒绝结构错误的模型输出 %s", async (raw) => {
    db.prepare("INSERT INTO projects (id,name,summary,created_at,updated_at) VALUES (1,'项目',?,'old','old')").run(JSON.stringify({ ...emptySummary(), overview: "原总结" }));
    db.exec("INSERT INTO project_materials (project_id,title,content,created_at) VALUES (1,'材料','项目事实','old')");
    llm.chatStream.mockResolvedValueOnce(raw);
    const { POST } = await import("@/app/api/projects/[id]/summarize/route");
    const response = await POST(new Request("http://localhost/api/projects/1/summarize", { method: "POST" }), resumeParams);
    const stream = await response.text();
    expect(stream).toContain("event: error");
    expect(stream).not.toContain("event: done");
    expect(db.prepare("SELECT summary FROM projects WHERE id = 1").get()).toEqual({ summary: JSON.stringify({ ...emptySummary(), overview: "原总结" }) });
  });
  it("单个有效五维字段的模型输出仍返回待确认草稿", async () => {
    db.prepare("INSERT INTO projects (id,name,summary,created_at,updated_at) VALUES (1,'项目',?,'old','old')").run(JSON.stringify({ ...emptySummary(), overview: "原总结" }));
    db.exec("INSERT INTO project_materials (project_id,title,content,created_at) VALUES (1,'材料','项目事实','old')");
    llm.chatStream.mockResolvedValueOnce('{"overview":"概述"}');
    const { POST } = await import("@/app/api/projects/[id]/summarize/route");
    const response = await POST(new Request("http://localhost/api/projects/1/summarize", { method: "POST" }), resumeParams);
    const stream = await response.text();
    expect(stream).toContain("event: done");
    expect(stream).not.toContain("event: error");
    // 草稿确认制：AI 产出不经确认不写库，原总结保持不变
    expect(db.prepare("SELECT summary FROM projects WHERE id = 1").get()).toEqual({ summary: JSON.stringify({ ...emptySummary(), overview: "原总结" }) });
  });
  it("合法五字段模型输出仍返回待确认草稿", async () => {
    db.exec("INSERT INTO projects (id,name,created_at,updated_at) VALUES (1,'项目','old','old'); INSERT INTO project_materials (project_id,title,content,created_at) VALUES (1,'材料','项目事实','old')");
    llm.chatStream.mockResolvedValueOnce(JSON.stringify({
      overview: "概述", architecture: "架构", highlights: "亮点", responsibilities: "职责", challenges: "难点",
    }));
    const { POST } = await import("@/app/api/projects/[id]/summarize/route");
    const response = await POST(new Request("http://localhost/api/projects/1/summarize", { method: "POST" }), resumeParams);
    expect(await response.text()).toContain("event: done");
    expect(db.prepare("SELECT summary FROM projects WHERE id = 1").get()).toEqual({ summary: "{}" });
  });
});
