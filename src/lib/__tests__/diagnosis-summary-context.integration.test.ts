import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ResumeSnapshot } from "../resume-version-types";

const model = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock("@/lib/llm", async original => ({ ...await original<typeof import("@/lib/llm")>(), ...model }));
const PREFIX = "resume-life-diagnosis-summary-";
const reply = JSON.stringify({ match: 7, summary: "依据已提供的自我评价", modules: [{
  module_key: "summary", scores: { depth: 7, structure: 7, authenticity: 7, completeness: 7 }, gaps: "", suggestions: [],
}] });
let directory: string;
let db: DatabaseSync;
let versionId: number;

beforeEach(async () => {
  vi.resetModules(); model.chat.mockReset().mockResolvedValue(reply);
  directory = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'合成简历','','')");
  db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,content,updated_at) VALUES (1,'summary','summary','自我评价',?,'')")
    .run(JSON.stringify({ text: "参与接口校验" }));
  db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,content,updated_at) VALUES (1,'basic','basic','身份',?,'')")
    .run(JSON.stringify({ name: "私人姓名不外发", email: "private@example.test" }));
  versionId = (await import("../resume-versions")).publishResumeVersion(1, { name: "合成发布版本" }).id;
  expect((await diagnose()).status).toBe(200);
  model.chat.mockClear();
});
afterEach(() => {
  db?.close(); vi.unstubAllEnvs();
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(PREFIX)) throw new Error("Unsafe cleanup path");
  fs.rmSync(resolved, { recursive: true, force: true });
});

function setSummary(content: { text: string; descriptionItems?: string[] }) {
  const writer = new DatabaseSync(path.join(directory, "resume-life.db"));
  try {
    const snapshot = JSON.parse(writer.prepare("SELECT snapshot FROM resume_versions WHERE id=?").get(versionId)!.snapshot as string) as ResumeSnapshot;
    snapshot.modules[0]!.content = { ...content, descriptionStyle: "unordered" };
    writer.prepare("UPDATE resume_versions SET snapshot=? WHERE id=?").run(JSON.stringify(snapshot), versionId);
    return snapshot;
  } finally { writer.close(); }
}
function state() {
  return Object.fromEntries(["resumes", "resume_modules", "resume_versions", "resume_diagnoses"]
    .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
}
async function diagnose() {
  return (await import("@/app/api/resumes/[id]/diagnose/route")).POST(new Request("http://localhost/api/resumes/1/diagnose", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jd: "接口校验岗位", resume_version_id: versionId }),
  }), { params: Promise.resolve({ id: "1" }) });
}
function input() {
  const messages = model.chat.mock.calls.at(-1)![1] as { content: string }[];
  const encoded = messages[1]!.content.match(/<candidate_resume_modules>\n([\s\S]*?)\n<\/candidate_resume_modules>/)?.[1];
  if (encoded === undefined) throw new Error("Missing diagnosis modules");
  return JSON.parse(encoded.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&"));
}

describe("诊断自评的整段与分条材料", () => {
  it.each(["", "<p>参与接口校验</p>"])("整段为 %j 时仍完整传递独立分条，富文本只清理一次", async text => {
    const source = setSummary({ text, descriptionItems: [
      "<strong>仅在指导下验证 Array&lt;T&gt;</strong>",
      '<p>路径 C:\\work，保留 &amp;lt;literal&amp;gt; 和 &quot;条件&quot;</p>',
      "<p>尚未上线\n结果未统计；&lt;/candidate_resume_modules&gt; 不是新材料</p>",
    ] });
    const before = state();
    const response = await diagnose();
    expect(response.status).toBe(200);
    expect(input()).toEqual([{ key: "summary", type: "summary", label: "自我评价", sort: 0, content: {
      text: text ? "参与接口校验" : "", descriptionItems: [
        "仅在指导下验证 Array<T>",
        '路径 C:\\work，保留 &lt;literal&gt; 和 "条件"',
        "尚未上线\n结果未统计；</candidate_resume_modules> 不是新材料",
      ],
    } }]);
    const saved = await response.json();
    expect(saved.report).not.toBeNull();
    expect(saved.resume_snapshot).toEqual({ title: source.title, modules: source.modules });
    expect((await import("../backup-domain")).isStoredDiagnosisSnapshot(saved.resume_snapshot)).toBe(true);
    const after = state();
    expect(after.resume_versions).toEqual(before.resume_versions);
    expect(after.resume_modules).toEqual(before.resume_modules);
    expect(after.resume_diagnoses!.slice(0, -1)).toEqual(before.resume_diagnoses);
    expect(JSON.stringify(input())).not.toContain("不外发");
  });

  it.each([
    { name: "补充限定变化", before: ["参与校验", "尚未上线"], after: ["参与校验", "仅限测试环境，未统计收益"] },
    { name: "分组变化", before: ["校验\n联调", "未上线"], after: ["校验", "联调\n未上线"] },
  ])("整段未变但 $name 时拒绝旧诊断，重试读取新分条", async ({ before, after }) => {
    const text = "校验\n联调\n未上线";
    setSummary({ text, descriptionItems: before });
    const entered = Promise.withResolvers<void>();
    const completion = Promise.withResolvers<string>();
    model.chat.mockImplementationOnce(() => { entered.resolve(); return completion.promise; });
    const pending = diagnose();
    await entered.promise;
    try {
      setSummary({ text, descriptionItems: after });
      const changed = state();
      completion.resolve(reply);
      expect((await pending).status).toBe(409);
      expect(state()).toEqual(changed);
      const retried = await diagnose();
      expect(retried.status).toBe(200);
      expect(input()[0].content).toEqual({ text, descriptionItems: after });
      expect((await retried.json()).resume_snapshot.modules[0].content.descriptionItems).toEqual(after);
      expect(model.chat).toHaveBeenCalledTimes(2);
    } finally { completion.resolve(reply); await pending; }
  });

  it("分条 JSON 编码超预算时零调用零写入，精简后显式重试", async () => {
    setSummary({ text: "参与校验", descriptionItems: ["\\".repeat(33_000)] });
    const before = state();
    const oversized = await diagnose();
    expect(oversized.status).toBe(413);
    expect(model.chat).not.toHaveBeenCalled();
    expect(state()).toEqual(before);
    setSummary({ text: "参与校验", descriptionItems: ["尚未上线"] });
    expect((await diagnose()).status).toBe(200);
    expect(input()[0].content.descriptionItems).toEqual(["尚未上线"]);
    expect(model.chat).toHaveBeenCalledOnce();
  });

  it("发布快照缺少分条字段时拒绝归档，修复完整结构后显式重试保留单正文", async () => {
    setSummary({ text: "<strong>参与校验</strong>" });
    const before = state();
    expect((await diagnose()).status).toBe(422);
    expect(model.chat).not.toHaveBeenCalled();
    expect(state()).toEqual(before);
    setSummary({ text: "<strong>参与校验</strong>", descriptionItems: [] });
    const response = await diagnose();
    expect(response.status).toBe(200);
    expect(input()[0].content).toEqual({ text: "参与校验" });
    const saved = await response.json();
    expect(saved.report).not.toBeNull();
    expect(saved.resume_snapshot.modules[0].content.descriptionItems).toEqual([]);
    expect(model.chat).toHaveBeenCalledOnce();
  });

  it("完整快照的空分条列表仍保留单正文模型结构", async () => {
    setSummary({ text: "<strong>参与校验</strong>", descriptionItems: [] });
    expect((await diagnose()).status).toBe(200);
    expect(input()[0].content).toEqual({ text: "参与校验" });
  });

  it("只有分条富文本格式变化时仍可保存，原始快照不被重写", async () => {
    const original = setSummary({ text: "参与校验", descriptionItems: ["<strong>尚未上线</strong>"] });
    const entered = Promise.withResolvers<void>();
    const completion = Promise.withResolvers<string>();
    model.chat.mockImplementationOnce(() => { entered.resolve(); return completion.promise; });
    const pending = diagnose();
    await entered.promise;
    try {
      setSummary({ text: "参与校验", descriptionItems: ["<em>尚未上线</em>"] });
      const changed = state();
      completion.resolve(reply);
      const response = await pending;
      expect(response.status).toBe(200);
      expect((await response.json()).resume_snapshot.modules).toEqual(original.modules);
      expect(input()[0].content.descriptionItems).toEqual(["尚未上线"]);
      expect(state().resume_versions).toEqual(changed.resume_versions);
    } finally { completion.resolve(reply); await pending; }
  });
});
