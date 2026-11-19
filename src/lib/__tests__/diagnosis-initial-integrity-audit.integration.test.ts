import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const model = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock("@/lib/llm", async original => ({ ...await original<typeof import("@/lib/llm")>(), ...model }));

const PREFIX = "resume-life-diagnosis-initial-integrity-";
let directory: string;
let db: DatabaseSync;
let versionId: number;

const request = () => new Request("http://localhost/api/resumes/1/diagnose", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jd: "接口校验岗位", resume_version_id: versionId }),
});

beforeEach(async () => {
  vi.resetModules();
  model.chat.mockReset().mockResolvedValue(JSON.stringify({
    match: 7,
    summary: "依据已提供的材料",
    modules: [{ module_key: "work", scores: { depth: 7, structure: 7, authenticity: 7, completeness: 7 }, gaps: "", suggestions: [] }],
  }));
  directory = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'合成简历','','')");
  db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,content,updated_at) VALUES (1,'work','work','工作',?,'')")
    .run(JSON.stringify([{ id: "entry-1", company: "甲公司", title: "工程师", description: "参与接口校验" }]));
  versionId = (await import("../resume-versions")).publishResumeVersion(1, { name: "合成版本" }).id;
});

afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(PREFIX)) throw new Error("Unsafe cleanup path");
  fs.rmSync(resolved, { recursive: true, force: true });
});

function corruptSnapshot(snapshot: string) {
  db.prepare("UPDATE resume_versions SET snapshot=? WHERE id=?").run(snapshot, versionId);
}

async function diagnose() {
  return (await import("@/app/api/resumes/[id]/diagnose/route")).POST(request(), { params: Promise.resolve({ id: "1" }) });
}

it.each(["{broken", "null"])("发布快照为 %j 时在调用模型前返回材料损坏错误，不写入诊断", async snapshot => {
  corruptSnapshot(snapshot);
  const response = await diagnose();
  expect(response.status).toBe(422);
  expect((await response.json()).error).toContain("损坏");
  expect(model.chat).not.toHaveBeenCalled();
  expect(db.prepare("SELECT COUNT(*) AS total FROM resume_diagnoses").get()?.total).toBe(0);
});

it("发布快照缺少 modules 时返回材料损坏错误，不把非数组当作空材料", async () => {
  corruptSnapshot(JSON.stringify({ title: "合成版本", template: "classic", modules: null }));
  const response = await diagnose();
  expect(response.status).toBe(422);
  expect((await response.json()).error).toContain("损坏");
  expect(model.chat).not.toHaveBeenCalled();
  expect(db.prepare("SELECT COUNT(*) AS total FROM resume_diagnoses").get()?.total).toBe(0);
});
