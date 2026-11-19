import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REMEDY_OUTPUT_LIMITS as LIMITS, parseRemedyResult } from "../career-gap-remedy";
import { CAREER_GAP_REMEDY_SYSTEM_PROMPT } from "../career-gap-remedy-llm";

const model = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock("@/lib/llm", async (original) => ({
  ...await original<typeof import("@/lib/llm")>(), chat: model.chat,
}));
const PREFIX = "resume-life-gap-output-";
let directory: string;
let db: DatabaseSync;
const report = {
  title: "休整后的求职沟通", punchline: "按事实说明休整，不虚构学习成果",
  hr_mindset_analysis: { core_concerns: [], risk_points: [], what_hr_wants_to_hear: "目前没有足够信息判断招聘方关注点。" },
  reframe_formula: { fact_acknowledgment: "离职后休息六个月", positive_attribution: "[待补充：真实原因]",
    growth_and_value: "未提供学习或项目，不添加成果", motivation_alignment: "[待补充：真实岗位目标或后续计划]" },
  scripts: {
    concise: { label: "精炼版", applicable_scene: "初步沟通", script: "离职后我休息了六个月，没有学习或做项目。", key_points: ["保留事实"] },
    detailed: { label: "详细版", applicable_scene: "进一步沟通", script: "这六个月主要用于休息，未提供其他成果。", key_points: ["尊重边界"] },
    pivoting: { label: "衔接版", applicable_scene: "讨论岗位", script: "[待补充：希望讨论的岗位职责]", key_points: ["不虚构动机"] },
  },
  drills: [{ question: "你希望接下来讨论哪些岗位方向？", hr_concern: "了解求职方向", best_response: "[待补充：真实求职方向]" }],
  forbidden_list: ["不虚构学习或项目经历"], closing_tips: ["只披露愿意说明的相关信息"],
};

beforeEach(async () => {
  vi.resetModules();
  model.chat.mockReset();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.prepare("INSERT INTO resignation_gap_remedies (id,scenario_type,raw_story,target_role,persona_style,result,created_at) VALUES (1,'gap','历史经历','','pragmatic',?,'original')")
    .run(JSON.stringify({ historical: "原报告保持完整" }));
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

function changed(field: string, value: unknown): unknown {
  const output = structuredClone(report) as Record<string, unknown>;
  const keys = field.split(".");
  let target = output;
  for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
  target[keys.at(-1)!] = value;
  return output;
}
function rows() {
  return db.prepare("SELECT * FROM resignation_gap_remedies ORDER BY id").all();
}
async function generate(output: unknown, body: Record<string, unknown> = {}) {
  model.chat.mockResolvedValueOnce(JSON.stringify(output));
  const { POST } = await import("@/app/api/tools/career-gap-remedies/route");
  return POST(new Request("http://localhost/api/tools/career-gap-remedies", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scenarioType: "gap", rawStory: "离职后休息六个月，没有学习或项目", ...body }),
  }));
}
const textFields: [string, number][] = [
  ["title", LIMITS.title], ["punchline", LIMITS.punchline],
  ["hr_mindset_analysis.what_hr_wants_to_hear", LIMITS.analysis],
  ...["fact_acknowledgment", "positive_attribution", "growth_and_value", "motivation_alignment"]
    .map((key): [string, number] => [`reframe_formula.${key}`, LIMITS.formula]),
  ...["concise", "detailed", "pivoting"].flatMap((key): [string, number][] => [
    [`scripts.${key}.label`, LIMITS.label], [`scripts.${key}.applicable_scene`, LIMITS.scene], [`scripts.${key}.script`, LIMITS.script],
    [`scripts.${key}.key_points.0`, LIMITS.listItem],
  ]),
  ["hr_mindset_analysis.core_concerns.0", LIMITS.listItem], ["hr_mindset_analysis.risk_points.0", LIMITS.listItem],
  ["drills.0.question", LIMITS.drillQuestion], ["drills.0.hr_concern", LIMITS.drillConcern], ["drills.0.best_response", LIMITS.drillResponse],
  ["forbidden_list.0", LIMITS.adviceItem], ["closing_tips.0", LIMITS.adviceItem],
];

describe("空窗沟通方案的表达偏好与事实材料", () => {
  it.each(["——", "（）", "「」 \n\t", "\u200b", "（\u200b）？"])("拒绝无内容招聘追问 %j，保留历史方案", async (question) => {
    const before = rows();
    expect((await generate(changed("drills.0.question", question))).status).toBe(502);
    expect(rows()).toEqual(before);
  });

  it("有效招聘追问保留技术符号，不以问号判断有无内容", async () => {
    const question = "请说明下一份工作是否考虑 C++ / C# 岗位";
    expect((await generate(changed("drills.0.question", question))).status).toBe(201);
    expect(parseRemedyResult(String(rows().at(-1)!.result))?.drills[0]?.question).toBe(question);
    expect(model.chat.mock.calls[0]![1][0].content).toContain("问题不得只含标点或空白");
    expect(model.chat.mock.calls[0]![1][0].content).toContain("也不得仅用零宽、控制字符等不可见字符占位");
  });

  it.each([
    ["title", "\u200b\u2060"],
    ["scripts.concise.script", "!!!"],
    ["closing_tips.0", "\u200b"],
  ])("拒绝必填生成文本 %s 仅含不可见字符或标点并保留旧报告", async (field, placeholder) => {
    const before = rows();
    expect((await generate(changed(field, placeholder))).status).toBe(502);
    expect(rows()).toEqual(before);
    expect(model.chat.mock.calls[0]![1][0].content).toContain("文本和列表条目均须非空并包含可见内容");
  });

  it("中文说明保留真实公司专名，不要求把协议键或公司名翻译为中文", async () => {
    const script = "我从 Example Labs 离职后休息了六个月，没有学习或做项目。";
    const response = await generate(changed("scripts.concise.script", script), {
      rawStory: "离职后休息六个月，没有学习或项目；原公司名为 Example Labs。",
    });
    expect(response.status).toBe(201);
    const system = model.chat.mock.calls[0]![1][0].content;
    expect(system).toContain("说明性文字使用中文");
    expect(system).toContain("JSON 字段名、规定枚举、原文引文、技术名称和公司/产品专名保留原样");
    expect(system).not.toContain("纯中文输出");
    expect(parseRemedyResult(String(rows().at(-1)!.result))?.scripts.concise.script).toBe(script);
  });

  it.each([
    ["resignation", "仅离职原因"],
    ["gap", "仅空窗期（Gap）"],
    ["both", "离职原因与空窗期综合沟通"],
  ] as const)("%s 场景在受信输入中明确告知模型", async (scenarioType, label) => {
    const response = await generate(report, { scenarioType });
    expect(response.status).toBe(201);
    const [, messages] = model.chat.mock.calls[0]! as [string, { role: string; content: string }[]];
    expect(messages[0]!.content).toContain("先按用户选择的场景筛选各字段可用的材料");
    expect(messages[0]!.content).toContain("后续字段均使用这份选材范围，不因需要填满结构而扩大主题");
    expect(messages.find(message => message.role === "user")!.content).toContain(`【沟通场景】\n${label}`);
  });

  it("系统提示中的 forbidden_list 单项上限与生成校验一致", () => {
    expect(CAREER_GAP_REMEDY_SYSTEM_PROMPT).toContain(`forbidden_list 最多 ${LIMITS.forbiddenItems} 项且每项 ${LIMITS.adviceItem}`);
    expect(CAREER_GAP_REMEDY_SYSTEM_PROMPT).toMatch(new RegExp(`"best_response": "[^"\\n]*最多${LIMITS.drillResponse}字符`));
    expect(CAREER_GAP_REMEDY_SYSTEM_PROMPT).not.toContain("best_response 150字以内");
    expect(CAREER_GAP_REMEDY_SYSTEM_PROMPT).toContain("建议控制在50字以内");
    expect(CAREER_GAP_REMEDY_SYSTEM_PROMPT).toContain("建议控制在100字以内");
    expect(CAREER_GAP_REMEDY_SYSTEM_PROMPT).toContain("以下为保存硬上限");
    expect(CAREER_GAP_REMEDY_SYSTEM_PROMPT).toContain("没有具体事项时返回 []，不为填充栏目制造禁忌");
    expect(CAREER_GAP_REMEDY_SYSTEM_PROMPT).toContain("pivoting 仍受所选场景限制");
    expect(CAREER_GAP_REMEDY_SYSTEM_PROMPT).toContain("目标岗位未提供或明确未定时，保留这个状态并用具体岗位占位");
    expect(CAREER_GAP_REMEDY_SYSTEM_PROMPT).toContain("字段名为兼容既有 JSON 结构；只建议补充岗位相关信息");
    expect(CAREER_GAP_REMEDY_SYSTEM_PROMPT).toContain("JSON 键名不代表必须写出成长价值");
    expect(CAREER_GAP_REMEDY_SYSTEM_PROMPT).toContain('"core_concerns": [],');
    expect(CAREER_GAP_REMEDY_SYSTEM_PROMPT).toContain('"risk_points": [],');
    expect(CAREER_GAP_REMEDY_SYSTEM_PROMPT).toContain('"forbidden_list": [],');
    expect(CAREER_GAP_REMEDY_SYSTEM_PROMPT).not.toContain("材料支持的可能招聘关注点，使用条件式表达");
    expect(CAREER_GAP_REMEDY_SYSTEM_PROMPT).not.toContain("针对本次表达应避免的具体失实");
  });

  it("沟通场景示例不预设面试轮次或面试官身份", () => {
    expect(CAREER_GAP_REMEDY_SYSTEM_PROMPT).toContain("适用于希望简要说明经历的沟通场合");
    expect(CAREER_GAP_REMEDY_SYSTEM_PROMPT).toContain("对方希望进一步了解背景、行动与后续安排时");
    expect(CAREER_GAP_REMEDY_SYSTEM_PROMPT).not.toContain("HR 电调初步筛查");
    expect(CAREER_GAP_REMEDY_SYSTEM_PROMPT).not.toContain("二面业务主管或 HR 高级总监");
    expect(CAREER_GAP_REMEDY_SYSTEM_PROMPT).toContain("只返回上述字段，不添加任何顶层或嵌套字段");
  });

  it.each([
    ["顶层", (output: typeof report) => ({ ...output, internal_note: "额外内容" })],
    ["话术", (output: typeof report) => ({ ...output, scripts: { ...output.scripts, concise: { ...output.scripts.concise, note: "额外内容" } } })],
    ["追问", (output: typeof report) => ({ ...output, drills: [{ ...output.drills[0]!, note: "额外内容" }] })],
  ])("拒绝含未声明%s字段的模型结果，不覆盖历史方案", async (_label, addExtra) => {
    const response = await generate(addExtra(report));
    expect(response.status).toBe(502);
    expect(rows()).toHaveLength(1);
    expect(JSON.parse(String(rows()[0]!.result))).toEqual({ historical: "原报告保持完整" });
  });

  it("没有具体禁忌时保存并回读空列表，不补造通用批评", async () => {
    const response = await generate(changed("forbidden_list", []));
    expect(response.status).toBe(201);
    const { id } = await response.json();
    const { GET } = await import("@/app/api/tools/career-gap-remedies/[id]/route");
    const detail = await (await GET(new Request(`http://localhost/api/tools/career-gap-remedies/${id}`), { params: Promise.resolve({ id: String(id) }) })).json();
    expect(detail.result.forbiddenList).toEqual([]);
    expect(detail.result.forbiddenList).not.toContain("切忌在面试中发泄对前司或前领导的负面情绪");
  });

  it.each(["scenarioType", "targetRole", "personaStyle"].flatMap(field =>
    [null, true, 42, ["待保留的配置"], {}, { toString: null }].map(value => ({ field, value }))))(
    "$field 类型错误 $value 时不丢弃材料或保存默认配置", async ({ field, value }) => {
      const before = rows();
      const response = await generate(report, { [field]: value });
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect((await response.json()).error).toEqual(expect.any(String));
      expect(model.chat).not.toHaveBeenCalled();
      expect(rows()).toEqual(before);
    },
  );

  it.each([
    { scenarioType: undefined, personaStyle: undefined, targetRole: undefined },
    { scenarioType: "unsupported", personaStyle: "unsupported", targetRole: "  " },
  ])("省略字段及既有未知字符串 %# 仍沿用默认配置", async body => {
    const response = await generate(report, body);
    expect(response.status).toBe(201);
    expect(rows().at(-1)).toMatchObject({ scenario_type: "both", persona_style: "pragmatic", target_role: "" });
    expect(model.chat).toHaveBeenCalledOnce();
  });

  it("模型忽略取消仍返回合法输出时，保存前检查取消，不追加报告或改写旧记录", async () => {
    const original = rows();
    const pending = Promise.withResolvers<string>(); model.chat.mockReturnValueOnce(pending.promise);
    const controller = new AbortController();
    const { POST } = await import("@/app/api/tools/career-gap-remedies/route");
    const response = POST(new Request("http://localhost/api/tools/career-gap-remedies", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rawStory: "休息两个月，没有学习或项目" }), signal: controller.signal,
    }));
    await vi.waitFor(() => expect(model.chat).toHaveBeenCalledOnce());
    controller.abort(); pending.resolve(JSON.stringify(report));
    expect((await response).status).toBeGreaterThanOrEqual(500);
    expect(rows()).toEqual(original);
  });
  it.each([
    ["pragmatic", "pragmatic"], ["driven", "driven"], ["composed", "composed"], ["unsupported", "pragmatic"],
  ] as const)("表达偏好 %s 选择 %s 的固定描述，原始事实与输出字段完整保存", async (requestedStyle, savedStyle) => {
    const rawStory = "离职后休息六个月，没有学习或项目。仍有个人安排，到岗时间待确认；不希望展开家庭细节。";
    const targetRole = "平台开发 & TypeScript <维护方向>";
    const original = rows();
    const response = await generate(report, { rawStory, targetRole, personaStyle: requestedStyle });
    expect(response.status).toBe(201);
    expect(model.chat).toHaveBeenCalledTimes(1);
    const [, messages, options] = model.chat.mock.calls[0]! as [string, { role: string; content: string }[], { requireJson: "strict"; signal: AbortSignal }];
    const { CAREER_GAP_TONE_DESCRIPTIONS } = await import("../career-gap-remedy-llm");
    const { wrapUntrustedData } = await import("../prompt-safety");
    const user = messages.find((message) => message.role === "user")!.content;
    expect(messages[0]!.content).toContain("未说明时写[待补充：真实原因]");
    expect(messages[0]!.content).toContain("未说明时写[待补充：真实岗位目标或后续计划]");
    expect(user).toContain(CAREER_GAP_TONE_DESCRIPTIONS[savedStyle]);
    for (const [style, description] of Object.entries(CAREER_GAP_TONE_DESCRIPTIONS)) {
      if (style !== savedStyle) expect(user).not.toContain(description);
    }
    expect(user).toContain(wrapUntrustedData("raw_story", rawStory));
    expect(user).toContain(wrapUntrustedData("target_role", targetRole));
    expect(messages[0]!.content).not.toContain(rawStory);
    expect(messages[0]!.content).not.toContain(targetRole);
    expect(options.requireJson).toBe("strict");
    expect(options.signal).toBeInstanceOf(AbortSignal);
    const saved = rows();
    expect(saved.slice(0, -1)).toEqual(original);
    expect(saved.at(-1)).toMatchObject({ persona_style: savedStyle, raw_story: rawStory, target_role: targetRole });
    const { normalizeRemedyResult } = await import("../career-gap-remedy");
    expect(JSON.parse(String(saved.at(-1)!.result))).toEqual(normalizeRemedyResult(report));
  });
});

describe("离职与空窗方案生成的完整保存", () => {
  it.each([5, 6])("%i 个不同追问按数量上限处理，不由重复检查代替数量校验", async (count) => {
    const before = rows();
    const questions = ["何时离职？", "离职原因是什么？", "交接安排是什么？", "休整持续多久？", "期间有哪些安排？", "目前希望求职的方向是什么？"];
    const drills = questions.slice(0, count).map(question => ({ ...report.drills[0]!, question }));
    const response = await generate(changed("drills", drills), { scenarioType: "both" });
    expect(response.status).toBe(count === LIMITS.drills ? 201 : 502);
    if (count === LIMITS.drills) {
      expect(rows().slice(0, -1)).toEqual(before);
      expect(parseRemedyResult(String(rows().at(-1)!.result))?.drills.map(drill => drill.question)).toEqual(questions.slice(0, count));
    } else {
      expect(rows()).toEqual(before);
    }
  });

  it.each([false, true])("原因缺项=%s 时完整保存零题或一题，并原样回读与接受备份", async (missingReason) => {
    const before = rows();
    const reason = missingReason ? "[待补充：双方不续签的真实原因]" : "双方仅因该阶段项目结束决定不续签。";
    const script = `我的数据分析师合同于2024年12月31日到期，${reason}我已完成报表与口径文档交接，希望继续从事数据分析工作。`;
    const output = {
      ...structuredClone(report),
      title: "合同到期后的离职说明", punchline: "如实说明合同到期与不续签情况",
      hr_mindset_analysis: { core_concerns: [], risk_points: [], what_hr_wants_to_hear: missingReason ? "补充双方不续签的原因。" : "按已知事实说明离职即可。" },
      reframe_formula: { fact_acknowledgment: "合同于2024年12月31日到期", positive_attribution: reason,
        growth_and_value: "已完成报表与口径文档交接", motivation_alignment: "继续应聘数据分析师，衔接报表与口径核对经历" },
      scripts: {
        concise: { ...report.scripts.concise, script },
        detailed: { ...report.scripts.detailed, script },
        pivoting: { ...report.scripts.pivoting, script },
      },
      drills: missingReason ? [{ question: "双方决定不续签的原因是什么？", hr_concern: "核实不续签原因", best_response: reason }] : [],
      forbidden_list: [], closing_tips: ["按事实说明合同与交接情况。"],
    };
    const rawStory = `上一份工作是数据分析师，负责月度销售报表与指标口径核对。固定期限合同于2024年12月31日到期。${missingReason ? "双方决定不续签，原因尚未在材料中说明。" : reason}我已按约定完成报表与口径文档交接。希望继续应聘数据分析师，岗位衔接就用上述报表与口径核对经历说明。`;
    const response = await generate(output, { scenarioType: "resignation", targetRole: "数据分析师", rawStory });
    expect(response.status).toBe(201);
    const { id } = await response.json();
    expect(rows().slice(0, -1)).toEqual(before);
    const { normalizeRemedyResult } = await import("../career-gap-remedy");
    const expected = normalizeRemedyResult(output);
    expect(expected?.drills).toHaveLength(missingReason ? 1 : 0);
    expect(JSON.parse(String(rows().at(-1)!.result))).toEqual(expected);
    const { GET: getList } = await import("@/app/api/tools/career-gap-remedies/route");
    const list = await (await getList(new Request("http://localhost/api/tools/career-gap-remedies"))).json();
    expect(parseRemedyResult(list.items.find((item: { id: number }) => item.id === id).result)).toEqual(expected);
    const { GET: getDetail } = await import("@/app/api/tools/career-gap-remedies/[id]/route");
    const detail = await (await getDetail(new Request(`http://localhost/api/tools/career-gap-remedies/${id}`), { params: Promise.resolve({ id: String(id) }) })).json();
    expect(detail.result).toEqual(expected);
    const { invalidDomainColumn } = await import("../backup-domain");
    expect(invalidDomainColumn("resignation_gap_remedies", rows().at(-1)!)).toBeUndefined();
    expect(model.chat).toHaveBeenCalledOnce();
  });

  it.each([
    ["围栏", (json: string) => ["```json", json, "```"].join("\n")],
    ["前置说明", (json: string) => `以下为初稿：\n${json}`],
    ["后置说明", (json: string) => `${json}\n仍需核实上述条件。`],
    ["追加截断内容", (json: string) => `${json}\n{"correction":`],
  ] as const)("%s 的模型回复整份拒绝，保留旧方案，纯 JSON 重试可正常保存", async (_label, wrap) => {
    const before = rows();
    model.chat.mockResolvedValueOnce(wrap(JSON.stringify(report)));
    const { POST } = await import("@/app/api/tools/career-gap-remedies/route");
    const response = await POST(new Request("http://localhost/api/tools/career-gap-remedies", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rawStory: "离职后休息六个月，没有学习或项目" }),
    }));
    expect(response.status).toBe(502);
    expect(rows()).toEqual(before);
    expect((await generate(report)).status).toBe(201);
    expect(model.chat).toHaveBeenCalledTimes(2);
    expect(rows().slice(0, -1)).toEqual(before);
  });

  it.each([true, { concise: { script: "仅有脚本，缺少分析与其他字段" } }])("读取损坏旧报告 scripts=%j 时返回恢复状态，原始经历和记录保持完整", async (scripts) => {
    const originalResult = JSON.stringify({ title: "损坏旧报告", scripts });
    db.prepare("UPDATE resignation_gap_remedies SET result = ? WHERE id = 1").run(originalResult);
    const before = rows();
    const { GET } = await import("@/app/api/tools/career-gap-remedies/[id]/route");
    const response = await GET(new Request("http://localhost/api/tools/career-gap-remedies/1"), { params: Promise.resolve({ id: "1" }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: 1, raw_story: "历史经历", result: null });
    expect(rows()).toEqual(before);
    expect(model.chat).not.toHaveBeenCalled();
  });

  it.each(textFields)("%s 超限时整份拒绝，保留历史方案", async (field, limit) => {
    const original = rows();
    expect((await generate(changed(field, "字".repeat(limit + 1)))).status).toBe(502);
    expect(rows()).toEqual(original);
  });

  it.each(textFields)("%s 达到上限时完整保存，句尾限定不丢失", async (field, limit) => {
    const ending = "尚未完成";
    const value = "字".repeat(limit - ending.length) + ending;
    const output = changed(field, value);
    const response = await generate(output);
    expect(response.status).toBe(201);
    const { normalizeRemedyResult } = await import("../career-gap-remedy");
    const saved = JSON.parse(String(rows().at(-1)!.result));
    expect(saved).toEqual(normalizeRemedyResult(output));
    expect(JSON.stringify(saved)).toContain(value);
    expect(parseRemedyResult(JSON.stringify(saved))).toEqual(saved);
  });

  it.each([
    ["hr_mindset_analysis.core_concerns", Array(6).fill("关注点")],
    ["hr_mindset_analysis.risk_points", Array(6).fill("表述风险")],
    ["scripts.concise.key_points", Array(6).fill("要点")],
    ["scripts.detailed.key_points", Array(6).fill("要点")],
    ["scripts.pivoting.key_points", Array(6).fill("要点")],
    ["drills", Array(6).fill(report.drills[0])],
    ["forbidden_list", Array(9).fill("建议")],
    ["closing_tips", Array(6).fill("提示")],
    ["hr_mindset_analysis.core_concerns", undefined],
    ["hr_mindset_analysis.risk_points", null],
    ["scripts.pivoting.key_points", ["保留事实", null]],
    ["drills", [report.drills[0], { question: "缺少回答" }]],
    ["drills", undefined],
    ["drills", null],
    ["drills", {}],
    ["drills", ""],
    ["drills", [null]],
    ["drills", [{}]],
  ])("%s 超项或无效时不静默丢弃内容", async (field, value) => {
    const original = rows();
    expect((await generate(changed(field as string, value))).status).toBe(502);
    expect(rows()).toEqual(original);
  });

  it("拒绝仅首尾空白不同的重复追问，不覆盖历史方案", async () => {
    const original = rows();
    const output = changed("drills", [
      report.drills[0],
      { ...report.drills[0], question: `  ${report.drills[0]!.question}  ` },
    ]);
    expect((await generate(output)).status).toBe(502);
    expect(rows()).toEqual(original);
  });

  it("拒绝全半角、空白、大小写和句末标点不同的重复追问", async () => {
    const original = rows();
    const output = changed("drills", [
      { ...report.drills[0]!, question: "确认 API 经验吗？" },
      { ...report.drills[0]!, question: "确认 ａｐｉ　经验吗！" },
    ]);
    expect((await generate(output)).status).toBe(502);
    expect(rows()).toEqual(original);
  });

  it("无明确顾虑时接受空分析数组，列表接口回读不补造风险", async () => {
    const response = await generate(report);
    expect(response.status).toBe(201);
    const { id } = await response.json();
    const { GET } = await import("@/app/api/tools/career-gap-remedies/route");
    const page = await (await GET(new Request("http://localhost/api/tools/career-gap-remedies"))).json();
    const stored = parseRemedyResult(page.items.find((item: { id: number }) => item.id === id).result);
    expect(stored?.hrMindsetAnalysis).toEqual({ coreConcerns: [], riskPoints: [], whatHrWantsToHear: report.hr_mindset_analysis.what_hr_wants_to_hear });
    expect(stored?.scripts.concise.script).toBe(report.scripts.concise.script);
    const { invalidDomainColumn } = await import("../backup-domain");
    expect(invalidDomainColumn("resignation_gap_remedies", rows().at(-1)!)).toBeUndefined();
  });

  it("句末标点间有空白的重复追问整份拒绝，旧方案不变且可重试", async () => {
    const original = rows();
    const output = changed("drills", [
      { ...report.drills[0]!, question: "确认 API 经验吗？" },
      { ...report.drills[0]!, question: "确认 API 经验吗？ \n ！" },
    ]);
    expect((await generate(output)).status).toBe(502);
    expect(rows()).toEqual(original);
    expect((await generate(report)).status).toBe(201);
    expect(rows().slice(0, -1)).toEqual(original);
  });
});
