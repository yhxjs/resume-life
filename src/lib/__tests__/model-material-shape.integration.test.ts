import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ResumeSnapshot } from "../resume-version-types";

const model = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock("@/lib/llm", async original => ({ ...await original<typeof import("@/lib/llm")>(), ...model }));
const PREFIX = "resume-life-model-material-shape-";
type Operation = "defense" | "diagnosis";
let directory: string;
let db: DatabaseSync;
let versionId: number;
let original: ResumeSnapshot;
const cases: [string, (snapshot: ResumeSnapshot) => void][] = [
  ["模块列表缺失", source => { Reflect.deleteProperty(source, "modules"); }],
  ["模块列表非数组", source => { Reflect.set(source, "modules", {}); }],
  ["模块项为 null", source => { Reflect.set(source.modules, 0, null); }],
  ["未知职业类型", source => { Reflect.set(source.modules[0]!, "type", "unknown"); }],
  ["经历容器为对象", source => { source.modules[0]!.content = {} as never; }],
  ["经历项为 null", source => { source.modules[0]!.content = [null] as never; }],
  ["正文为对象", source => { Reflect.set((source.modules[0]!.content as object[])[0]!, "description", { text: "未上线" }); }],
  ["分条混入非文本", source => { Reflect.set((source.modules[0]!.content as object[])[0]!, "descriptionItems", ["仅参与", 7]); }],
  ["副项容器损坏", source => { Reflect.set((source.modules[0]!.content as object[])[0]!, "subItems", {}); }],
  ["技能容器损坏", source => { source.modules.push({ key: "skills", type: "skills", label: "技能", sort: 1, content: { items: ["了解", 7] } as never }); }],
  ["自评容器损坏", source => { source.modules.push({ key: "summary", type: "summary", label: "自评", sort: 2, content: [] as never }); }],
];
beforeEach(async () => {
  vi.resetModules(); model.chat.mockReset();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'完整材料','','')");
  db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,content,updated_at) VALUES (1,'work','work','工作',?,'')")
    .run(JSON.stringify([{ id: "entry-1", company: "甲公司", description: "仅参与验证，尚未上线" }]));
  const version = (await import("../resume-versions")).publishResumeVersion(1, { name: "固定版" });
  versionId = version.id; original = version.snapshot;
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  db?.close(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(PREFIX)) throw new Error("Unsafe cleanup path");
  fs.rmSync(resolved, { recursive: true, force: true });
});
function store(source: ResumeSnapshot | string) {
  db.prepare("UPDATE resume_versions SET snapshot=? WHERE id=?").run(typeof source === "string" ? source : JSON.stringify(source), versionId);
}
function state() {
  return Object.fromEntries(["resumes", "resume_modules", "resume_versions", "resume_diagnoses", "resume_defenses", "application_preparation_resources"]
    .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
}
function reply(operation: Operation) {
  return operation === "defense" ? JSON.stringify({ risk_level: "low", overall_roast: "仅依据原材料判断", items: [] }) : JSON.stringify({
    match: 7, summary: "仅依据原材料判断", modules: original.modules.filter(module => module.type !== "basic")
      .map(module => ({ module_key: module.key, scores: { depth: 7, structure: 7, authenticity: 7, completeness: 7 }, gaps: "", suggestions: [] })),
  });
}
async function submit(operation: Operation) {
  const request = new Request("http://localhost/api/test", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(operation === "defense" ? { resumeId: 1, resumeVersionId: versionId } : { jd: "接口校验岗位", resume_version_id: versionId }),
  });
  return operation === "defense" ? (await import("@/app/api/tools/resume-defenses/route")).POST(request) :
    (await import("@/app/api/resumes/[id]/diagnose/route")).POST(request, { params: Promise.resolve({ id: "1" }) });
}
describe.each<Operation>(["defense", "diagnosis"])("%s 拒绝不完整的职业材料", operation => {
  it.each(cases)("初始%s，零调用零写入，修复后可重试", async (_name, corrupt) => {
    const source = structuredClone(original); corrupt(source); store(source);
    const before = state(); model.chat.mockResolvedValue(reply(operation));
    const response = await submit(operation);
    expect(response.status, await response.clone().text()).toBe(422);
    expect((await response.json()).error).toContain("材料损坏");
    expect(model.chat).not.toHaveBeenCalled(); expect(state()).toEqual(before);
    store(original);
    expect((await submit(operation)).status).toBe(200);
    expect(model.chat).toHaveBeenCalledOnce();
  });
  it.each(["{broken", "null"])("初始不可读快照 %s，零调用零写入", async source => {
    store(source); const before = state(); model.chat.mockResolvedValue(reply(operation));
    expect((await submit(operation)).status).toBe(422);
    expect(model.chat).not.toHaveBeenCalled(); expect(state()).toEqual(before);
  });
  it.each(["{broken", "null", "empty-to-corrupt"])("等待期间 %s 按冲突拒绝旧结果", async source => {
    if (source === "empty-to-corrupt") {
      original.modules[0]!.content = [];
      original.modules.push({ key: "summary", type: "summary", label: "简介", sort: 1,
        content: (await import("../modules")).normalizeContent("summary", { text: "仅参与验证" }) });
      store(original);
    }
    let changed: ReturnType<typeof state> | undefined;
    model.chat.mockImplementationOnce(async () => {
      const writer = new DatabaseSync(path.join(directory, "resume-life.db"));
      try {
        const corrupt = structuredClone(original);
        corrupt.modules[0]!.content = {} as never;
        writer.prepare("UPDATE resume_versions SET snapshot=? WHERE id=?")
          .run(source === "empty-to-corrupt" ? JSON.stringify(corrupt) : source, versionId);
      } finally { writer.close(); }
      changed = state(); return reply(operation);
    });
    const response = await submit(operation);
    expect(response.status, await response.clone().text()).toBe(409);
    expect(state()).toEqual(changed); expect(model.chat).toHaveBeenCalledOnce();
  });
  it("已选职业材料有效时，诊断另要求基本信息可原样归档，排雷不读取基本身份", async () => {
    const { normalizeContent } = await import("../modules");
    original.modules.push({ key: "basic", type: "basic", label: "身份", sort: 0,
      content: operation === "diagnosis" ? normalizeContent("basic", { name: "PRIVATE_NAME" }) : null as never });
    Reflect.set(original, "style_overrides", null); store(original);
    db.exec("UPDATE resume_modules SET content='{broken-draft'");
    model.chat.mockResolvedValueOnce(reply(operation));
    expect((await submit(operation)).status).toBe(200);
    expect(model.chat).toHaveBeenCalledOnce();
    expect(JSON.stringify(model.chat.mock.calls[0]![1])).toContain("尚未上线");
  });
});
it.each(cases)("共用模型读取拒绝发布材料%s", async (_name, corrupt) => {
  const source = structuredClone(original); corrupt(source); store(source);
  const { loadResumeContext } = await import("../resumes");
  expect(() => loadResumeContext(1, versionId)).toThrow("材料损坏");
});
it.each([{}, null, [null], [{ description: 7 }]])("草稿合法 JSON 的损坏形状 %j 不得经清洗变成空材料", async content => {
  db.prepare("UPDATE resume_modules SET content=?").run(JSON.stringify(content));
  const before = state();
  const { loadResume, loadResumeContext } = await import("../resumes");
  expect(loadResume(1)).not.toBeNull();
  expect(() => loadResumeContext(1)).toThrow("材料损坏");
  expect(state()).toEqual(before);
});
it("旧快照省略可选正文、分条、副项和样式时仍可读取，保留原存储", async () => {
  original.modules[0]!.content = [{ company: "旧公司", description: "仅参与验证" }] as never;
  original.modules.push(
    { key: "education", type: "education", label: "教育", sort: 1, content: [{}] as never },
    { key: "projects", type: "projects", label: "项目", sort: 2, content: [] },
    { key: "custom", type: "custom", label: "自定义", sort: 3, content: [{}] as never },
    { key: "skills", type: "skills", label: "技能", sort: 4, content: {} as never },
    { key: "summary", type: "summary", label: "自评", sort: 5, content: {} as never },
  );
  Reflect.deleteProperty(original, "style_overrides"); store(original);
  const before = state(); const { loadResumeForModel, loadResumeContext } = await import("../resumes");
  expect(loadResumeForModel(1, versionId)!.modules).toEqual(original.modules);
  expect(loadResumeContext(1, versionId)).toContain("仅参与验证");
  expect(state()).toEqual(before);
});
