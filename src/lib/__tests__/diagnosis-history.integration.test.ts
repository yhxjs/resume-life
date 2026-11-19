import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DIAGNOSIS_OUTPUT_LIMITS, type DiagnosisAdoption, type DiagnosisReport } from "../diagnosis";

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
  it("总体匹配分有独立于模块质量分的证据标尺", async () => {
    await diagnose({ jd: "JD" });
    const system = model.chat.mock.calls[0]![2] as string;
    expect(system).toContain("总体 match 是简历当前呈现证据与岗位要求的贴合度，不是候选人的实际能力评估");
    expect(system).toContain("不能直接用模块分或模块均分换算");
    expect(system).toContain("0 表示简历完全没有可用于判断岗位贴合度的相关信息");
    expect(system).toContain("1-3 表示已有内容与主要硬性要求明显不符，且有明确依据");
    expect(system).toContain("资料缺失不能说成明确矛盾");
    expect(system).toContain("输出前按此标尺独立评分，不照抄 JSON 示例中的数字");
  });

  it("无可靠修改依据时，诊断示例不会预填建议", async () => {
    await diagnose({ jd: "JD" });
    const system = model.chat.mock.calls[0]![2] as string;
    expect(system).toContain('"suggestions": []');
    expect(system).not.toMatch(/"suggestions":\s*\[\s*\{/);
  });

  it.each([
    ["围栏", (json: string) => ["```json", json, "```"].join("\n")],
    ["前置说明", (json: string) => `以下为初稿：\n${json}`],
    ["后置说明", (json: string) => `${json}\n上述分工仍需修订。`],
    ["追加截断内容", (json: string) => `${json}\n{"correction":`],
  ] as const)("%s 的模型回复不截取后保存，保留诊断历史，纯 JSON 可显式重试", async (_label, wrap) => {
    await diagnose({ jd: "JD" });
    const tables = ["resumes", "resume_modules", "resume_versions", "resume_diagnoses", "application_preparation_resources"];
    const before = tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
    model.chat.mockClear().mockResolvedValueOnce(wrap(report()));
    expect((await route.POST(request({ jd: "JD" }), params)).status).toBe(502);
    expect(tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all())).toEqual(before);
    expect(model.chat.mock.calls[0]!.at(-1)).toMatchObject({ requireJson: "strict" });
    model.chat.mockResolvedValueOnce(` \n${report()}\t `);
    await diagnose({ jd: "JD" });
    expect(model.chat).toHaveBeenCalledTimes(2);
    expect(db.prepare("SELECT * FROM resume_diagnoses ORDER BY id").all().slice(0, -1)).toEqual(before[3]);
    expect(tables.filter(table => table !== "resume_diagnoses").map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()))
      .toEqual(before.filter((_, index) => index !== 3));
  });

  it("新生成报告超出字段或总文本上限时返回 502，不新增历史", async () => {
    const raw = JSON.parse(report()) as Record<string, unknown>;
    raw.summary = "字".repeat(DIAGNOSIS_OUTPUT_LIMITS.summary + 1);
    model.chat.mockResolvedValue(JSON.stringify(raw));
    const response = await route.POST(request({ jd: "JD" }), params);
    expect(response.status).toBe(502);
    expect((await response.json()).error).toContain("结构校验未通过");
    expect(db.prepare("SELECT COUNT(*) AS count FROM resume_diagnoses").get()).toEqual({ count: 0 });
  });

  it.each([
    { value: "Array<T>\n&amp;\n<template>" },
    { value: ["Array<T>", "&amp;", "<template>"] },
  ])("有效技能采纳 $value 与其他模块的相同序号互不冲突，手动正文保持原样", async ({ value }) => {
    const { normalizeContent } = await import("../modules");
    db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,content,updated_at) VALUES (1,'skills','skills','技能',?,'')")
      .run(JSON.stringify(normalizeContent("skills", { items: ["TypeScript"] })));
    (await import("../resume-versions")).publishResumeVersion(1, { name: "技能与自评" });
    const raw = JSON.parse(report());
    raw.modules.push({ ...raw.modules[0], module_key: "skills", suggestions: [{ item_id: "", field: "items", reason: "优化技能表达", draft: ["TypeScript"] }] });
    model.chat.mockResolvedValue(JSON.stringify(raw));
    const first = await diagnose({ jd: "JD" });
    const adoptions = [
      { moduleKey: "skills", suggestionIndex: 0, value, applied_at: "2026-10-27T00:00:00.000Z" },
      { moduleKey: "summary", suggestionIndex: 0, value: "用户<strong>手动改写</strong>与 &amp;amp;", applied_at: "2026-10-27T00:00:00.000Z" },
    ];
    const serialized = JSON.stringify(adoptions);
    db.prepare("UPDATE resume_diagnoses SET adoptions = ? WHERE id = ?").run(serialized, first.id);
    const result = await read();
    expect(result.current.report).toEqual(first.report);
    expect(result.current).not.toHaveProperty("corruptedFields");
    expect(result.current.adoptions).toEqual(adoptions);
    expect(db.prepare("SELECT adoptions FROM resume_diagnoses WHERE id = ?").get(first.id)!.adoptions).toBe(serialized);
  });

  it.each(["未知模块", "越界建议序号", "重复采纳", "正文采纳值为数组", "重复模块导致采纳目标不明确"])("采纳记录%s 时标记不可读取，不补记或覆盖原记录", async (fault) => {
    const first = await diagnose({ jd: "JD" });
    const stored: DiagnosisReport = structuredClone(first.report);
    const adoptions: DiagnosisAdoption[] = [{ moduleKey: "summary", suggestionIndex: 0, value: "原自我评价", applied_at: "2026-10-27T00:00:00.000Z" }];
    if (fault === "未知模块") adoptions[0]!.moduleKey = "missing";
    if (fault === "越界建议序号") adoptions[0]!.suggestionIndex = 1;
    if (fault === "重复采纳") adoptions.push({ ...adoptions[0]!, value: "另一次写入" });
    if (fault === "正文采纳值为数组") adoptions[0]!.value = ["不能作为正文显示的技能数组"];
    if (fault === "重复模块导致采纳目标不明确") stored.modules.push(structuredClone(stored.modules[0]!));
    db.prepare("UPDATE resume_diagnoses SET report = ?, adoptions = ? WHERE id = ?").run(JSON.stringify(stored), JSON.stringify(adoptions), first.id);
    const before = db.prepare("SELECT * FROM resume_diagnoses WHERE id = ?").get(first.id);
    const result = await read();
    expect(result.current.report).toBeNull();
    expect(result.current.corruptedFields).toEqual(["adoptions"]);
    expect(result.current.adoptions).toEqual(adoptions);
    expect((await route.PATCH(request({ diagnosis_id: first.id, module_key: "summary", suggestion_index: 0, value: "原自我评价" }, "PATCH"), params)).status).toBe(400);
    expect(db.prepare("SELECT * FROM resume_diagnoses WHERE id = ?").get(first.id)).toEqual(before);
    const second = await diagnose({ jd: "JD", job_id: first.job_id });
    expect(second.previous.report).toBeNull();
    expect(second.previous.corruptedFields).toEqual(["adoptions"]);
    expect(second.current.report).not.toBeNull();
  });

  it.each(["summary", "skills"] as const)("%s 的模块级建议带错误条目 ID 时不能记录采纳", async (type) => {
    if (type === "skills") {
      const { normalizeContent } = await import("../modules");
      db.prepare("UPDATE resume_modules SET module_key = 'skills', type = 'skills', content = ? WHERE resume_id = 1").run(JSON.stringify(normalizeContent("skills", { items: ["TypeScript"] })));
      (await import("../resume-versions")).publishResumeVersion(1, { name: "技能版本" });
      model.chat.mockResolvedValue(JSON.stringify({ match: 7, summary: "技能诊断", modules: [{ module_key: "skills",
        scores: { depth: 7, structure: 7, authenticity: 7, completeness: 7 }, gaps: "", suggestions: [{ item_id: "", field: "items", reason: "措辞优化", draft: ["TypeScript"] }],
      }] }));
    }
    const first = await diagnose({ jd: "JD" });
    first.report.modules[0].suggestions[0].itemId = "unexpected-entry";
    db.prepare("UPDATE resume_diagnoses SET report = ? WHERE id = ?").run(JSON.stringify(first.report), first.id);
    const before = db.prepare("SELECT * FROM resume_diagnoses WHERE id = ?").get(first.id);
    expect((await route.PATCH(request({ diagnosis_id: first.id, module_key: type, suggestion_index: 0, value: type === "skills" ? ["TypeScript"] : "原自我评价" }, "PATCH"), params)).status).toBe(409);
    expect((await read()).adoptions).toEqual([]);
    expect(db.prepare("SELECT * FROM resume_diagnoses WHERE id = ?").get(first.id)).toEqual(before);
  });

  it("快照损坏时完整保留有效采纳记录，多个字段同时损坏也不覆盖原数据", async () => {
    const first = await diagnose({ jd: "JD" });
    const adoptions = [{ moduleKey: "summary", suggestionIndex: 0, value: "保留<strong>历史格式</strong>与 &amp;amp;", applied_at: "2026-10-27T00:00:00.000Z" }];
    const serialized = JSON.stringify(adoptions);
    db.prepare("UPDATE resume_diagnoses SET resume_snapshot = 'invalid', adoptions = ? WHERE id = ?").run(serialized, first.id);
    const result = await read();
    expect(result.current.corruptedFields).toEqual(["resume_snapshot"]);
    expect(result.current.adoptions).toEqual(adoptions);
    expect(db.prepare("SELECT adoptions FROM resume_diagnoses WHERE id = ?").get(first.id)!.adoptions).toBe(serialized);
    db.prepare("UPDATE resume_diagnoses SET report = '{}', adoptions = 'null' WHERE id = ?").run(first.id);
    const before = db.prepare("SELECT * FROM resume_diagnoses WHERE id = ?").get(first.id);
    const broken = await read();
    expect(broken.current.corruptedFields).toEqual(["report", "resume_snapshot", "adoptions"]);
    expect(broken.current.report).toBeNull();
    expect((await route.PATCH(request({ diagnosis_id: first.id, module_key: "summary", suggestion_index: 0, value: "原自我评价" }, "PATCH"), params)).status).toBe(400);
    expect(db.prepare("SELECT * FROM resume_diagnoses WHERE id = ?").get(first.id)).toEqual(before);
  });

  it.each(["resume_snapshot", "adoptions"].flatMap((column) => ["invalid json", "null", "{}", "[null]"].map((damaged) => ({ column, damaged }))))(
    "$column 损坏为 $damaged 时保留入口、拒绝采纳，后续新报告不受影响", async ({ column, damaged }) => {
      const first = await diagnose({ jd: "JD" });
      db.prepare(`UPDATE resume_diagnoses SET ${column} = ? WHERE id = ?`).run(damaged, first.id);
      const before = db.prepare("SELECT * FROM resume_diagnoses WHERE id = ?").get(first.id);
      const result = await read(`?diagnosis_id=${first.id}`);
      expect(result.current.report).toBeNull();
      expect(result.current.corruptedFields).toEqual([column]);
      expect(result.history[0].id).toBe(first.id);
      if (column === "resume_snapshot") expect(result.current.adoptions).toEqual([]);
      else expect(result.current.resume_snapshot).toEqual(first.resume_snapshot);
      expect((await route.PATCH(request({ diagnosis_id: first.id, module_key: "summary", suggestion_index: 0, value: "原自我评价" }, "PATCH"), params)).status).toBe(400);
      expect(db.prepare("SELECT * FROM resume_diagnoses WHERE id = ?").get(first.id)).toEqual(before);

      const second = await diagnose({ jd: "JD", job_id: first.job_id });
      expect(second.previous.id).toBe(first.id);
      expect(second.previous.report).toBeNull();
      expect(second.previous.corruptedFields).toEqual([column]);
      expect(second.current.report).not.toBeNull();
      expect((await route.PATCH(request({ diagnosis_id: second.id, module_key: "summary", suggestion_index: 0, value: "原自我评价" }, "PATCH"), params)).status).toBe(200);
      expect(db.prepare("SELECT * FROM resume_diagnoses WHERE id = ?").get(first.id)).toEqual(before);
    },
  );

  it.each([
    { column: "resume_snapshot", damaged: { title: "快照", modules: [{ key: "summary", type: "summary", label: "自评", sort: 1, content: null }] } },
    { column: "resume_snapshot", damaged: { title: "快照", modules: [{ key: "skills", type: "skills", label: "技能", sort: 1, content: { items: [42] } }] } },
    { column: "adoptions", damaged: [{ moduleKey: "summary", suggestionIndex: "0", value: "原文", applied_at: "2026-10-27T00:00:00.000Z" }] },
    { column: "adoptions", damaged: [{ moduleKey: "summary", suggestionIndex: 0, value: [42], applied_at: "2026-10-27T00:00:00.000Z" }] },
    { column: "adoptions", damaged: [{ moduleKey: "summary", suggestionIndex: 0, value: "原文", applied_at: "invalid date" }] },
  ])("$column 深层结构损坏时不传给页面或写回数据库", async ({ column, damaged }) => {
    const first = await diagnose({ jd: "JD" });
    const serialized = JSON.stringify(damaged);
    db.prepare(`UPDATE resume_diagnoses SET ${column} = ? WHERE id = ?`).run(serialized, first.id);
    const result = await read();
    expect(result.current.report).toBeNull();
    expect(result.current.corruptedFields).toEqual([column]);
    expect(db.prepare("SELECT * FROM resume_diagnoses WHERE id = ?").get(first.id)![column]).toBe(serialized);
  });

  it.each([
    "invalid json", "{}", "[]", "true", '"旧报告"',
    JSON.stringify({ match: 7, summary: "缺少模块" }),
    JSON.stringify({ match: 7, summary: "错误模块列表", modules: {} }),
    JSON.stringify({ match: 7, summary: "模块缺失", modules: [null] }),
    JSON.stringify({ match: 7, summary: "缺少建议数组", modules: [{ moduleKey: "summary", label: "自评", scores: { depth: 7, structure: 7, authenticity: 7, completeness: 7 }, gaps: "" }] }),
  ])("历史报告 %s 损坏时保留记录并拒绝采纳，不改写原数据", async (damaged) => {
    const first = await diagnose({ jd: "JD" });
    db.prepare("UPDATE resume_diagnoses SET report = ? WHERE id = ?").run(damaged, first.id);
    const before = db.prepare("SELECT * FROM resume_diagnoses WHERE id = ?").get(first.id);
    const result = await read(`?diagnosis_id=${first.id}`);
    expect(result.current.report).toBeNull();
    expect(result.current.resume_snapshot).toEqual(first.resume_snapshot);
    expect(result.current.adoptions).toEqual([]);
    expect(result.history).toHaveLength(1);
    expect((await route.PATCH(request({ diagnosis_id: first.id, module_key: "summary", suggestion_index: 0, value: "原自我评价" }, "PATCH"), params)).status).toBe(400);
    expect(db.prepare("SELECT * FROM resume_diagnoses WHERE id = ?").get(first.id)).toEqual(before);
    expect(model.chat).toHaveBeenCalledOnce();
  });

  it.each([
    { name: "建议混入空项", change: (report: DiagnosisReport) => { Object.assign(report.modules[0]!, { suggestions: [report.modules[0]!.suggestions[0], null] }); } },
    { name: "草稿类型错误", change: (report: DiagnosisReport) => { Object.assign(report.modules[0]!.suggestions[0]!, { draft: [false] }); } },
    { name: "分数类型错误", change: (report: DiagnosisReport) => { Object.assign(report.modules[0]!.scores, { depth: "7" }); } },
    { name: "格式标记无效", change: (report: DiagnosisReport) => { Object.assign(report, { textFormat: "html" }); } },
  ])("旧报告$name 时不影响新报告读取和采纳", async ({ change }) => {
    const first = await diagnose({ jd: "JD" });
    const damaged = structuredClone(first.report);
    change(damaged);
    const serialized = JSON.stringify(damaged);
    db.prepare("UPDATE resume_diagnoses SET report = ? WHERE id = ?").run(serialized, first.id);
    const second = await diagnose({ jd: "JD", job_id: first.job_id });
    expect(second.report.match).toBe(6);
    expect(second.previous.id).toBe(first.id);
    expect(second.previous.report).toBeNull();
    expect((await route.PATCH(request({ diagnosis_id: second.id, module_key: "summary", suggestion_index: 0, value: "原自我评价" }, "PATCH"), params)).status).toBe(200);
    expect((await read()).current.adoptions).toHaveLength(1);
    expect(db.prepare("SELECT report,adoptions FROM resume_diagnoses WHERE id = ?").get(first.id)).toEqual({ report: serialized, adoptions: "[]" });
  });

  it.each(["7", true, {}, [], -1, 11, null].map((match) => ({ match })))("历史列表的非法匹配分 $match 显示为未评分", async ({ match }) => {
    const first = await diagnose({ jd: "JD" });
    const damaged = { ...first.report, match };
    const serialized = JSON.stringify(damaged);
    db.prepare("UPDATE resume_diagnoses SET report = ? WHERE id = ?").run(serialized, first.id);
    const result = await read();
    expect(result.current.report).toBeNull();
    expect(result.history[0].match).toBeNull();
    expect(db.prepare("SELECT report FROM resume_diagnoses WHERE id = ?").get(first.id)!.report).toBe(serialized);
  });

  it.each([0, 7.2, 10])("合法历史报告保留匹配分 %s、空字段与原采纳索引，不套用新生成校验", async (match) => {
    const first = await diagnose({ jd: "JD" });
    const stored: DiagnosisReport = structuredClone(first.report);
    delete stored.textFormat;
    stored.match = match;
    stored.summary = "";
    stored.modules[0]!.scores.depth = 0;
    stored.modules[0]!.gaps = "";
    stored.modules[0]!.suggestions = [
      { itemId: "", field: "text", reason: "", draft: "" },
      { itemId: "", field: "text", reason: "历史理由", draft: "<strong>历史草稿</strong>与 &amp;" },
    ];
    const adoptions = [{ moduleKey: "summary", suggestionIndex: 1, value: "历史<strong>写入值</strong>", applied_at: "2026-10-27T00:00:00.000Z" }];
    const serialized = JSON.stringify(stored);
    db.prepare("UPDATE resume_diagnoses SET report = ?, adoptions = ? WHERE id = ?").run(serialized, JSON.stringify(adoptions), first.id);
    const result = await read();
    expect(result.current.report).toEqual(stored);
    expect(result.current.adoptions).toEqual(adoptions);
    expect(result.history[0].match).toBe(match);
    expect(db.prepare("SELECT report FROM resume_diagnoses WHERE id = ?").get(first.id)!.report).toBe(serialized);
  });

  it.each(["work", "projects", "education", "summary"] as const)("%s 新纯文本草稿经实际简历保存与采纳记录后完整保留", async (type) => {
    const { normalizeContent } = await import("../modules");
    const initial = type === "summary" ? normalizeContent(type, { text: "原正文" }) : normalizeContent(type, [{
      id: "entry", company: "公司", title: "开发", name: "订单系统", role: "后端开发", school: "大学", description: "原正文",
    }]);
    db.prepare("UPDATE resume_modules SET module_key = 'target', type = ?, content = ? WHERE resume_id = 1").run(type, JSON.stringify(initial));
    (await import("../resume-versions")).publishResumeVersion(1, { name: "正文版本" });
    const draft = "支持 Map<K, V> 与 <template>\r\n保留 &amp; 和 <strong>字面标签</strong>";
    const raw = JSON.parse(report());
    const suggestion = raw.modules[0].suggestions[0];
    raw.modules[0].module_key = "target";
    Object.assign(suggestion, { item_id: type === "summary" ? "" : "entry", field: type === "summary" ? "text" : "description", draft });
    model.chat.mockResolvedValue(JSON.stringify(raw));
    const result = await diagnose({ jd: "JD" });
    expect(result.report.textFormat).toBe("plain-text");
    expect(result.report.modules[0].suggestions[0].draft).toBe(draft);
    expect(JSON.parse(String(db.prepare("SELECT content FROM resume_modules WHERE resume_id = 1").get()!.content))).toEqual(initial);

    const { escapePlainTextToRichHtml, splitRichTextToLines, stripRichText } = await import("../rich-text");
    const editable = escapePlainTextToRichHtml(draft);
    const value = type === "summary" ? editable : splitRichTextToLines(editable).join("\n");
    const { loadResume } = await import("../resumes");
    const { writeDiagnosisValue } = await import("../module-descriptions");
    const target = loadResume(1)!.modules.find((mod) => mod.key === "target")!;
    const content = writeDiagnosisValue(type, target.content, suggestion.item_id, value);
    const resumeRoute = await import("@/app/api/resumes/[id]/route");
    expect((await resumeRoute.PATCH(new Request("http://localhost/api/resumes/1", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modules: { target: content }, moduleRevisions: { target: target.revision } }),
    }), params)).status).toBe(200);
    const { diagnosisValue } = await import("../diagnosis");
    const persisted = diagnosisValue(loadResume(1)!.modules, "target", result.report.modules[0].suggestions[0]) as string;
    expect(stripRichText(persisted)).toBe(draft.replace(/\r\n/g, "\n"));
    expect((await route.PATCH(request({ diagnosis_id: result.id, module_key: "target", suggestion_index: 0, value }, "PATCH"), params)).status).toBe(200);
    const saved = await read();
    expect(saved.report.modules[0].suggestions[0].draft).toBe(draft);
    expect(saved.adoptions[0].value).toBe(persisted);
    expect(saved.resume_snapshot.modules[0].content).toEqual(initial);
  });

  it.each(["默认发布版本", "指定旧版本"])("%s 的模型输入保留纯文本技术内容，正文去格式且版本原文不变", async (versionChoice) => {
    const literal = "Array<T>、Map<K, V>、<template>、&amp;、&lt;tag&gt;";
    const rich = "<strong>支持 Map&lt;K, V&gt;</strong><br>保留 &amp;lt;tag&amp;gt; 字面量";
    db.prepare("UPDATE resume_modules SET content = ? WHERE resume_id = 1").run(JSON.stringify({ text: rich }));
    const insert = db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,sort,content,updated_at) VALUES (1,?,?,?,?,?,'')");
    insert.run("skills", "skills", "技能", 1, JSON.stringify({ items: [literal] }));
    for (const [index, type] of ["work", "projects", "custom"].entries()) {
      insert.run(type, type, "经历" + type, index + 2, JSON.stringify([{
        id: type + "-1", company: "研发<T>", name: "工具<T>", title: "开发<T>", role: "开发", start: "", end: "",
        description: rich, subItems: [{ id: "tech", label: "技术栈<T>", value: literal }],
      }]));
    }
    const { publishResumeVersion } = await import("../resume-versions");
    const version = publishResumeVersion(1, { name: "技术正文版本" });
    const storedSnapshot = db.prepare("SELECT snapshot FROM resume_versions WHERE id = ?").get(version.id)!.snapshot as string;
    // 当前草稿及后续发布内容不能混进指定版本的诊断材料。
    db.prepare("UPDATE resume_modules SET content = ? WHERE resume_id = 1 AND module_key = 'skills'")
      .run(JSON.stringify({ items: ["后续编辑的其他技能"] }));
    if (versionChoice === "指定旧版本") publishResumeVersion(1, { name: "后续技能版本" });
    const beforeDraft = db.prepare("SELECT module_key,content FROM resume_modules WHERE resume_id = 1 ORDER BY module_key").all();
    model.chat.mockResolvedValue(JSON.stringify({ match: 7, summary: "依据完整技术材料诊断", modules:
      ["summary", "skills", "work", "projects", "custom"].map((module_key) => ({ module_key,
        scores: { depth: 7, structure: 7, authenticity: 7, completeness: 7 }, gaps: "", suggestions: [],
      })),
    }));
    const result = await diagnose({ jd: "核对真实技术材料", ...(versionChoice === "指定旧版本" ? { resume_version_id: version.id } : {}) });
    const messages = model.chat.mock.calls[0]![3] as { parts: { trust: string; tag?: string; text: string }[] }[];
    const part = messages.flatMap((message) => message.parts).find((part) => part.tag === "candidate_resume_modules")!;
    expect(part.trust).toBe("untrusted");
    const modules = JSON.parse(part.text) as { type: string; content: Record<string, unknown> | Record<string, unknown>[] }[];
    expect(modules.find((module) => module.type === "skills")?.content).toEqual({ items: [literal] });
    for (const type of ["work", "projects", "custom"]) {
      const entry = (modules.find((module) => module.type === type)!.content as Record<string, unknown>[])[0]!;
      expect(entry.subItems).toEqual([{ id: "tech", label: "技术栈<T>", value: literal }]);
      expect(entry.description).toBe("支持 Map<K, V>\n保留 &lt;tag&gt; 字面量");
    }
    expect(modules.find((module) => module.type === "summary")?.content).toEqual({
      text: "支持 Map<K, V>\n保留 &lt;tag&gt; 字面量",
      descriptionItems: ["支持 Map<K, V>\n保留 &lt;tag&gt; 字面量"],
    });
    expect(part.text).not.toContain("后续编辑的其他技能");
    expect(result.resume_snapshot.modules).toEqual(JSON.parse(storedSnapshot).modules);
    expect(db.prepare("SELECT snapshot FROM resume_versions WHERE id = ?").get(version.id)!.snapshot).toBe(storedSnapshot);
    expect(db.prepare("SELECT module_key,content FROM resume_modules WHERE resume_id = 1 ORDER BY module_key").all()).toEqual(beforeDraft);
  });

  it.each([
    { name: "列表前缀", moduleKey: "summary", draft: "- 接口联调\n- 完善文档", savedText: "接口联调\n完善文档" },
    { name: "空行与行首空白", moduleKey: "summary", draft: "接口联调\r\n\r\n   完善文档", savedText: "接口联调\n完善文档" },
    { name: "分块与加粗标签", moduleKey: "summary", draft: "<div><b>接口联调</b></div><p>完善文档</p>", savedText: "<strong>接口联调</strong>\n完善文档" },
    { name: "自定义自评模块中的实体文本", moduleKey: "mod_profile", draft: "<p>熟悉 Map&lt;K, V&gt; 与 A &amp; B</p><p>保留字面 &amp;lt;tag&amp;gt;</p>", savedText: "熟悉 Map&lt;K, V&gt; 与 A &amp; B\n保留字面 &amp;lt;tag&amp;gt;" },
  ])("自评建议经$name整理并实际保存后可记录采纳，保留原报告", async ({ moduleKey, draft, savedText }) => {
    db.prepare("UPDATE resume_modules SET module_key = ? WHERE resume_id = 1").run(moduleKey);
    (await import("../resume-versions")).publishResumeVersion(1, { name: "自评格式版本" });
    const rawReport = JSON.parse(report());
    rawReport.modules[0].module_key = moduleKey;
    rawReport.modules[0].suggestions[0].draft = draft;
    model.chat.mockResolvedValue(JSON.stringify(rawReport));
    const diagnosis = await diagnose({ jd: "JD" });
    const adoption = { diagnosis_id: diagnosis.id, module_key: moduleKey, suggestion_index: 0, value: draft };
    expect((await route.PATCH(request(adoption, "PATCH"), params)).status).toBe(409);

    const { loadResume } = await import("../resumes");
    const { writeDiagnosisValue } = await import("../module-descriptions");
    const targetModule = loadResume(1)!.modules.find((entry) => entry.key === moduleKey)!;
    const content = writeDiagnosisValue("summary", targetModule.content, "", draft);
    const resumeRoute = await import("@/app/api/resumes/[id]/route");
    const savedResponse = await resumeRoute.PATCH(new Request("http://localhost/api/resumes/1", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modules: { [moduleKey]: content }, moduleRevisions: { [moduleKey]: targetModule.revision } }),
    }), params);
    expect(savedResponse.status).toBe(200);
    expect(loadResume(1)!.modules.find((entry) => entry.key === moduleKey)!.content).toMatchObject({
      text: savedText, descriptionItems: savedText.split("\n"),
    });
    expect((await route.PATCH(request({ ...adoption, value: `${draft}\n其他修改` }, "PATCH"), params)).status).toBe(409);
    expect((await read()).adoptions).toEqual([]);

    expect((await route.PATCH(request(adoption, "PATCH"), params)).status).toBe(200);
    expect((await route.PATCH(request(adoption, "PATCH"), params)).status).toBe(200);
    const saved = await read();
    expect(saved.adoptions).toHaveLength(1);
    expect(saved.adoptions[0]).toMatchObject({ moduleKey, suggestionIndex: 0, value: savedText });
    expect(saved.report.modules[0].suggestions[0].draft).toBe(draft);
    expect(saved.resume_snapshot.modules[0].content.text).toBe("原自我评价");
  });

  it.each([
    { type: "work", draft: "锐捷网络 | C软件工程师\n2023.07 - 至今\n• 承担接口校验与联调\n• 维护接口文档", savedText: "承担接口校验与联调\n维护接口文档" },
    { type: "projects", draft: "订单系统\n• 负责参数校验\n• 参与接口联调", savedText: "负责参数校验\n参与接口联调" },
    { type: "work", draft: "<div>锐捷网络 | C软件工程师</div><div><b>参与接口联调</b></div>", savedText: "<strong>参与接口联调</strong>" },
    { type: "projects", draft: "订单系统 | 后端开发\n负责维护 Map&lt;K, V&gt; 与 A &amp; B 的接口文档", savedText: "负责维护 Map&lt;K, V&gt; 与 A &amp; B 的接口文档" },
    { type: "work", draft: "锐捷网络 | C软件工程师\n熟悉 CI/CD 流程\n在锐捷网络担任C软件工程师期间仅参与联调\n2023.07 接手接口维护，至今尚未上线", savedText: "熟悉 CI/CD 流程\n在锐捷网络担任C软件工程师期间仅参与联调\n2023.07 接手接口维护，至今尚未上线" },
    { type: "projects", draft: "订单系统 | 后端开发\n支持 HTTP/2 与 HTTP/3\n在订单系统仅参与联调，没有后端开发之外的选型权", savedText: "支持 HTTP/2 与 HTTP/3\n在订单系统仅参与联调，没有后端开发之外的选型权" },
    { type: "work", draft: "公司：锐捷网络 职位：C软件工程师\n公司：锐捷网络，仅在测试环境参与验证。\n参与文档核对\n时间：仅测试两周，结果未统计。", savedText: "公司：锐捷网络，仅在测试环境参与验证。\n参与文档核对\n时间：仅测试两周，结果未统计。" },
    { type: "projects", draft: "项目名称：订单系统 角色：后端开发\n项目：只参与接口校验，尚未上线。\n参与文档核对\n角色：在指导下验证接口，未负责架构。", savedText: "项目：只参与接口校验，尚未上线。\n参与文档核对\n角色：在指导下验证接口，未负责架构。" },
    { type: "work", draft: "# 锐捷网络 | C软件工程师\n## 公司：锐捷网络，仅在测试环境参与验证。\n参与文档核对\n### 仅测试两周，结果未统计。", savedText: "## 公司：锐捷网络，仅在测试环境参与验证。\n参与文档核对\n### 仅测试两周，结果未统计。" },
    { type: "projects", draft: "# 项目名称：订单系统 角色：后端开发\n## 只参与接口校验，尚未上线。\n参与文档核对\n### 角色：在指导下验证接口，未负责架构。", savedText: "## 只参与接口校验，尚未上线。\n参与文档核对\n### 角色：在指导下验证接口，未负责架构。" },
    { type: "education", draft: "项目：课程设计\n参与接口联调", savedText: "项目：课程设计\n参与接口联调" },
  ] as const)("$type 经历建议按编辑器规则清理后可记录采纳：$draft", async ({ type, draft, savedText }) => {
    const moduleKey = "mod_experience";
    const identity = type === "work" ? { company: "锐捷网络", title: "C软件工程师" }
      : type === "projects" ? { name: "订单系统", role: "后端开发" } : { school: "某大学" };
    db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,content,updated_at) VALUES (1,?,?, '经历',?,'')")
      .run(moduleKey, type, JSON.stringify([
        { id: "e1", ...identity, description: "原经历内容" },
        { id: "other", ...identity, description: "其他条目保持不变" },
      ]));
    (await import("../resume-versions")).publishResumeVersion(1, { name: "经历格式版本" });
    const rawReport = JSON.parse(report());
    rawReport.modules[0].suggestions = [];
    rawReport.modules.push({ ...rawReport.modules[0], module_key: moduleKey, suggestions: [
      { item_id: "e1", field: "description", reason: "突出已有职责", draft },
    ] });
    model.chat.mockResolvedValue(JSON.stringify(rawReport));
    const diagnosis = await diagnose({ jd: "JD" });
    const adoption = { diagnosis_id: diagnosis.id, module_key: moduleKey, suggestion_index: 0, value: draft };
    expect((await route.PATCH(request(adoption, "PATCH"), params)).status).toBe(409);

    const { loadResume } = await import("../resumes");
    const { writeDiagnosisValue } = await import("../module-descriptions");
    const targetModule = loadResume(1)!.modules.find((entry) => entry.key === moduleKey)!;
    const content = writeDiagnosisValue(type, targetModule.content, "e1", draft);
    const resumeRoute = await import("@/app/api/resumes/[id]/route");
    expect((await resumeRoute.PATCH(new Request("http://localhost/api/resumes/1", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modules: { [moduleKey]: content }, moduleRevisions: { [moduleKey]: targetModule.revision } }),
    }), params)).status).toBe(200);
    const savedContent = loadResume(1)!.modules.find((entry) => entry.key === moduleKey)!.content as { id: string; description: string }[];
    expect(savedContent.find((entry) => entry.id === "e1")!.description).toBe(savedText);
    expect(savedContent.find((entry) => entry.id === "other")!.description).toBe("其他条目保持不变");
    expect((await route.PATCH(request({ ...adoption, value: `${draft}\n负责其他修改` }, "PATCH"), params)).status).toBe(409);
    expect((await read()).adoptions).toEqual([]);
    expect((await route.PATCH(request(adoption, "PATCH"), params)).status).toBe(200);
    expect((await route.PATCH(request(adoption, "PATCH"), params)).status).toBe(200);
    const saved = await read();
    expect(saved.adoptions).toHaveLength(1);
    expect(saved.adoptions[0]).toMatchObject({ moduleKey, suggestionIndex: 0, value: savedText });
    expect(saved.report.modules.find((entry: { moduleKey: string }) => entry.moduleKey === moduleKey).suggestions[0].draft).toBe(draft);
    expect(saved.resume_snapshot.modules.find((entry: { key: string }) => entry.key === moduleKey).content[0].description).toBe("原经历内容");
  });

  it.each(["work", "projects"] as const)("%s 建议整理后仅剩空正文时不记录采纳", async (type) => {
    const identity = type === "work" ? { company: "锐捷网络", title: "C软件工程师" }
      : { name: "订单系统", role: "后端开发" };
    const draft = type === "work" ? "锐捷网络 | C软件工程师" : "订单系统 | 后端开发";
    db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,content,updated_at) VALUES (1,'experience',?,'经历',?,'')")
      .run(type, JSON.stringify([{ id: "e1", ...identity, description: "原经历内容" }]));
    (await import("../resume-versions")).publishResumeVersion(1, { name: "抬头建议版本" });
    const rawReport = JSON.parse(report());
    rawReport.modules.push({ ...rawReport.modules[0], module_key: "experience", suggestions: [
      { item_id: "e1", field: "description", reason: "表达优化", draft },
    ] });
    model.chat.mockResolvedValue(JSON.stringify(rawReport));
    const diagnosis = await diagnose({ jd: "JD" });
    const { loadResume } = await import("../resumes");
    const { writeDiagnosisValue } = await import("../module-descriptions");
    const targetModule = loadResume(1)!.modules.find((entry) => entry.key === "experience")!;
    const content = writeDiagnosisValue(type, targetModule.content, "e1", draft);
    const resumeRoute = await import("@/app/api/resumes/[id]/route");
    expect((await resumeRoute.PATCH(new Request("http://localhost/api/resumes/1", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modules: { experience: content }, moduleRevisions: { experience: targetModule.revision } }),
    }), params)).status).toBe(200);
    const response = await route.PATCH(request({ diagnosis_id: diagnosis.id, module_key: "experience", suggestion_index: 0, value: draft }, "PATCH"), params);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("整理后为空");
    expect((await read()).adoptions).toEqual([]);
  });

  it.each(["条目", "模块"])("经历目标%s已删除时不把无法定位的空值记为采纳", async (target) => {
    db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,content,updated_at) VALUES (1,'work','work','工作经历',?,'')")
      .run(JSON.stringify([{ id: "w1", company: "公司", description: "原工作内容" }]));
    (await import("../resume-versions")).publishResumeVersion(1, { name: "删除前版本" });
    const rawReport = JSON.parse(report());
    rawReport.modules.push({ ...rawReport.modules[0], module_key: "work", suggestions: [
      { item_id: "w1", field: "description", reason: "表达优化", draft: "负责接口联调" },
    ] });
    model.chat.mockResolvedValue(JSON.stringify(rawReport));
    const diagnosis = await diagnose({ jd: "JD" });
    if (target === "条目") db.prepare("UPDATE resume_modules SET content = '[]' WHERE module_key = 'work'").run();
    else db.prepare("DELETE FROM resume_modules WHERE module_key = 'work'").run();
    expect((await route.PATCH(request({ diagnosis_id: diagnosis.id, module_key: "work", suggestion_index: 0, value: "负责接口联调" }, "PATCH"), params)).status).toBe(409);
    expect((await read()).adoptions).toEqual([]);
  });

  it("经历建议经过列表归一化后记录实际保存内容，保留原始报告草稿", async () => {
    db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,label,content,updated_at) VALUES (1,'work','work','工作经历',?,'')")
      .run(JSON.stringify([{ id: "w1", company: "公司", description: "原工作内容" }]));
    (await import("../resume-versions")).publishResumeVersion(1, { name: "工作经历版本" });
    const rawDraft = "- 新工作内容\n- 改善性能";
    model.chat.mockResolvedValue(JSON.stringify({ match: 7, summary: "表达优化", modules: [
      { module_key: "summary", scores: { depth: 6, structure: 7, authenticity: 8, completeness: 6 }, gaps: "", suggestions: [] },
      { module_key: "work", scores: { depth: 7, structure: 7, authenticity: 8, completeness: 7 }, gaps: "可优化表达", suggestions: [
        { item_id: "w1", field: "description", reason: "对齐", draft: rawDraft },
      ] },
    ] }));
    const diagnosis = await diagnose({ jd: "JD" });
    const savedText = "新工作内容\n改善性能";
    db.prepare("UPDATE resume_modules SET content = ? WHERE module_key = 'work'").run(JSON.stringify([{ id: "w1", description: savedText }]));
    const response = await route.PATCH(request({ diagnosis_id: diagnosis.id, module_key: "work", suggestion_index: 0, value: rawDraft }, "PATCH"), params);
    expect(response.status).toBe(200);
    const saved = await read();
    expect(saved.adoptions[0].value).toBe(savedText);
    expect(saved.report.modules.find((module: { moduleKey: string }) => module.moduleKey === "work").suggestions[0].draft).toBe(rawDraft);
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

  it("拒绝不完整模块评分和非法匹配分，不写入误导性总体报告", async () => {
    model.chat.mockResolvedValueOnce(JSON.stringify({ match: 7, summary: "部分模块", modules: [] }));
    expect((await route.POST(request({ jd: "JD" }), params)).status).toBe(502);
    model.chat.mockResolvedValueOnce(JSON.stringify({ match: true, summary: "被强制转型的分数", modules: [{
      module_key: "summary", scores: { depth: 6, structure: 7, authenticity: 8, completeness: 6 }, suggestions: [],
    }] }));
    expect((await route.POST(request({ jd: "JD" }), params)).status).toBe(502);
    expect((await read()).history).toHaveLength(0);
  });

  it.each(["缺少建议数组", "重复替换目标", "混入无效建议", "草稿类型错误", "字符串评分", "重复模块"])("新报告%s时整份拒绝，保留历史和简历，修正后可重试", async (fault) => {
    const first = await diagnose({ jd: "原JD" });
    const before = {
      diagnoses: db.prepare("SELECT * FROM resume_diagnoses").all(),
      modules: db.prepare("SELECT * FROM resume_modules").all(),
    };
    const raw = JSON.parse(report());
    const entry = raw.modules[0];
    if (fault === "缺少建议数组") delete entry.suggestions;
    if (fault === "重复替换目标") entry.suggestions.push({ ...entry.suggestions[0], draft: "同字段另一版" });
    if (fault === "混入无效建议") entry.suggestions.push(null);
    if (fault === "草稿类型错误") entry.suggestions[0].draft = ["不能自动转成文本"];
    if (fault === "字符串评分") entry.scores.depth = "8";
    if (fault === "重复模块") raw.modules.push({ ...entry });
    model.chat.mockResolvedValueOnce(JSON.stringify(raw));
    expect((await route.POST(request({ jd: "更新JD", job_id: first.job_id }), params)).status).toBe(502);
    expect(db.prepare("SELECT * FROM resume_diagnoses").all()).toEqual(before.diagnoses);
    expect(db.prepare("SELECT * FROM resume_modules").all()).toEqual(before.modules);
    expect((await read()).id).toBe(first.id);
    model.chat.mockResolvedValueOnce(report(8));
    const retried = await diagnose({ jd: "更新JD", job_id: first.job_id });
    expect(retried.history).toHaveLength(2);
    expect(retried.previous.id).toBe(first.id);
    expect(retried.report.match).toBe(8);
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

  it.each(["新纯文本报告", "历史富文本报告", "旧纯文本草稿报告"])("%s 的草稿格式、原文及采纳值在读取和备份恢复后完整保留", async (kind) => {
    const { normalizeContent } = await import("../modules");
    db.prepare("UPDATE resume_modules SET content = ? WHERE resume_id = 1").run(JSON.stringify(normalizeContent("summary", { text: "原自我评价" })));
    const raw = JSON.parse(report());
    const draft = kind !== "历史富文本报告" ? "支持 Map<K, V>\n保留 &amp; 与 <template>" : "<strong>历史加粗</strong>与 Map&lt;K, V&gt;";
    raw.summary = `总评：${draft}`;
    raw.modules[0].gaps = `差距：${draft}`;
    raw.modules[0].suggestions[0].reason = `理由：${draft}`;
    raw.modules[0].suggestions[0].draft = draft;
    model.chat.mockResolvedValue(JSON.stringify(raw));
    const result = await diagnose({ jd: "JD" });
    const storedReport = result.report;
    if (kind !== "新纯文本报告") delete storedReport.textFormat;
    if (kind === "旧纯文本草稿报告") storedReport.draftFormat = "plain-text";
    const serialized = JSON.stringify(storedReport);
    const adoptions = JSON.stringify([{ moduleKey: "summary", suggestionIndex: 0,
      value: "用户<strong>手动编辑</strong>与 &amp;amp;", applied_at: "2026-10-27T00:00:00.000Z" }]);
    db.prepare("UPDATE resume_diagnoses SET report = ?, adoptions = ? WHERE id = ?").run(serialized, adoptions, result.id);
    const before = await read();
    expect(before.report.textFormat).toBe(kind === "新纯文本报告" ? "plain-text" : undefined);
    expect(before.report.draftFormat).toBe(kind === "旧纯文本草稿报告" ? "plain-text" : undefined);
    expect(before.report.modules[0].suggestions[0].draft).toBe(draft);
    const chunks: Buffer[] = [];
    const { createBackupRecordStream } = await import("../backup-records");
    for await (const chunk of createBackupRecordStream(db)) chunks.push(Buffer.from(chunk));
    const { stageBackupRecordStream } = await import("../backup-staging");
    const staged = await stageBackupRecordStream((async function* () { yield Buffer.concat(chunks); })(), db);
    try {
      db.prepare("DELETE FROM resume_diagnoses").run();
      (await import("../backup")).restoreAllData(staged, true);
      const restored = await read();
      expect(restored.current).toEqual(before.current);
      expect(db.prepare("SELECT report,adoptions FROM resume_diagnoses WHERE id = ?").get(result.id)).toEqual({ report: serialized, adoptions });
    } finally {
      staged.dispose();
    }
  });

  it.each(["textFormat", "draftFormat"].flatMap((field) => [null, false, "html"].map((value) => ({ field, value }))))("备份拒绝无效诊断格式 $field=$value", async ({ field, value }) => {
    const result = await diagnose({ jd: "JD" });
    const { invalidDomainColumn } = await import("../backup-domain");
    const row = db.prepare("SELECT * FROM resume_diagnoses WHERE id = ?").get(result.id)!;
    expect(invalidDomainColumn("resume_diagnoses", { ...row, report: JSON.stringify({ ...result.report, [field]: value }) })).toBe("report");
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

  it("诊断历史查询拒绝会别名到现存记录的 ID，完整历史保持不变", async () => {
    const first = await diagnose({ jd: "别名边界岗位", job_title: "别名边界职位" });
    const before = db.prepare("SELECT * FROM resume_diagnoses ORDER BY id").all();
    for (const value of ["1e0", "0x1", "+1", "01", " 1"]) {
      const response = await route.GET(new Request(`http://localhost/api/resumes/1/diagnose?diagnosis_id=${encodeURIComponent(value)}`), params);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "无效的诊断 ID" });
    }
    expect(db.prepare("SELECT * FROM resume_diagnoses ORDER BY id").all()).toEqual(before);
    expect((await read(`?diagnosis_id=${first.id}`)).id).toBe(first.id);
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

  it.each(["work", "projects", "education", "summary"] as const)("%s 已采纳建议仅允许相同保存值重试，不把后续改写误记为成功", async (type) => {
    const { normalizeContent } = await import("../modules");
    const initial = normalizeContent(type, type === "summary" ? { text: "原正文" } : [{ id: "entry", description: "原正文" }]);
    db.prepare("UPDATE resume_modules SET type = ?, content = ? WHERE resume_id = 1").run(type, JSON.stringify(initial));
    (await import("../resume-versions")).publishResumeVersion(1, { name: "采纳测试版本" });
    const raw = JSON.parse(report());
    const draft = "- 参与接口开发\n- 维护 Map&lt;K, V&gt; 文档";
    Object.assign(raw.modules[0].suggestions[0], {
      item_id: type === "summary" ? "" : "entry", field: type === "summary" ? "text" : "description", draft,
    });
    model.chat.mockResolvedValue(JSON.stringify(raw));
    const first = await diagnose({ jd: "JD" });
    const body = { diagnosis_id: first.id, module_key: "summary", suggestion_index: 0, value: draft };
    const { loadResume } = await import("../resumes");
    const { writeDiagnosisValue } = await import("../module-descriptions");
    const resumeRoute = await import("@/app/api/resumes/[id]/route");
    const save = async (value: string) => {
      const target = loadResume(1)!.modules[0]!;
      const response = await resumeRoute.PATCH(new Request("http://localhost/api/resumes/1", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modules: { summary: writeDiagnosisValue(type, target.content, raw.modules[0].suggestions[0].item_id, value) },
          moduleRevisions: { summary: target.revision } }),
      }), params);
      expect(response.status).toBe(200);
    };
    await save(draft);
    expect((await route.PATCH(request(body, "PATCH"), params)).status).toBe(200);
    const adopted = await read();
    const savedValue = adopted.adoptions[0].value;
    if (type !== "education") expect(savedValue).not.toBe(draft);
    const stored = db.prepare("SELECT * FROM resume_diagnoses WHERE id = ?").get(first.id);
    for (const value of [draft, savedValue]) {
      expect((await route.PATCH(request({ ...body, value }, "PATCH"), params)).status).toBe(200);
      expect(db.prepare("SELECT * FROM resume_diagnoses WHERE id = ?").get(first.id)).toEqual(stored);
    }
    const changed = "后续<strong>手动改写</strong>与 &amp;amp;";
    await save(changed);
    const modulesBefore = db.prepare("SELECT * FROM resume_modules WHERE resume_id = 1").all();
    const conflict = await route.PATCH(request({ ...body, value: changed }, "PATCH"), params);
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error).toContain("已记录其他采纳内容");
    expect((await route.PATCH(request(body, "PATCH"), params)).status).toBe(409);
    expect((await read()).adoptions).toEqual(adopted.adoptions);
    expect(db.prepare("SELECT * FROM resume_diagnoses WHERE id = ?").get(first.id)).toEqual(stored);
    expect(db.prepare("SELECT * FROM resume_modules WHERE resume_id = 1").all()).toEqual(modulesBefore);
    await save(draft);
    expect((await route.PATCH(request(body, "PATCH"), params)).status).toBe(200);
    expect(db.prepare("SELECT * FROM resume_diagnoses WHERE id = ?").get(first.id)).toEqual(stored);
  });

  it.each(["数组", "历史换行字符串", "历史 CRLF 字符串"])("技能%s 相同内容可幂等补记，不同内容或顺序返回冲突并保留首次记录", async (format) => {
    const skills = ["Map<K, V>", "&amp;", "<template>"];
    db.prepare("UPDATE resume_modules SET type = 'skills', content = ? WHERE resume_id = 1").run(JSON.stringify({ items: skills }));
    (await import("../resume-versions")).publishResumeVersion(1, { name: "技能版本" });
    const raw = JSON.parse(report());
    Object.assign(raw.modules[0].suggestions[0], { field: "items", draft: skills });
    model.chat.mockResolvedValue(JSON.stringify(raw));
    const first = await diagnose({ jd: "JD" });
    const body = { diagnosis_id: first.id, module_key: "summary", suggestion_index: 0, value: skills };
    expect((await route.PATCH(request(body, "PATCH"), params)).status).toBe(200);
    const adopted = await read();
    if (format !== "数组") {
      adopted.adoptions[0].value = skills.join(format === "历史 CRLF 字符串" ? "\r\n" : "\n");
      db.prepare("UPDATE resume_diagnoses SET adoptions = ? WHERE id = ?").run(JSON.stringify(adopted.adoptions), first.id);
    }
    const stored = db.prepare("SELECT * FROM resume_diagnoses WHERE id = ?").get(first.id);
    expect((await route.PATCH(request(body, "PATCH"), params)).status).toBe(200);
    expect(db.prepare("SELECT * FROM resume_diagnoses WHERE id = ?").get(first.id)).toEqual(stored);
    for (const changed of [[...skills].reverse(), [...skills, "新技能"]]) {
      db.prepare("UPDATE resume_modules SET content = ? WHERE resume_id = 1").run(JSON.stringify({ items: changed }));
      const response = await route.PATCH(request({ ...body, value: changed }, "PATCH"), params);
      expect(response.status).toBe(409);
      expect((await response.json()).error).toContain("已记录其他采纳内容");
      expect((await read()).adoptions).toEqual(adopted.adoptions);
      expect(db.prepare("SELECT * FROM resume_diagnoses WHERE id = ?").get(first.id)).toEqual(stored);
      expect(JSON.parse(String(db.prepare("SELECT content FROM resume_modules WHERE resume_id = 1").get()!.content)).items).toEqual(changed);
    }
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
