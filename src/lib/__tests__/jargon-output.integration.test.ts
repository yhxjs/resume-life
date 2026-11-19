import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JARGON_OUTPUT_LIMITS as LIMITS } from "../jargon-decoder";
import { JARGON_DECODER_SYSTEM_PROMPT } from "../jargon-decoder-llm";
import { wrapUntrustedData } from "../prompt-safety";

const model = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock("@/lib/llm", async (original) => ({
  ...await original<typeof import("@/lib/llm")>(), chat: model.chat,
}));

const item = {
  keyword: "弹性工作制", surface_meaning: "工作时间可灵活安排", hidden_meaning: "可能允许灵活安排时间，也需核实响应边界。",
  risk_level: "medium", risk_category: "工作时间边界", warning: "若要求非工作时间持续响应，休息时间可能受影响。",
  interview_rule: "表达对结果负责的态度，同时确认核心协作时段与紧急响应安排。",
  counter_questions: ["团队通常的核心协作时段是什么？", "非工作时间有哪些响应约定？"],
};
const report = {
  target_summary: "工作安排说明", punchline: "建议核实协作时间与响应边界", overall_risk_score: 50,
  risk_ratings: { overtime: 4, stability: 1, resources: 1, management: 1 }, items: [item],
  company_profile: { team_style: "信息不足", risk_flags: [], culture_summary: "仅凭这一短语无法确定实际工时与团队文化。" },
  golden_questions: ["团队通常的核心协作时段是什么？", "最近一次紧急响应是如何安排的？"],
};
const noSignal = {
  ...report, punchline: "本次未识别到明确线索", items: [], golden_questions: [], overall_risk_score: 1,
  risk_ratings: { overtime: 1, stability: 1, resources: 1, management: 1 },
};
const PREFIX = "resume-life-jargon-output-";
let directory: string;
let db: DatabaseSync;

beforeEach(async () => {
  vi.resetModules();
  model.chat.mockReset();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
});
afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(PREFIX)) {
    throw new Error("Unsafe cleanup path");
  }
  fs.rmSync(resolved, { recursive: true, force: true });
});

async function post(output: unknown, text = "岗位提供弹性工作制。") {
  model.chat.mockResolvedValueOnce(JSON.stringify(output));
  const { POST } = await import("@/app/api/tools/jargon-decodings/route");
  return POST(new Request("http://localhost/api/tools/jargon-decodings", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }),
  }));
}

function savedResult() {
  const row = db.prepare("SELECT result FROM jargon_decodings").get() as { result: string };
  return JSON.parse(row.result);
}

function changed(field: string, value: unknown) {
  const output = structuredClone(report) as Record<string, unknown>;
  let target = output;
  const keys = field.split(".");
  for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
  target[keys.at(-1)!] = value;
  return output;
}

const boundedFields: [string, number][] = [
  ["target_summary", LIMITS.target_summary], ["punchline", LIMITS.punchline],
  ["items.0.surface_meaning", LIMITS.surface_meaning], ["items.0.hidden_meaning", LIMITS.hidden_meaning],
  ["items.0.risk_category", LIMITS.risk_category], ["items.0.warning", LIMITS.warning],
  ["items.0.interview_rule", LIMITS.interview_rule], ["items.0.counter_questions.0", LIMITS.counter_question],
  ["company_profile.team_style", LIMITS.team_style], ["company_profile.risk_flags.0", LIMITS.risk_flag],
  ["company_profile.culture_summary", LIMITS.culture_summary], ["golden_questions.0", LIMITS.golden_question],
];
const visibleTextFields = boundedFields.filter(([field]) =>
  field !== "items.0.counter_questions.0" && field !== "golden_questions.0");

describe("黑话解码新结果契约", () => {
  it.each(["——", "（）", "「」 \n\t", "\u200b", "（\u200b）？"])("拒绝无内容核实问题 %j，保留旧报告", async (question) => {
    expect((await post(report)).status).toBe(201);
    const before = db.prepare("SELECT * FROM jargon_decodings ORDER BY id").all();
    for (const field of ["items.0.counter_questions.0", "golden_questions.0"]) {
      expect((await post(changed(field, question))).status).toBe(502);
      expect(db.prepare("SELECT * FROM jargon_decodings ORDER BY id").all()).toEqual(before);
    }
  });

  it("有效核实问题保留技术符号，不以问号判断有无内容", async () => {
    const question = "请说明岗位中 C++ / C# 的使用范围";
    const output = { ...report, items: [{ ...item, counter_questions: [question] }], golden_questions: [question, report.golden_questions[1]] };
    expect((await post(output)).status).toBe(201);
    expect(savedResult().items[0].counterQuestions).toEqual([question]);
    expect(savedResult().goldenQuestions[0]).toBe(question);
    expect(model.chat.mock.calls[0]![1][0].content).toContain("问题不得只含标点或空白");
    expect(model.chat.mock.calls[0]![1][0].content).toContain("也不得仅用零宽、控制字符等不可见字符占位");
  });

  it.each(visibleTextFields)("拒绝 %s 中仅含不可见字符或纯标点的文本且不保存", async (field) => {
    for (const placeholder of ["\u200b\u2060", "!!!"]) {
      expect((await post(changed(field, placeholder))).status).toBe(502);
      expect(db.prepare("SELECT COUNT(*) AS n FROM jargon_decodings").get()).toEqual({ n: 0 });
    }
  });

  it("即使原文含相同零宽字符，也拒绝无可见内容的关键词引文", async () => {
    const invisibleKeyword = "\u200b\u2060";
    expect((await post(changed("items.0.keyword", invisibleKeyword), invisibleKeyword)).status).toBe(502);
    expect(db.prepare("SELECT COUNT(*) AS n FROM jargon_decodings").get()).toEqual({ n: 0 });
  });

  it("必填文本拒绝占位，但没有线索和风险标签时空列表仍有效", async () => {
    expect((await post(noSignal)).status).toBe(201);
    expect(JARGON_DECODER_SYSTEM_PROMPT).toContain("所有必填文本及已提供的列表项必须包含可见内容");
    expect(JARGON_DECODER_SYSTEM_PROMPT).toContain("规则允许为空的数组仍返回 []");
  });

  it("中文解释要求不翻译英文引文或协议枚举，原文可完整保存", async () => {
    const keyword = "work hard, play hard";
    expect((await post({ ...report, items: [{ ...item, keyword }] }, `招聘说明：${keyword}。`)).status).toBe(201);
    const system = model.chat.mock.calls[0]![1][0].content;
    expect(system).toContain("说明性文字使用中文");
    expect(system).toContain("JSON 字段名、规定枚举、原文引文、技术名称和公司/产品专名保留原样");
    expect(system).not.toContain("纯中文输出");
    expect(savedResult().items[0]).toMatchObject({ keyword, riskLevel: "medium" });
  });

  it("提示词为所有受校验的字段和列表声明相同的硬上限", () => {
    for (const limit of Object.values({
      target_summary: LIMITS.target_summary, punchline: LIMITS.punchline,
      surface_meaning: LIMITS.surface_meaning, hidden_meaning: LIMITS.hidden_meaning,
      risk_category: LIMITS.risk_category, warning: LIMITS.warning,
      interview_rule: LIMITS.interview_rule, team_style: LIMITS.team_style,
      culture_summary: LIMITS.culture_summary,
    })) expect(JARGON_DECODER_SYSTEM_PROMPT).toContain(`最多${limit}字符`);
    expect(JARGON_DECODER_SYSTEM_PROMPT).toContain(`最多 ${LIMITS.max_items} 个有依据的独立线索`);
    expect(JARGON_DECODER_SYSTEM_PROMPT).toContain(`给 ${LIMITS.min_counter_questions}-${LIMITS.max_counter_questions} 个礼貌、具体且不重复的问题，每题最多 ${LIMITS.counter_question} 字符`);
    expect(JARGON_DECODER_SYSTEM_PROMPT).toContain(`给 ${LIMITS.min_golden_questions}-${LIMITS.max_golden_questions} 个不同的优先核实问题，每题最多 ${LIMITS.golden_question} 字符`);
    expect(JARGON_DECODER_SYSTEM_PROMPT).toContain(`risk_flags 最多 ${LIMITS.max_risk_flags} 项、每项最多 ${LIMITS.risk_flag} 字符`);
    expect(JARGON_DECODER_SYSTEM_PROMPT).toContain("1-49 为弱或缺少明确风险信号，50-74 为有歧义、需要核实，75-100 为存在较强且有具体文本依据的不利信号");
    expect(JARGON_DECODER_SYSTEM_PROMPT).toContain("总分与四维档位须保持最低限度一致");
    expect(JARGON_DECODER_SYSTEM_PROMPT).toContain("risk_flags 最多");
    expect(JARGON_DECODER_SYSTEM_PROMPT).toContain("内容不得重复；仅全半角、大小写或连续空白差异仍视为重复");
    expect(JARGON_DECODER_SYSTEM_PROMPT).toContain("不重复收录同一短语；仅全半角、大小写或连续空白差异仍视为同一线索");
    expect(JARGON_DECODER_SYSTEM_PROMPT).toContain("items 为空时 golden_questions 必须为 []");
    expect(JARGON_DECODER_SYSTEM_PROMPT).toContain('items 与 golden_questions 同时设为 []');
    expect(JARGON_DECODER_SYSTEM_PROMPT).toContain('"risk_flags": []');
    expect(JARGON_DECODER_SYSTEM_PROMPT).toContain("顶层及所有嵌套对象只返回上述字段，不添加额外字段");
  });

  it.each([
    ["围栏", (json: string) => ["```json", json, "```"].join("\n")],
    ["前置说明", (json: string) => `以下为初稿：\n${json}`],
    ["后置说明", (json: string) => `${json}\n仍需核实上述条件。`],
    ["追加截断内容", (json: string) => `${json}\n{"correction":`],
  ] as const)("%s 的模型回复整份拒绝，保留旧报告，纯 JSON 重试可正常保存", async (_label, wrap) => {
    expect((await post(report)).status).toBe(201);
    const before = db.prepare("SELECT * FROM jargon_decodings ORDER BY id").all();
    model.chat.mockResolvedValueOnce(wrap(JSON.stringify(report)));
    const { POST } = await import("@/app/api/tools/jargon-decodings/route");
    const response = await POST(new Request("http://localhost/api/tools/jargon-decodings", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "岗位提供弹性工作制。" }),
    }));
    expect(response.status).toBe(502);
    expect(db.prepare("SELECT * FROM jargon_decodings ORDER BY id").all()).toEqual(before);
    expect((await post(report)).status).toBe(201);
    expect(model.chat).toHaveBeenCalledTimes(3);
    expect(db.prepare("SELECT * FROM jargon_decodings ORDER BY id").all().slice(0, -1)).toEqual(before);
  });

  it.each([
    ["顶层", { ...report, internal_note: "额外字段" }],
    ["评分", { ...report, risk_ratings: { ...report.risk_ratings, note: "额外字段" } }],
    ["线索", { ...report, items: [{ ...item, note: "额外字段" }] }],
  ])("拒绝含未声明%s字段的报告且不保存", async (_label, output) => {
    expect((await post(output)).status).toBe(502);
    expect(db.prepare("SELECT * FROM jargon_decodings").all()).toHaveLength(0);
  });

  it.each([
    { items: [] },
    { targetSummary: "原报告", punchline: "需核实", items: [null], companyProfile: { teamStyle: "信息不足", riskFlags: [], cultureSummary: "尚未确认" }, goldenQuestions: [] },
    { targetSummary: "原报告", punchline: "需核实", items: [], companyProfile: { teamStyle: "信息不足", riskFlags: [null], cultureSummary: "尚未确认" }, goldenQuestions: [] },
  ])("GET 遇到损坏历史结构返回恢复状态，原始文本与报告不被改写（%#）", async (output) => {
    const source = "原文本 <T> &amp;\n弹性工作制的适用范围尚未确认。";
    db.prepare("INSERT INTO jargon_decodings (id,source_text,result,created_at) VALUES (1,?,?,'original')")
      .run(source, JSON.stringify(output));
    const before = db.prepare("SELECT * FROM jargon_decodings").all();
    const { GET } = await import("@/app/api/tools/jargon-decodings/[id]/route");
    const response = await GET(new Request("http://localhost/api/tools/jargon-decodings/1"), { params: Promise.resolve({ id: "1" }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 1, source_text: source, result: null, created_at: "original" });
    expect(db.prepare("SELECT * FROM jargon_decodings").all()).toEqual(before);
    expect(model.chat).not.toHaveBeenCalled();
  });

  it.each([
    ["只有关键词", { items: [{ keyword: "弹性工作制" }] }],
    ["缺少摘要", { ...report, target_summary: " " }],
    ["无效条目", { ...report, items: [null] }],
    ["虚构关键词", { ...report, items: [{ ...item, keyword: "无偿加班" }] }],
    ["改写关键词", { ...report, items: [{ ...item, keyword: "弹性办公" }] }],
    ["拼接关键词", { ...report, items: [{ ...item, keyword: "岗位工作制" }] }],
    ["重复关键词", { ...report, items: [item, { ...item, keyword: " 弹性工作制 " }] }],
    ["超出八项", { ...report, items: Array.from({ length: 9 }, () => item) }],
    ["缺少风险等级", { ...report, items: [{ ...item, risk_level: null }] }],
    ["缺少解释", { ...report, items: [{ ...item, hidden_meaning: "" }] }],
    ["缺少应对建议", { ...report, items: [{ ...item, interview_rule: "" }] }],
    ["缺少核实问题", { ...report, items: [{ ...item, counter_questions: [] }] }],
    ["重复核实问题", { ...report, items: [{ ...item, counter_questions: ["如何排期？", " 如何排期？ "] }] }],
    ["仅格式不同的核实问题", { ...report, items: [{ ...item, counter_questions: ["确认 API 经验吗？", "确认 ａｐｉ　经验吗！"] }] }],
    ["句末标点间有空白的核实问题", { ...report, items: [{ ...item, counter_questions: ["如何排期？", "如何排期？ \n ！"] }] }],
    ["缺少团队画像", { ...report, company_profile: {} }],
    ["缺少优先问题", { ...report, golden_questions: [] }],
    ["重复优先问题", { ...report, golden_questions: ["如何排期？", "如何排期？"] }],
    ["仅标点不同的优先问题", { ...report, golden_questions: ["最近一次紧急响应如何安排？", "最近一次紧急响应如何安排！"] }],
    ["句末标点间有空白的优先问题", { ...report, golden_questions: ["最近一次紧急响应如何安排？", "最近一次紧急响应如何安排？ \n ！"] }],
  ])("拒绝%s且不保存报告", async (_label, output) => {
    expect((await post(output)).status).toBe(502);
    expect(db.prepare("SELECT COUNT(*) AS n FROM jargon_decodings").get()).toEqual({ n: 0 });
  });

  it.each([null, true, "40", 40.5, 0, 101])("拒绝无效总分 %j", async (value) => {
    expect((await post({ ...report, overall_risk_score: value })).status).toBe(502);
    expect(db.prepare("SELECT COUNT(*) AS n FROM jargon_decodings").get()).toEqual({ n: 0 });
  });

  it("拒绝强总分与四维弱信号完全矛盾的结果，保留单维强信号的有效高分", async () => {
    const source = "岗位要求每晚无偿值班，且不允许拒绝。";
    const strongSingleDimension = {
      ...report,
      overall_risk_score: 85,
      risk_ratings: { overtime: 8, stability: 1, resources: 1, management: 1 },
      items: [{ ...item, keyword: "每晚无偿值班", risk_level: "high", risk_category: "工时与补偿" }],
    };
    for (const ratings of [
      { overtime: 3, stability: 2, resources: 1, management: 3 },
      { overtime: 6, stability: 2, resources: 1, management: 3 },
    ]) {
      expect((await post({ ...strongSingleDimension, risk_ratings: ratings }, source)).status).toBe(502);
      expect(db.prepare("SELECT COUNT(*) AS n FROM jargon_decodings").get()).toEqual({ n: 0 });
    }
    expect((await post(strongSingleDimension, source)).status).toBe(201);
    expect(savedResult().riskRatings).toEqual(strongSingleDimension.risk_ratings);
  });

  it.each([
    { label: "弱总分配强维度", overall_risk_score: 35, risk_ratings: { overtime: 7, stability: 1, resources: 1, management: 1 } },
    { label: "待核实总分配四维弱信号", overall_risk_score: 60, risk_ratings: { overtime: 3, stability: 2, resources: 1, management: 3 } },
  ])("拒绝$label的矛盾组合且不保存报告", async ({ overall_risk_score, risk_ratings }) => {
    expect((await post({ ...report, overall_risk_score, risk_ratings })).status).toBe(502);
    expect(db.prepare("SELECT COUNT(*) AS n FROM jargon_decodings").get()).toEqual({ n: 0 });
  });

  it.each(boundedFields)("拒绝超出硬上限的 $0 且不保存", async (field, limit) => {
    const output = changed(field, "字".repeat(limit + 1));
    expect((await post(output)).status).toBe(502);
    expect(db.prepare("SELECT COUNT(*) AS n FROM jargon_decodings").get()).toEqual({ n: 0 });
  });

  it.each(boundedFields)("$0 达到上限时完整保留句尾", async (field, limit) => {
    const ending = "尚待核实";
    const value = "字".repeat(limit - ending.length) + ending;
    expect((await post(changed(field, value))).status).toBe(201);
    expect(JSON.stringify(savedResult())).toContain(value);
  });

  it("拒绝超量风险标签，空数组仍有效", async () => {
    expect((await post({ ...report, company_profile: { ...report.company_profile, risk_flags: Array.from({ length: LIMITS.max_risk_flags + 1 }, () => "需核实") } })).status).toBe(502);
    expect(db.prepare("SELECT COUNT(*) AS n FROM jargon_decodings").get()).toEqual({ n: 0 });
    expect((await post({ ...report, company_profile: { ...report.company_profile, risk_flags: [] } })).status).toBe(201);
  });

  it("拒绝格式变体重复的风险标签且保留旧报告", async () => {
    expect((await post(report)).status).toBe(201);
    const before = db.prepare("SELECT * FROM jargon_decodings ORDER BY id").all();
    const output = { ...report, company_profile: { ...report.company_profile,
      risk_flags: ["On-call 边界不明", " ＯＮ－ＣＡＬＬ 边界不明 "] } };
    expect((await post(output)).status).toBe(502);
    expect(db.prepare("SELECT * FROM jargon_decodings ORDER BY id").all()).toEqual(before);
  });

  it("拒绝全半角与大小写变化后的重复原文线索", async () => {
    expect((await post(report)).status).toBe(201);
    const before = db.prepare("SELECT * FROM jargon_decodings ORDER BY id").all();
    const first = { ...item, keyword: "On-call" };
    const second = { ...item, keyword: "ＯＮ－ＣＡＬＬ", risk_category: "排班边界" };
    const output = { ...report, items: [first, second] };
    expect((await post(output, "岗位：“On-call” ＯＮ－ＣＡＬＬ 责任边界待确认。")).status).toBe(502);
    expect(db.prepare("SELECT * FROM jargon_decodings ORDER BY id").all()).toEqual(before);
  });

  it.each(["overtime", "stability", "resources", "management"])("%s 不接受小数或字符串评分", async (key) => {
    for (const value of [null, false, "4", 4.5, 0, 11]) {
      expect((await post({ ...report, risk_ratings: { ...report.risk_ratings, [key]: value } })).status).toBe(502);
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM jargon_decodings").get()).toEqual({ n: 0 });
  });

  it("有原文依据的完整报告保存并可回读", async () => {
    expect((await post(report)).status).toBe(201);
    expect(savedResult()).toMatchObject({
      overallRiskScore: 50, riskRatings: { overtime: 4 },
      items: [{ keyword: item.keyword, hiddenMeaning: item.hidden_meaning, counterQuestions: item.counter_questions }],
    });
    expect(model.chat.mock.calls[0]![2]).toMatchObject({ requireJson: "strict" });
    const { parseJargonDecoderResult } = await import("../jargon-decoder");
    expect(parseJargonDecoderResult(JSON.stringify(savedResult()))).toEqual(savedResult());
  });

  it.each(["弹性时段 < 8 小时 & 另议值班", "保留 &lt;工时&gt; 的原文", "此处是超过三十字但仍连续存在于原文中的工作时间安排说明请在面试时进一步核实"])("引文保持完整原始字符：%s", async (keyword) => {
    expect((await post({ ...report, items: [{ ...item, keyword }] }, `岗位说明：${keyword}。`)).status).toBe(201);
    expect(savedResult().items[0].keyword).toBe(keyword);
  });

  it.each([
    { source: "R&D 岗位需接受夜间值班", keyword: "R&D 岗位需接受夜间值班", copyTransport: true },
    { source: "原文保留 &lt;test&gt; 标签，值班安排待确认", keyword: "原文保留 &lt;test&gt; 标签，值班安排待确认", copyTransport: true },
    { source: "原文同时记录 &lt;test&gt; 和 <test>，均待确认", keyword: "&lt;test&gt;", copyTransport: false },
  ])("传输引文只恢复有来源的一层，保存与详情保留原文（%#）", async ({ source, keyword, copyTransport }) => {
    const wrapped = wrapUntrustedData("source_text_to_decode", keyword);
    const generated = copyTransport ? wrapped.slice(wrapped.indexOf("\n") + 1, wrapped.lastIndexOf("\n")) : keyword;
    const response = await post({ ...report, items: [{ ...item, keyword: generated }] }, source);
    expect(response.status).toBe(201);
    const saved = await response.json();
    expect(savedResult().items[0].keyword).toBe(keyword);
    expect(model.chat.mock.calls[0]![1][1].content).toContain(wrapUntrustedData("source_text_to_decode", source));
    const before = db.prepare("SELECT * FROM jargon_decodings").all();
    const { GET } = await import("@/app/api/tools/jargon-decodings/[id]/route");
    const fetched = await GET(new Request(`http://localhost/api/tools/jargon-decodings/${saved.id}`), {
      params: Promise.resolve({ id: String(saved.id) }),
    });
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toMatchObject({ source_text: source, result: { items: [{ keyword }] } });
    expect(db.prepare("SELECT * FROM jargon_decodings").all()).toEqual(before);
  });

  it.each([
    { source: "夜间值班 < 3 次", keyword: "夜间值班 &amp;lt; 3 次" },
    { source: '值班条件 "另议"', keyword: "值班条件 &quot;另议&quot;" },
    { source: "值班次数 < 3", keyword: "值班次数 &#60; 3" },
    { source: "R&D 夜间值班", keyword: "R&amp;D 夜间已取消" },
    { source: "&", keyword: "&amp;" },
  ])("传输引文不递归解码、不扩展实体或补造事实（%#）", async ({ source, keyword }) => {
    expect((await post(noSignal, "既有中性说明")).status).toBe(201);
    const before = db.prepare("SELECT * FROM jargon_decodings").all();
    expect((await post({ ...report, items: [{ ...item, keyword }] }, source)).status).toBe(502);
    expect(db.prepare("SELECT * FROM jargon_decodings").all()).toEqual(before);
  });

  it("传输引文恢复后与原始引文重复时拒绝整份报告", async () => {
    const source = "R&D 岗位需接受夜间值班";
    const output = { ...report, items: [{ ...item, keyword: source }, { ...item, keyword: "R&amp;D 岗位需接受夜间值班" }] };
    expect((await post(output, source)).status).toBe(502);
    expect(db.prepare("SELECT * FROM jargon_decodings").all()).toEqual([]);
  });

  it("明确无相关线索时保存完整空报告，不补造风险条目", async () => {
    expect((await post(noSignal, "负责维护业务系统。" )).status).toBe(201);
    expect(savedResult()).toMatchObject({ items: [], goldenQuestions: [], punchline: noSignal.punchline,
      overallRiskScore: 1, companyProfile: { riskFlags: [] } });
    expect((await post({ ...noSignal, golden_questions: report.golden_questions }, "负责维护业务系统。" )).status).toBe(502);
  });

  it.each([
    { label: "总分进入待核实档", output: { ...noSignal, overall_risk_score: 50 } },
    { label: "总分达到待核实档上界", output: { ...noSignal, overall_risk_score: 74 } },
    { label: "总分与维度同时进入强信号档", output: { ...noSignal, overall_risk_score: 85, risk_ratings: { ...noSignal.risk_ratings, overtime: 8 } } },
    ...["overtime", "stability", "resources", "management"].map((key) => ({
      label: `${key} 进入待核实档`, output: { ...noSignal, risk_ratings: { ...noSignal.risk_ratings, [key]: 4 } },
    })),
    { label: "仍有风险标签", output: { ...noSignal, company_profile: { ...report.company_profile, risk_flags: ["工时边界不明"] } } },
  ])("空线索报告$label时整份拒绝，旧报告保持原样", async ({ output }) => {
    expect((await post(report)).status).toBe(201);
    const before = db.prepare("SELECT * FROM jargon_decodings ORDER BY id").all();
    expect((await post(output, "负责维护业务系统。")).status).toBe(502);
    expect(db.prepare("SELECT * FROM jargon_decodings ORDER BY id").all()).toEqual(before);
  });

  it("空线索低档上界完整保存，不把评分改为固定默认值", async () => {
    const output = { ...noSignal, overall_risk_score: 49, risk_ratings: { overtime: 3, stability: 2, resources: 1, management: 3 } };
    expect((await post(output, "负责维护业务系统。")).status).toBe(201);
    expect(savedResult()).toMatchObject({ overallRiskScore: 49, riskRatings: output.risk_ratings,
      items: [], goldenQuestions: [], companyProfile: { riskFlags: [] } });
    const system = model.chat.mock.calls[0]![1][0].content;
    expect(system).toContain("items 为空时，总分仅可处于 1-49 档、四维评分仅可处于 1-3 档，risk_flags 必须为 []");
    expect(system).toContain("弱信号或无信号不代表安全");
  });

  it("历史空线索高分报告仍可原样读取，不套用新生成限制", async () => {
    const historical = {
      targetSummary: noSignal.target_summary, punchline: noSignal.punchline, overallRiskScore: 85,
      riskRatings: { overtime: 8, stability: 1, resources: 1, management: 1 }, items: [], goldenQuestions: [],
      companyProfile: { teamStyle: "信息不足", riskFlags: ["待核实工时"], cultureSummary: "原有记录" },
    };
    db.prepare("INSERT INTO jargon_decodings (id,source_text,result,created_at) VALUES (1,?,?,'original')")
      .run("历史原文", JSON.stringify(historical));
    const before = db.prepare("SELECT * FROM jargon_decodings").all();
    const { GET } = await import("@/app/api/tools/jargon-decodings/[id]/route");
    const response = await GET(new Request("http://localhost/api/tools/jargon-decodings/1"), { params: Promise.resolve({ id: "1" }) });
    expect(response.status).toBe(200);
    expect((await response.json()).result).toEqual(historical);
    expect(db.prepare("SELECT * FROM jargon_decodings").all()).toEqual(before);
    expect(model.chat).not.toHaveBeenCalled();
  });
});
