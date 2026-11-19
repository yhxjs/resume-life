import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModuleKey } from "../modules";

const model = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock("@/lib/llm", async original => ({ ...await original<typeof import("@/lib/llm")>(), ...model }));

let directory: string;
let db: DatabaseSync;
const context = { params: Promise.resolve({ id: "1" }) };
const request = (method: string, body: unknown) => new Request("http://localhost/api/resumes/1", {
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const entry = (type: ModuleKey, id: string, name: string) => ({
  id, ...(type === "education" ? { school: name } : type === "work" ? { company: name } : type === "projects" ? { name } : { title: name }),
  description: `${name}的原始职责，尚未上线。`,
});

beforeEach(async () => {
  vi.resetModules(); model.chat.mockReset();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-diagnosis-target-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'目标唯一性测试','','')");
  await setContent("work", [entry("work", "entry-1", "甲")]);
});

afterEach(() => {
  db.close(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-diagnosis-target-")) throw new Error("Unsafe cleanup path");
  fs.rmSync(directory, { recursive: true, force: true });
});

async function setContent(type: ModuleKey, content: unknown) {
  const { normalizeContent } = await import("../modules");
  db.prepare(`INSERT INTO resume_modules (resume_id,module_key,type,label,content,updated_at) VALUES (1,'target',?,'目标模块',?,'')
    ON CONFLICT(resume_id,module_key) DO UPDATE SET type=excluded.type,content=excluded.content`)
    .run(type, JSON.stringify(normalizeContent(type, content)));
}

async function currentModule() {
  return (await import("../resumes")).loadResume(1)!.modules[0]!;
}

async function patch(content: unknown) {
  const current = await currentModule();
  return (await import("@/app/api/resumes/[id]/route")).PATCH(request("PATCH", {
    modules: { target: content }, moduleRevisions: { target: current.revision },
  }), context);
}

function state() {
  return Object.fromEntries(["resumes", "resume_modules", "resume_versions", "resume_diagnoses"].map(table =>
    [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
}

function output(itemId = "entry-1") {
  return JSON.stringify({ match: 7, summary: "依据明确的原始分工", modules: [{
    module_key: "target", scores: { depth: 7, structure: 7, authenticity: 7, completeness: 7 }, gaps: "",
    suggestions: [{ item_id: itemId, field: "description", reason: "明确甲的工作范围", draft: "仅参与甲的接口校验，尚未上线。" }],
  }] });
}

async function diagnose(versionId: number) {
  return (await import("@/app/api/resumes/[id]/diagnose/route")).POST(request("POST", { jd: "接口校验", resume_version_id: versionId }), context);
}

describe("简历条目目标必须唯一", () => {
  it.each(["work", "projects", "education", "custom"] as const)("PATCH 拒绝 %s 中重复显式 ID，保留原稿和修订", async type => {
    await setContent(type, [entry(type, "entry-1", "甲")]);
    const before = state();
    const response = await patch([entry(type, "entry-1", "甲"), entry(type, "entry-1", "乙")]);
    expect(response.status).toBe(400);
    expect(state()).toEqual(before);
  });

  it.each(["work", "projects", "custom"] as const)("PATCH 拒绝 %s 同一条目中的重复副项 ID", async type => {
    await setContent(type, [entry(type, "entry-1", "甲")]);
    const before = state();
    const response = await patch([{ ...entry(type, "entry-1", "甲"), subItems: [
      { id: "field-1", label: "分工", value: "接口校验" }, { id: "field-1", label: "进度", value: "未上线" },
    ] }]);
    expect(response.status).toBe(400);
    expect(state()).toEqual(before);
  });

  it("缺省或空 ID 仍可创建独立条目，同一副项 ID 在不同条目下互不冲突", async () => {
    const content = [{ ...entry("work", "", "甲"), subItems: [{ id: "field-1", label: "进度", value: "未上线" }] },
      { company: "乙", description: "仅维护文档。", subItems: [{ id: "field-1", label: "分工", value: "文档" }] }];
    const before = structuredClone(content);
    expect((await patch(content)).status).toBe(200);
    const stored = (await currentModule()).content as { id: string; company: string; subItems: { id: string }[] }[];
    expect(stored.map(item => item.company)).toEqual(["甲", "乙"]);
    expect(new Set(stored.map(item => item.id)).size).toBe(2);
    expect(stored.every(item => Boolean(item.id))).toBe(true);
    expect(stored.map(item => item.subItems[0]!.id)).toEqual(["field-1", "field-1"]);
    expect(content).toEqual(before);
  });

  it.each(["work", "projects", "education"] as const)("%s 显式修正重复 ID 后可发布诊断，仅采纳目标条目", async type => {
    await setContent(type, [entry(type, "entry-1", "甲")]);
    const duplicate = [entry(type, "entry-1", "甲"), entry(type, "entry-1", "乙")];
    expect((await patch(duplicate)).status).toBe(400);
    expect((await patch([duplicate[0], { ...duplicate[1], id: "entry-2" }])).status).toBe(200);
    const version = (await import("../resume-versions")).publishResumeVersion(1, { name: "目标已区分" });
    model.chat.mockResolvedValue(output());
    const response = await diagnose(version.id);
    expect(response.status).toBe(200);
    const saved = await response.json();
    const suggestion = saved.report.modules[0].suggestions[0];
    const current = await currentModule();
    const { writeDiagnosisValue } = await import("../module-descriptions");
    const next = writeDiagnosisValue(type, current.content, suggestion.itemId, suggestion.draft);
    expect((await patch(next)).status).toBe(200);
    const stored = (await currentModule()).content as { description: string }[];
    expect(stored[0]!.description).toBe(suggestion.draft);
    expect(stored[1]!.description).toBe("乙的原始职责，尚未上线。");
    const recorded = await (await import("@/app/api/resumes/[id]/diagnose/route")).PATCH(request("PATCH", {
      diagnosis_id: saved.id, module_key: "target", suggestion_index: 0, value: suggestion.draft,
    }), context);
    expect(recorded.status).toBe(200);
    expect((await recorded.json()).adoptions).toHaveLength(1);
  });

  it.each(["work", "projects", "education"] as const)("旧 %s 发布快照有重复 ID 时不保存含歧义目标的模型报告", async type => {
    await setContent(type, [entry(type, "entry-1", "甲"), entry(type, "entry-1", "乙")]);
    const version = (await import("../resume-versions")).publishResumeVersion(1, { name: "旧重复目标" });
    const before = state();
    model.chat.mockResolvedValue(output());
    const response = await diagnose(version.id);
    expect(response.status).toBe(502);
    expect(state()).toEqual(before);
    expect(model.chat).toHaveBeenCalledOnce();
  });

  it.each(["work", "projects", "education"] as const)("旧 %s 草稿目标变得重复时不改写任何条目或记录采纳", async type => {
    await setContent(type, [entry(type, "entry-1", "甲")]);
    const version = (await import("../resume-versions")).publishResumeVersion(1, { name: "原唯一目标" });
    model.chat.mockResolvedValue(output());
    const response = await diagnose(version.id);
    expect(response.status).toBe(200);
    const saved = await response.json();
    await setContent(type, [entry(type, "entry-1", "甲"), entry(type, "entry-1", "乙")]);
    const before = state();
    const current = await currentModule();
    const original = structuredClone(current);
    const suggestion = saved.report.modules[0].suggestions[0];
    const { diagnosisValue } = await import("../diagnosis");
    const { writeDiagnosisValue } = await import("../module-descriptions");
    expect(diagnosisValue([current], "target", suggestion)).toBeNull();
    expect(writeDiagnosisValue(type, current.content, suggestion.itemId, suggestion.draft)).toBeNull();
    expect(current).toEqual(original);
    const adoption = await (await import("@/app/api/resumes/[id]/diagnose/route")).PATCH(request("PATCH", {
      diagnosis_id: saved.id, module_key: "target", suggestion_index: 0, value: suggestion.draft,
    }), context);
    expect(adoption.status).toBe(409);
    expect(state()).toEqual(before);
  });
});
