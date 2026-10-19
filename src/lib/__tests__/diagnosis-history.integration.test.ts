import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const model = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock("../safe-llm", async (original) => ({
  ...await original<typeof import("../safe-llm")>(), safeChat: model.chat,
}));
let directory: string;
let db: DatabaseSync;
let route: typeof import("@/app/api/resumes/[id]/diagnose/route");
const params = { params: Promise.resolve({ id: "1" }) };
const request = (body: unknown, method = "POST") => new Request("http://localhost/api/resumes/1/diagnose", {
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const report = (match = 6) => JSON.stringify({ match, summary: "匹配分析", modules: [{
  module_key: "summary", scores: { depth: 6, structure: 7, authenticity: 8, completeness: 6 },
  gaps: "突出项目成果", suggestions: [{ item_id: "", field: "text", reason: "对齐岗位", draft: "改进的自我评价" }],
}] });
const diagnose = async (body: unknown) => {
  const response = await route.POST(request(body), params);
  expect(response.status).toBe(200);
  return response.json();
};
const read = async (query = "") => {
  const response = await route.GET(new Request(`http://localhost/api/resumes/1/diagnose${query}`), params);
  expect(response.status).toBe(200);
  return response.json();
};

beforeEach(async () => {
  vi.resetModules();
  model.chat.mockReset().mockResolvedValue(report());
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-diagnosis-history-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  route = await import("@/app/api/resumes/[id]/diagnose/route");
  db = (await import("../db")).getDb();
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'测试简历','',''),(2,'其他简历','','')");
  db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,content,updated_at) VALUES (1,'summary','summary','自我评价',?,'')")
    .run(JSON.stringify({ text: "原自我评价" }));
  const { publishResumeVersion } = await import("../resume-versions");
  publishResumeVersion(1, { name: "测试发布版本" });
  publishResumeVersion(2, { name: "其他发布版本" });
});
afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-diagnosis-history-")) throw new Error("Unsafe cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("岗位诊断历史", () => {
  it("经历建议经过列表归一化后记录实际保存内容，保留原始报告草稿", async () => {
    db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,content,updated_at) VALUES (1,'work','work','工作经历',?,'')")
      .run(JSON.stringify([{ id: "w1", company: "公司", description: "原工作内容" }]));
    (await import("../resume-versions")).publishResumeVersion(1, { name: "工作经历版本" });
    const rawDraft = "- 新工作内容\n- 改善性能";
    model.chat.mockResolvedValue(JSON.stringify({ match: 7, modules: [{ module_key: "work",
      scores: { depth: 7, structure: 7, authenticity: 8, completeness: 7 }, suggestions: [
        { item_id: "w1", field: "description", reason: "对齐", draft: rawDraft },
      ],
    }] }));
    const diagnosis = await diagnose({ jd: "JD" });
    const savedText = "新工作内容\n改善性能";
    db.prepare("UPDATE resume_modules SET content = ? WHERE module_key = 'work'").run(JSON.stringify([{ id: "w1", description: savedText }]));
    const response = await route.PATCH(request({ diagnosis_id: diagnosis.id, module_key: "work", suggestion_index: 0, value: rawDraft }, "PATCH"), params);
    expect(response.status).toBe(200);
    const saved = await read();
    expect(saved.adoptions[0].value).toBe(savedText);
    expect(saved.report.modules[0].suggestions[0].draft).toBe(rawDraft);
  });
  it("恢复数据库世代后旧诊断请求失效，不把旧快照写入新库", async () => {
    db.exec("INSERT INTO runtime_state (id, data_generation) VALUES (1, 'original-generation')");
    model.chat.mockImplementation(async () => {
      db.prepare("UPDATE runtime_state SET data_generation = 'restored-generation' WHERE id = 1").run();
      return report();
    });
    const response = await route.POST(request({ jd: "JD" }), params);
    expect(response.status).toBe(409);
    expect((await read()).history).toHaveLength(0);
  });

  it("无法备份的超大快照在调用模型前拒绝，不产生历史", async () => {
    db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,content,updated_at) VALUES (1,'basic','basic','基本信息',?,'')")
      .run(JSON.stringify({ name: "界".repeat(710_000) }));
    // 模拟历史导入的大快照，诊断仍须防止产生不可备份的记录。
    const loaded = (await import("../resumes")).loadResume(1)!;
    db.prepare("INSERT INTO resume_versions (resume_id, version, name, description, created_at, snapshot) VALUES (1, 2, '历史大快照', '', '', ?)")
      .run(JSON.stringify({ title: loaded.resume.title, template: loaded.resume.template, style_overrides: {}, modules: loaded.modules }));
    expect((await route.POST(request({ jd: "JD" }), params)).status).toBe(413);
    expect(model.chat).not.toHaveBeenCalled();
    expect((await read()).history).toHaveLength(0);
  });

  it("历史快照与采纳信息参与备份，损坏内容被拒绝", async () => {
    await diagnose({ jd: "JD" });
    const backup = await import("./backup-fixture");
    const payload = backup.exportAllData();
    const row = payload.data.resume_diagnoses![0]!;
    const { invalidDomainColumn } = await import("../backup-domain");
    expect(invalidDomainColumn("resume_diagnoses", row)).toBeUndefined();
    expect(payload.meta.sequences?.resume_diagnoses).toBe(1);
    expect(invalidDomainColumn("resume_diagnoses", { ...row, resume_snapshot: '{"title":4}' })).toBe("resume_snapshot");
    expect(invalidDomainColumn("resume_diagnoses", { ...row, adoptions: '[{"value":4}]' })).toBe("adoptions");
  });
  it("重复诊断只追加记录，多个岗位隔离，历史版本仍可读取", async () => {
    const first = await diagnose({ jd: "前端 JD", job_title: "前端工程师" });
    const other = await diagnose({ jd: "后端 JD", job_title: "后端工程师" });
    model.chat.mockResolvedValue(report(8));
    const latest = await diagnose({ jd: "前端 JD", job_id: first.job_id });
    expect(db.prepare("SELECT count(*) AS total FROM resume_diagnoses").get()).toEqual({ total: 3 });
    expect(latest.job_id).toBe(first.job_id);
    expect(latest.job_id).not.toBe(other.job_id);
    expect(latest.previous.id).toBe(first.id);
    expect(latest.previous.report.match).toBe(6);
    expect(latest.report.match).toBe(8);
    expect((await read(`?diagnosis_id=${first.id}`)).report.match).toBe(6);
    expect((await read(`?job_id=${other.job_id}`)).id).toBe(other.id);
    expect((await read()).history).toHaveLength(3);
  });

  it("快照绑定模型调用前的简历，之后编辑不能改变历史", async () => {
    model.chat.mockImplementation(async () => {
      db.prepare("UPDATE resume_modules SET content = ? WHERE resume_id = 1").run(JSON.stringify({ text: "请求期间的修改" }));
      return report();
    });
    const result = await diagnose({ jd: "JD" });
    expect(result.resume_snapshot.modules[0].content.text).toBe("原自我评价");
    expect((await read()).resume_snapshot.modules[0].content.text).toBe("原自我评价");
  });

  it("同岗位更新 JD 保持分组，显式新岗位允许使用相同 JD", async () => {
    const first = await diagnose({ jd: "原 JD", job_title: "岗位 A" });
    const next = await diagnose({ jd: "更新 JD", job_id: first.job_id });
    const other = await diagnose({ jd: "更新 JD", job_title: "岗位 B", new_job: true });
    expect(next.job_id).toBe(first.job_id);
    expect(next.previous.jd).toBe("原 JD");
    expect(other.job_id).not.toBe(first.job_id);
    expect(other.previous).toBeNull();
  });

  it("采纳状态持久化，校验实际保存文本，不能记录未保存的内容", async () => {
    const first = await diagnose({ jd: "JD" });
    const body = { diagnosis_id: first.id, module_key: "summary", suggestion_index: 0, value: "自定义采纳稿" };
    const rejected = await route.PATCH(request(body, "PATCH"), params);
    expect(rejected.status).toBe(409);
    expect((await read()).adoptions).toEqual([]);
    db.prepare("UPDATE resume_modules SET content = ? WHERE resume_id = 1").run(JSON.stringify({ text: body.value }));
    expect((await route.PATCH(request(body, "PATCH"), params)).status).toBe(200);
    expect((await route.PATCH(request(body, "PATCH"), params)).status).toBe(200);
    const saved = await read();
    expect(saved.adoptions).toHaveLength(1);
    expect(saved.adoptions[0]).toMatchObject({ moduleKey: "summary", suggestionIndex: 0, value: body.value });
    expect(saved.resume_snapshot.modules[0].content.text).toBe("原自我评价");
    expect(saved.report.modules[0].suggestions[0].draft).toBe("改进的自我评价");
  });

  it("拒绝跨简历访问或记录采纳，错误报告不产生历史", async () => {
    const first = await diagnose({ jd: "JD" });
    const otherParams = { params: Promise.resolve({ id: "2" }) };
    expect((await route.GET(new Request(`http://localhost/api/resumes/2/diagnose?diagnosis_id=${first.id}`), otherParams)).status).toBe(404);
    expect((await route.POST(request({ jd: "JD", job_id: first.job_id }), otherParams)).status).toBe(404);
    model.chat.mockResolvedValue("invalid json");
    expect((await route.POST(request({ jd: "新 JD" }), params)).status).toBe(502);
    expect((await read()).history).toHaveLength(1);
  });
});
