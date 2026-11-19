import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ResumeSnapshot } from "../resume-version-types";

const model = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock("@/lib/llm", async original => ({ ...await original<typeof import("@/lib/llm")>(), ...model }));
let directory: string;
let db: DatabaseSync;
let versionId: number;
let original: ResumeSnapshot;
const context = { params: Promise.resolve({ id: "1" }) };
const request = (version = versionId) => new Request("http://localhost/api/resumes/1/diagnose", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jd: "接口验证", resume_version_id: version }),
});
beforeEach(async () => {
  vi.resetModules(); model.chat.mockReset();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-diagnosis-archive-test-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'原简历','','')");
  db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,content,updated_at) VALUES (1,'work','work','工作',?,'')")
    .run(JSON.stringify([{ id: "w1", company: "甲公司", description: "仅参与接口校验，尚未上线。" }]));
  const version = (await import("../resume-versions")).publishResumeVersion(1, { name: "原版本" });
  versionId = version.id; original = version.snapshot;
  model.chat.mockResolvedValue(JSON.stringify({ match: 7, summary: "依据材料，未独立核实", modules: [{ module_key: "work",
    scores: { depth: 7, structure: 7, authenticity: 7, completeness: 7 }, gaps: "", suggestions: [] }] }));
});
afterEach(() => {
  db?.close(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-diagnosis-archive-test-")) throw new Error("Unsafe cleanup path");
  fs.rmSync(directory, { recursive: true, force: true });
});

it.each(["旧快照缺省字段", "基本身份容器损坏", "模块排序错误", "标题类型错误"])("%s 无法归档时先拒绝，不消耗模型或留下不可读诊断，发布修正版后可重试", async kind => {
  const source = structuredClone(original);
  if (kind === "旧快照缺省字段") source.modules[0]!.content = [{ company: "甲公司", description: "仅参与接口校验，尚未上线。" }] as never;
  if (kind === "基本身份容器损坏") source.modules.push({ key: "basic", type: "basic", label: "基本信息", sort: 1, content: null as never });
  if (kind === "模块排序错误") Reflect.set(source.modules[0]!, "sort", "0");
  if (kind === "标题类型错误") Reflect.set(source, "title", { text: "原简历" });
  db.prepare("UPDATE resume_versions SET snapshot=? WHERE id=?").run(JSON.stringify(source), versionId);
  const before = db.prepare("SELECT snapshot FROM resume_versions WHERE id=?").get(versionId);
  const route = await import("@/app/api/resumes/[id]/diagnose/route");
  const response = await route.POST(request(), context);
  expect.soft(response.status).toBe(422);
  expect.soft(await response.json()).toMatchObject({ error: expect.stringContaining("诊断快照") });
  expect.soft(model.chat).not.toHaveBeenCalled();
  expect.soft(db.prepare("SELECT COUNT(*) AS total FROM resume_diagnoses").get()).toEqual({ total: 0 });
  expect(db.prepare("SELECT snapshot FROM resume_versions WHERE id=?").get(versionId)).toEqual(before);
  if (response.status !== 422) return;
  const repaired = (await import("../resume-versions")).publishResumeVersion(1, { name: "重新发布完整版本" });
  const retried = await route.POST(request(repaired.id), context);
  expect(retried.status).toBe(200);
  const saved = await retried.json();
  expect(saved.report).not.toBeNull();
  expect(saved.corruptedFields).toBeUndefined();
  const reloaded = await route.GET(new Request(`http://localhost/api/resumes/1/diagnose?diagnosis_id=${saved.id}`), context);
  expect((await reloaded.json()).report).toEqual(saved.report);
  const { invalidDomainColumn } = await import("../backup-domain");
  expect(invalidDomainColumn("resume_diagnoses", db.prepare("SELECT * FROM resume_diagnoses WHERE id=?").get(saved.id)!)).toBeUndefined();
  expect(model.chat).toHaveBeenCalledOnce();
});

it("完整基本信息与诊断不保存的损坏排版不阻止归档，原文不被清洗且身份不外发", async () => {
  const { normalizeContent } = await import("../modules");
  const source = structuredClone(original);
  source.modules.push({ key: "basic", type: "basic", label: "基本信息", sort: 1, content: normalizeContent("basic", { name: "PRIVATE_NAME" }) });
  Reflect.set(source, "style_overrides", null);
  db.prepare("UPDATE resume_versions SET snapshot=? WHERE id=?").run(JSON.stringify(source), versionId);
  const route = await import("@/app/api/resumes/[id]/diagnose/route");
  const response = await route.POST(request(), context);
  expect(response.status).toBe(200);
  const saved = await response.json();
  expect(saved.report).not.toBeNull();
  expect(saved.resume_snapshot).toEqual({ title: source.title, modules: source.modules });
  expect(saved.corruptedFields).toBeUndefined();
  expect(JSON.stringify(model.chat.mock.calls[0]![1])).not.toContain("PRIVATE_NAME");
});
