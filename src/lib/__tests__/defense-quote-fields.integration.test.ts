import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModuleData } from "../modules";
import { wrapUntrustedData } from "../prompt-safety";

const model = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock("@/lib/llm", async original => ({ ...await original<typeof import("@/lib/llm")>(), ...model }));
const PREFIX = "resume-life-defense-fields-";
let directory: string;
let db: DatabaseSync;
let versionId: number;

beforeEach(async () => {
  vi.resetModules();
  model.chat.mockReset();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'合成简历','','')");
  versionId = (await import("../resume-versions")).publishResumeVersion(1, { name: "合成发布版本" }).id;
  (await import("../resume-defense")).saveDefenseReport({ sourceContent: "历史原文", riskLevel: "low", overallRoast: "历史报告", items: [] });
});
afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(PREFIX)) throw new Error("Unsafe cleanup path");
  fs.rmSync(resolved, { recursive: true, force: true });
});

type SourceModule = Pick<ModuleData, "type" | "label" | "content">;
function setModules(modules: SourceModule[]) {
  const row = db.prepare("SELECT snapshot FROM resume_versions WHERE id=?").get(versionId)!;
  const snapshot = JSON.parse(row.snapshot as string);
  snapshot.modules = modules.map((module, index) => ({ ...module, key: `mod_${index}`, sort: index }));
  db.prepare("UPDATE resume_versions SET snapshot=? WHERE id=?").run(JSON.stringify(snapshot), versionId);
}
function tables() {
  return Object.fromEntries(["resumes", "resume_modules", "resume_versions", "resume_defenses", "resume_defense_drills"]
    .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
}
function output(quote: string) {
  return JSON.stringify({ risk_level: "medium", overall_roast: "核对个人分工", items: [{
    original_text: quote, section_hint: "经历", risk_level: "medium", risk_type: "scope_ambiguity",
    interviewer_roast: "需要核对表述范围", deadly_questions: ["个人负责哪部分？", "哪些内容尚未验证？"],
    defense_plan: { interviewer_intent: "核对分工", standard_defense: "只说明已确认的职责", taboo_mistakes: [] },
  }] });
}
async function scan(body: unknown = { resumeId: 1, resumeVersionId: versionId }) {
  return (await import("@/app/api/tools/resume-defenses/route")).POST(new Request("http://localhost/api/tools/resume-defenses", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
}

const cases = [
  { name: "公司与职位", modules: [{ type: "work", label: "工作", content: [{ company: "合成公司", title: "参与者" }] }], quote: "合成公司 | 参与者", valid: "参与者" },
  { name: "相邻经历", modules: [{ type: "work", label: "工作", content: [{ company: "甲公司" }, { company: "乙公司" }] }], quote: "甲公司\n- 乙公司", valid: "乙公司" },
  { name: "技能分项", modules: [{ type: "skills", label: "技能", content: { items: ["TypeScript", "SQL"] } }], quote: "TypeScript、SQL", valid: "TypeScript" },
  { name: "子项标签和值", modules: [{ type: "work", label: "工作", content: [{ company: "合成公司", subItems: [{ label: "职责", value: "校验" }] }] }], quote: "职责：校验", valid: "校验" },
  { name: "旧快照描述分条", modules: [{ type: "work", label: "工作", content: [{ descriptionItems: ["参与联调", "未上线"] }] }], quote: "参与联调 | 未上线", valid: "未上线" },
  { name: "自评分条", modules: [{ type: "summary", label: "简介", content: { descriptionItems: ["学习过 SQL", "尚无生产实践"] } }], quote: "学习过 SQL\n尚无生产实践", valid: "尚无生产实践" },
  { name: "模块标题", modules: [{ type: "summary", label: "自定义模块名称", content: { text: "参与校验" } }], quote: "自定义模块名称", valid: "参与校验" },
  { name: "跨模块边界", modules: [{ type: "summary", label: "简介", content: { text: "参与校验" } }, { type: "skills", label: "技能", content: { items: ["SQL"] } }], quote: "参与校验\n\n技能：SQL", valid: "参与校验" },
] satisfies { name: string; modules: SourceModule[]; quote: string; valid: string }[];

describe("发布简历排雷引文必须有单字段原文依据", () => {
  it.each(cases)("拒绝由 $name 拼出的引文，原字段显式重试可成功", async ({ modules, quote, valid }) => {
    setModules(modules);
    const before = tables();
    const { formatResumeEvidenceText, loadResume } = await import("../resumes");
    // 这段文字确实存在于展示文本，但没有任何单个原文字段包含它。
    expect(formatResumeEvidenceText(loadResume(1, versionId)!.modules)).toContain(quote);
    model.chat.mockResolvedValueOnce(output(quote));
    const rejected = await scan();
    expect(rejected.status).toBe(502);
    expect(await rejected.json()).toMatchObject({ error: expect.stringContaining("引用缺少原文依据") });
    expect(tables()).toEqual(before);
    model.chat.mockResolvedValueOnce(output(valid));
    const response = await scan();
    expect(response.status).toBe(200);
    const saved = await response.json();
    expect(saved.items[0].originalText).toBe(valid);
    const after = tables();
    expect(after.resume_defenses!.slice(0, -1)).toEqual(before.resume_defenses);
    for (const table of ["resumes", "resume_modules", "resume_versions", "resume_defense_drills"] as const) expect(after[table]).toEqual(before[table]);
    expect(model.chat).toHaveBeenCalledTimes(2);
  });

  it.each(cases)("$name 的同样文字本就在单字段内时仍可引用", async ({ quote }) => {
    setModules([{ type: "work", label: "工作", content: [{ description: `原文前缀\n${quote}\n原文后缀，尚未验证。` }] }]);
    model.chat.mockResolvedValueOnce(output(quote));
    const response = await scan();
    expect(response.status).toBe(200);
    const saved = await response.json();
    expect(saved.items[0].originalText).toBe(quote);
    expect(saved.sourceContent).toContain(quote);
    const { GET } = await import("@/app/api/tools/resume-defenses/[id]/route");
    const fetched = await GET(new Request("http://localhost/api/test"), { params: Promise.resolve({ id: String(saved.id) }) });
    expect((await fetched.json()).report.items[0].originalText).toBe(quote);
  });

  it("粘贴文本中的相同分隔符仍按用户提供的连续原文校验", async () => {
    const source = cases.map(item => item.quote).join("\n\n");
    model.chat.mockResolvedValueOnce(output(source));
    const response = await scan({ resumeContent: source });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sourceContent: source, items: [{ originalText: source }] });
    expect(model.chat.mock.calls[0]![1][1].content).toContain(wrapUntrustedData("candidate_resume", source));
  });

  it("只有空白技能时不把模块标题当成可供模型扫描的正文", async () => {
    setModules([{ type: "skills", label: "技能", content: { items: [" ", "\n\t"] } }]);
    const before = tables();
    model.chat.mockResolvedValueOnce(JSON.stringify({ risk_level: "low", overall_roast: "无明确风险", items: [] }));
    expect((await scan()).status).toBe(400);
    expect(model.chat).not.toHaveBeenCalled();
    expect(tables()).toEqual(before);
  });

  it("报告混入一个跨字段引文时整份拒绝，不保存前面的合法条目", async () => {
    setModules(cases[0]!.modules);
    const before = tables();
    const report = JSON.parse(output(cases[0]!.valid));
    report.items.push(JSON.parse(output(cases[0]!.quote)).items[0]);
    model.chat.mockResolvedValueOnce(JSON.stringify(report));
    expect((await scan()).status).toBe(502);
    expect(tables()).toEqual(before);
  });

  it("传输引文恢复后仍拒绝跨字段拼接，单字段原文可保存", async () => {
    setModules([{ type: "skills", label: "技能", content: { items: ["Array<T>", "R&D"] } }]);
    const { formatResumeEvidenceText, loadResume } = await import("../resumes");
    expect(formatResumeEvidenceText(loadResume(1, versionId)!.modules)).toContain("Array<T>、R&D");
    const before = tables();
    model.chat.mockResolvedValueOnce(output("Array&lt;T&gt;、R&amp;D"));
    expect((await scan()).status).toBe(502);
    expect(tables()).toEqual(before);
    model.chat.mockResolvedValueOnce(output("Array&lt;T&gt;"));
    const response = await scan();
    expect(response.status).toBe(200);
    const saved = await response.json();
    expect(saved.items[0].originalText).toBe("Array<T>");
    expect(tables().resume_versions).toEqual(before.resume_versions);
  });

  it("传输引文原样命中展示拼接时不转为另一个字段的解码引文", async () => {
    setModules([{ type: "skills", label: "技能", content: { items: ["Array&lt;T&gt;", "R&amp;D", "Array<T>、R&D"] } }]);
    const { formatResumeEvidenceText, collectResumeEvidenceParts, loadResume } = await import("../resumes");
    const modules = loadResume(1, versionId)!.modules;
    expect(formatResumeEvidenceText(modules)).toContain("Array&lt;T&gt;、R&amp;D");
    expect(collectResumeEvidenceParts(modules)).toContain("Array<T>、R&D");
    const before = tables();
    model.chat.mockResolvedValueOnce(output("Array&lt;T&gt;、R&amp;D"));
    expect((await scan()).status).toBe(502);
    expect(tables()).toEqual(before);
  });

  it("教育、项目、自定义字段和子项仍保留完整原文，快照读取不补写正文", async () => {
    const quotes = ["合成大学", "在指导下研究", '维护 Array<T>、C:\\work 与 "字面引号"', "仅参与验证", "合成证书", "学习证明", "CERT-001", "尚未上线\n不能推断为生产成果"];
    setModules([
      { type: "education", label: "教育", content: [{ school: quotes[0], field: quotes[1] }] },
      { type: "projects", label: "项目", content: [{ name: quotes[2], role: quotes[3] }] },
      { type: "custom", label: "其他", content: [{ title: quotes[4], subTitle: quotes[5], subItems: [{ label: "编号", value: quotes[6] }], descriptionItems: [quotes[7]] }] },
    ]);
    const before = tables();
    const report = JSON.parse(output(quotes[0]!));
    report.items = quotes.map(quote => JSON.parse(output(quote)).items[0]);
    model.chat.mockResolvedValueOnce(JSON.stringify(report));
    const response = await scan();
    expect(response.status).toBe(200);
    const saved = await response.json();
    expect(saved.items.map((item: { originalText: string }) => item.originalText)).toEqual(quotes);
    expect(tables().resume_versions).toEqual(before.resume_versions);
  });

  it("内部标识、模块类型与基本身份不能充当职业引文", async () => {
    setModules([
      { type: "work", label: "工作", content: [{ id: "内部条目标识", company: "合成公司", description: "只参与校验" }] },
      { type: "basic", label: "身份", content: { name: "私人姓名", email: "private@example.test" } },
    ]);
    const before = tables();
    for (const quote of ["mod_0", "内部条目标识", "work", "私人姓名", "private@example.test"]) {
      model.chat.mockResolvedValueOnce(output(quote));
      expect((await scan()).status).toBe(502);
    }
    expect(tables()).toEqual(before);
    for (const [, messages] of model.chat.mock.calls) {
      expect(messages[1].content).not.toContain("私人姓名");
      expect(messages[1].content).not.toContain("内部条目标识");
    }
  });
});
