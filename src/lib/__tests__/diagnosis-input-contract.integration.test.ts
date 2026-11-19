import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const model = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock("@/lib/llm", async original => ({ ...await original<typeof import("@/lib/llm")>(), ...model }));

let directory: string;
let db: DatabaseSync;
let generation: string | null;
const context = { params: Promise.resolve({ id: "1" }) };

function request(endpoint: string, method: string, body: unknown) {
  return new Request(`http://localhost/api/resumes/1${endpoint}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "sec-fetch-site": "same-origin",
      "X-Resume-Life-Data-Generation": generation ?? "initial",
    },
    body: JSON.stringify(body),
  });
}

function output(moduleKey?: string) {
  return JSON.stringify({
    match: moduleKey ? 5 : 0,
    summary: moduleKey ? "根据所提供的职业材料评分，事实尚未独立核实。" : "没有职业模块，无法判断岗位匹配情况。",
    modules: moduleKey ? [{
      module_key: moduleKey,
      scores: { depth: 5, structure: 5, authenticity: 5, completeness: 5 },
      gaps: "", suggestions: [],
    }] : [],
  });
}

async function patch(body: Record<string, unknown>) {
  const response = await (await import("@/app/api/resumes/[id]/route")).PATCH(
    request("", "PATCH", { ...body, dataGeneration: generation }), context,
  );
  expect(response.status).toBe(200);
  return response.json();
}

async function publish() {
  const current = (await import("../resumes")).loadResume(1)!;
  const response = await (await import("@/app/api/resumes/[id]/versions/route")).POST(
    request("/versions", "POST", { name: "当前合法发布版", draft_revision: current.resume.draftRevision }), context,
  );
  expect(response.status).toBe(201);
  return (await response.json() as { id: number }).id;
}

async function diagnose(versionId: number) {
  return (await import("@/app/api/resumes/[id]/diagnose/route")).POST(
    request("/diagnose", "POST", { jd: "接口测试", resume_version_id: versionId }), context,
  );
}

function state() {
  return Object.fromEntries(["resumes", "resume_modules", "resume_versions", "resume_diagnoses"].map(table =>
    [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
}

async function removeOccupationalModules(removeBasic: boolean) {
  await patch({ removeModule: "summary" });
  if (removeBasic) await patch({ removeModule: "basic" });
  return publish();
}

beforeEach(async () => {
  vi.resetModules(); model.chat.mockReset();
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network request"); }));
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-diagnosis-input-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  const database = await import("../db");
  db = database.getDb(); generation = database.dataGeneration(db);
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'职业材料输入测试','','')");
  const { normalizeContent } = await import("../modules");
  const insert = db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,content,updated_at) VALUES (1,?,?,?,?,'')");
  insert.run("basic", "basic", "基本信息", JSON.stringify(normalizeContent("basic", { name: "合成用户" })));
  insert.run("summary", "summary", "自我评价", JSON.stringify(normalizeContent("summary", { text: "仅参与接口测试，尚未上线。" })));
  // 先经正式发布和诊断入口建立历史，后续拒绝必须保留它。
  model.chat.mockResolvedValue(output("summary"));
  expect((await diagnose(await publish())).status).toBe(200);
  model.chat.mockReset();
});

afterEach(() => {
  db.close(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-diagnosis-input-")) {
    throw new Error("Unsafe cleanup path");
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("诊断职业模块输入契约", () => {
  it.each([
    ["仅保留基本信息", false], ["删除所有模块", true],
  ] as const)("真实删除并发布后，%s 在调用模型前返回 422，保留原稿、版本和诊断历史", async (_name, removeBasic) => {
    const versionId = await removeOccupationalModules(removeBasic);
    const before = state();
    expect(before.resume_diagnoses).toHaveLength(1);
    model.chat.mockResolvedValue(output());

    const response = await diagnose(versionId);

    expect.soft(response.status).toBe(422);
    expect.soft((await response.json()).error).toMatch(/职业模块.*重新发布/);
    expect.soft(model.chat).not.toHaveBeenCalled();
    expect(state()).toEqual(before);
  });

  it.each([
    ["仅保留基本信息", false], ["删除所有模块", true],
  ] as const)("%s 后补充职业模块并重新发布，可正常重试且保留旧诊断", async (_name, removeBasic) => {
    const emptyVersionId = await removeOccupationalModules(removeBasic);
    const history = state().resume_diagnoses;
    model.chat.mockResolvedValue(output());
    expect((await diagnose(emptyVersionId)).status).toBe(422);

    const added = await patch({ addModule: { type: "summary", label: "补充职业材料" } });
    const current = (await import("../resumes")).loadResume(1)!.modules.find(module => module.key === added.addedKey)!;
    await patch({
      modules: { [current.key]: { text: "仅参与接口测试，尚未上线。" } },
      moduleRevisions: { [current.key]: current.revision },
    });
    // 修改草稿不能改变被选中的旧版本，必须明确重新发布。
    expect((await diagnose(emptyVersionId)).status).toBe(422);
    expect(model.chat).not.toHaveBeenCalled();

    const repairedVersionId = await publish();
    model.chat.mockResolvedValue(output(current.key));
    const response = await diagnose(repairedVersionId);
    expect(response.status).toBe(200);
    expect((await response.json()).resume_version_id).toBe(repairedVersionId);
    expect(model.chat).toHaveBeenCalledOnce();
    const savedHistory = state().resume_diagnoses!;
    expect(savedHistory).toHaveLength(2);
    expect(savedHistory.slice(0, 1)).toEqual(history);
  });

  it.each(["summary", "skills"] as const)("保留内容为空的 %s 职业模块仍允许诊断评分", async type => {
    await patch({ removeModule: "summary" });
    const added = await patch({ addModule: { type, label: "待完善的职业模块" } });
    const current = (await import("../resumes")).loadResume(1)!.modules.find(module => module.key === added.addedKey)!;
    expect(current.content).toMatchObject(type === "summary" ? { text: "" } : { items: [] });
    const versionId = await publish();
    const before = state();
    model.chat.mockResolvedValue(output(current.key));

    const response = await diagnose(versionId);

    expect(response.status).toBe(200);
    const saved = await response.json();
    expect(saved.report.modules).toHaveLength(1);
    expect(saved.report.modules[0].moduleKey).toBe(current.key);
    expect(model.chat).toHaveBeenCalledOnce();
    const after = state();
    expect(after.resume_diagnoses).toHaveLength(2);
    expect(after.resume_diagnoses!.slice(0, 1)).toEqual(before.resume_diagnoses);
    expect({ ...after, resume_diagnoses: [] }).toEqual({ ...before, resume_diagnoses: [] });
  });
});
