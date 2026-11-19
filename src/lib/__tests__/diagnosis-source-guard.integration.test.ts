import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ResumeSnapshot } from "../resume-version-types";
import { wrapUntrustedData } from "../prompt-safety";

const model = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock("@/lib/llm", async original => ({ ...await original<typeof import("@/lib/llm")>(), ...model }));
const PREFIX = "resume-life-diagnosis-source-";
let directory: string;
let db: DatabaseSync;
let versionId: number;
let otherVersion: number;
let applicationId: number;

function snapshot(id = versionId): ResumeSnapshot {
  return JSON.parse(db.prepare("SELECT snapshot FROM resume_versions WHERE id=?").get(id)!.snapshot as string);
}
function work(source: ResumeSnapshot) {
  return (source.modules[0]!.content as Record<string, unknown>[])[0]!;
}
function output(source = snapshot()) {
  return JSON.stringify({ match: 7, summary: "根据所选材料诊断，未核验真实性", modules: source.modules.filter(item => item.type !== "basic").map(item => ({
    module_key: item.key, scores: { depth: 7, structure: 7, authenticity: 7, completeness: 7 }, gaps: "",
    suggestions: [{ item_id: (item.content as { id: string }[])[0]!.id, field: "description", reason: "保留个人分工", draft: "仅参与接口校验，尚未上线。" }],
  })) });
}
async function diagnose(extra: Record<string, unknown> = {}) {
  return (await import("@/app/api/resumes/[id]/diagnose/route")).POST(new Request("http://localhost/api/resumes/1/diagnose", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jd: "接口校验岗位", resume_version_id: versionId, ...extra }),
  }), { params: Promise.resolve({ id: "1" }) });
}
function state() {
  return Object.fromEntries(["resumes", "resume_modules", "resume_versions", "resume_diagnoses", "applications", "application_preparation_resources", "runtime_state"]
    .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
}
function writerChange(mutate: (writer: DatabaseSync) => void) {
  const writer = new DatabaseSync(path.join(directory, "resume-life.db"));
  try { writer.exec("PRAGMA foreign_keys = ON"); mutate(writer); }
  finally { writer.close(); }
  return state();
}
function changeSnapshot(writer: DatabaseSync, id: number, mutate: (source: ResumeSnapshot) => void) {
  const source = JSON.parse(writer.prepare("SELECT snapshot FROM resume_versions WHERE id=?").get(id)!.snapshot as string) as ResumeSnapshot;
  mutate(source);
  writer.prepare("UPDATE resume_versions SET snapshot=? WHERE id=?").run(JSON.stringify(source), id);
}
async function pause(extra: Record<string, unknown> = {}) {
  const reply = output();
  const entered = Promise.withResolvers<void>();
  const completion = Promise.withResolvers<string>();
  model.chat.mockImplementationOnce(() => { entered.resolve(); return completion.promise; });
  const response = diagnose(extra);
  await entered.promise;
  return { response, release: () => completion.resolve(reply) };
}

beforeEach(async () => {
  vi.resetModules(); model.chat.mockReset();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'原诊断来源','',''),(2,'其他简历','','')");
  db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,content,updated_at) VALUES (1,'work','work','工作',?,'')")
    .run(JSON.stringify([{ id: "work-entry", company: "甲 | 工程", title: "维护", description: "参与接口校验，尚未上线。" }]));
  const { publishResumeVersion } = await import("../resume-versions");
  versionId = publishResumeVersion(1, { name: "原诊断版本" }).id;
  otherVersion = publishResumeVersion(1, { name: "另一个版本" }).id;
  applicationId = (await import("../applications")).createApplication({ company: "合成公司", role: "接口校验", jd: "接口校验岗位", resume_id: 1, resume_version_id: versionId }).id;
  model.chat.mockResolvedValueOnce(output());
  expect((await diagnose()).status).toBe(200);
  model.chat.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  db?.close(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(PREFIX)) throw new Error("Unsafe cleanup path");
  fs.rmSync(resolved, { recursive: true, force: true });
});

describe("诊断生成的来源与建议目标复核", () => {
  it.each(["正文", "条目 ID", "模块 key", "字段归属"].flatMap(change => [false, true].map(linked => ({ change, linked }))))(
    "$change 变化，投递关联 $linked 时拒绝旧诊断，显式重试读取新来源", async ({ change, linked }) => {
      const extra = linked ? { application_id: applicationId } : {};
      const pending = await pause(extra);
      try {
        const afterChange = writerChange(writer => changeSnapshot(writer, versionId, source => {
          if (change === "正文") work(source).description = "改为文档核对，尚未验证";
          if (change === "条目 ID") work(source).id = "replacement-entry";
          if (change === "模块 key") source.modules[0]!.key = "mod_replacement";
          if (change === "字段归属") { work(source).company = "甲"; work(source).title = "工程 | 维护"; }
        }));
        pending.release();
        const rejected = await pending.response;
        expect(rejected.status).toBe(409);
        expect(await rejected.json()).toMatchObject({ error: expect.stringContaining("重新诊断") });
        expect(state()).toEqual(afterChange);
        model.chat.mockResolvedValueOnce(output());
        const retried = await diagnose(extra);
        expect(retried.status).toBe(200);
        const saved = await retried.json();
        expect(saved.report).not.toBeNull();
        expect(saved.report.modules[0]).toMatchObject({ moduleKey: snapshot().modules[0]!.key, suggestions: [{ itemId: work(snapshot()).id }] });
        expect(saved.resume_snapshot.modules).toEqual(snapshot().modules);
        const { sanitizeModulesForDiagnosis } = await import("../diagnosis");
        expect(model.chat.mock.calls[1]![1][1].content).toContain(wrapUntrustedData("candidate_resume_modules", JSON.stringify(sanitizeModulesForDiagnosis(snapshot().modules))));
        const after = state();
        expect(after.resume_diagnoses!.slice(0, -1)).toEqual(afterChange.resume_diagnoses);
        expect(after.application_preparation_resources).toHaveLength(linked ? 1 : 0);
        for (const table of ["resumes", "resume_modules", "resume_versions", "applications"]) expect(after[table]).toEqual(afterChange[table]);
        expect(model.chat).toHaveBeenCalledTimes(2);
      } finally { pending.release(); await pending.response; }
    },
  );

  it.each(["删除版本", "版本归属变化", "删除简历"].flatMap(change => [false, true].map(linked => ({ change, linked }))))(
    "$change、投递关联 $linked 时拒绝失效来源，不保存或关联报告", async ({ change, linked }) => {
      const pending = await pause(linked ? { application_id: applicationId } : {});
      try {
        const afterChange = writerChange(writer => {
          if (change === "删除版本") writer.prepare("DELETE FROM resume_versions WHERE id=?").run(versionId);
          if (change === "版本归属变化") writer.prepare("UPDATE resume_versions SET resume_id=2 WHERE id=?").run(versionId);
          if (change === "删除简历") writer.exec("DELETE FROM resumes WHERE id=1");
        });
        pending.release();
        const rejected = await pending.response;
        expect(rejected.status).toBe(409);
        expect(await rejected.json()).toMatchObject({ error: expect.stringContaining("重新诊断") });
        expect(state()).toEqual(afterChange);
      } finally { pending.release(); await pending.response; }
    },
  );

  it.each(["草稿", "其他版本", "基本身份", "键顺序", "等值正文格式", "标题与排版"])("%s 变化不影响职业评估输入，旧报告快照完整保留", async change => {
    const original = snapshot();
    const pending = await pause({ application_id: applicationId });
    try {
      const afterChange = writerChange(writer => {
        if (change === "草稿") writer.prepare("UPDATE resume_modules SET content=? WHERE resume_id=1").run(JSON.stringify([{ company: "新草稿公司" }]));
        if (change === "其他版本") changeSnapshot(writer, otherVersion, source => { work(source).company = "另一公司"; });
        if (change === "基本身份") changeSnapshot(writer, versionId, source => { source.modules.push({ key: "basic", type: "basic", label: "身份", sort: 0, content: { name: "私人姓名不外发" } }); });
        if (change === "键顺序") changeSnapshot(writer, versionId, source => { source.modules[0]!.content = [Object.fromEntries(Object.entries(work(source)).reverse())]; });
        if (change === "等值正文格式") changeSnapshot(writer, versionId, source => { work(source).description = `<strong>${work(source).description}</strong>`; });
        if (change === "标题与排版") changeSnapshot(writer, versionId, source => { source.title = "新标题"; source.template = "modern"; });
      });
      pending.release();
      const response = await pending.response;
      expect(response.status).toBe(200);
      const saved = await response.json();
      expect(saved.resume_snapshot).toEqual({ title: original.title, modules: original.modules });
      expect(saved.resume_version_id).toBe(versionId);
      expect(state().resume_diagnoses!.slice(0, -1)).toEqual(afterChange.resume_diagnoses);
      expect(state().application_preparation_resources).toHaveLength(1);
      expect(state().resume_versions).toEqual(afterChange.resume_versions);
    } finally { pending.release(); await pending.response; }
  });

  it("自动选择最新版本后，后来发布不更换本次来源", async () => {
    const pending = await pause({ resume_version_id: undefined });
    try {
      (await import("../resume-versions")).publishResumeVersion(1, { name: "后来发布" });
      pending.release();
      const response = await pending.response;
      expect(response.status).toBe(200);
      expect((await response.json()).resume_version_id).toBe(otherVersion);
    } finally { pending.release(); await pending.response; }
  });

  it.each(["JD", "删除投递", "恢复世代"])("%s 变化仍保留原有拒绝行为", async change => {
    const pending = await pause({ application_id: applicationId });
    try {
      const afterChange = writerChange(writer => {
        if (change === "JD") writer.prepare("UPDATE applications SET jd='另一岗位' WHERE id=?").run(applicationId);
        if (change === "删除投递") writer.prepare("DELETE FROM applications WHERE id=?").run(applicationId);
        if (change === "恢复世代") writer.exec("INSERT INTO runtime_state (id,data_generation) VALUES (1,'diagnosis-restored') ON CONFLICT(id) DO UPDATE SET data_generation=excluded.data_generation");
      });
      pending.release();
      const response = await pending.response;
      expect(response.status).toBe(change === "删除投递" ? 404 : 409);
      expect(state()).toEqual(afterChange);
    } finally { pending.release(); await pending.response; }
  });
});
