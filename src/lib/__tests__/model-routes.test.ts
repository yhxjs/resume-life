import { beforeEach, describe, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({
  chat: vi.fn(), run: vi.fn(() => ({ lastInsertRowid: 1, changes: 1 })),
  acquireCommandLock: vi.fn<(_: string) => (() => void) | null>(() => () => {}),
}));
vi.mock("../llm", async (importOriginal) => ({ ...await importOriginal<typeof import("../llm")>(), chat: boundary.chat }));
vi.mock("../db", () => ({
  now: () => "2026-09-15T00:00:00Z", acquireCommandLock: boundary.acquireCommandLock,
  dataGeneration: () => "test-generation",
  requestDataGeneration: () => "test-generation",
  inTransaction: <T>(fn: () => T): T => fn(),
  getDb: () => ({ prepare: () => ({
    get: () => ({ id: 1, resume_id: 1, jd: "TypeScript", status: "ongoing", initial_offer: "30k", target_company_tier: "startup", target_role: "工程师", expected_salary: "35k", current_or_competing_offer: "28k", hr_style: "friendly", report: "", sentences: '[{"text":"我擅长工程建设","comment":"旧点评"}]', updated_at: "2026-09-15T00:00:00Z" }),
    all: () => [], run: boundary.run,
  }) }),
}));
vi.mock("../resumes", () => ({ loadResumeContext: () => "TypeScript 工程经验" }));
vi.mock("../intro-resume-context", async (original) => ({
  ...await original<typeof import("../intro-resume-context")>(),
  loadIntroResumeContext: () => "TypeScript 工程经验",
}));

import { POST as portrait } from "../../app/api/tools/jd-portraits/route";
import { POST as decoder } from "../../app/api/tools/jargon-decodings/route";
import { POST as remedy } from "../../app/api/tools/career-gap-remedies/route";
import { POST as regenerate } from "../../app/api/intros/[id]/regenerate/route";
import { POST as recomment } from "../../app/api/intros/[id]/recomment/route";
import { POST as finalize } from "../../app/api/tools/salary-negotiations/[id]/finalize/route";
import { POST as defenseScan } from "../../app/api/tools/resume-defenses/route";
import { readSalaryNegotiationRevision } from "../salary-negotiation-snapshot";
import { RESUME_DEFENSE_OUTPUT_LIMITS as DEFENSE_LIMITS } from "../resume-defense";
import { RESUME_DEFENSE_SCAN_SYSTEM_PROMPT } from "../resume-defense-llm";

const cases = [
  { name: "JD画像", route: portrait, body: { jd: "TypeScript" } },
  { name: "黑话解码", route: decoder, body: { text: "抗压能力" } },
  { name: "经历重塑", route: remedy, body: { rawStory: "换工作" } },
  { name: "自介重新生成", route: regenerate, body: { kind: "30s" } },
  { name: "自介重新点评", route: recomment, body: { kind: "30s" } },
  { name: "薪资复盘", route: finalize, body: { expected_revision: readSalaryNegotiationRevision(1) } },
  { name: "简历排雷", route: defenseScan, body: { resumeContent: "负责核心系统优化" } },
];
const context = () => ({ params: Promise.resolve({ id: "1" }) });
const request = (body: unknown) => new Request("http://localhost/mock", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const validRemedy = {
  title: "经历重塑", punchline: "保持真实并突出成长",
  hr_mindset_analysis: { core_concerns: ["稳定性"], risk_points: ["空窗解释"], what_hr_wants_to_hear: "投入稳定" },
  reframe_formula: { fact_acknowledgment: "承认事实", positive_attribution: "积极归因", growth_and_value: "展现成长", motivation_alignment: "对齐岗位" },
  scripts: {
    concise: { label: "精炼", applicable_scene: "面试开场", script: "我希望承担更大责任", key_points: ["坦诚"] },
    detailed: { label: "详细", applicable_scene: "深挖追问", script: "这段经历让我成长", key_points: ["复盘"] },
    pivoting: { label: "导流", applicable_scene: "继续沟通", script: "我也关注岗位挑战", key_points: ["对齐"] },
  },
  drills: [{ question: "为什么离开？", hr_concern: "稳定性", best_response: "已经妥善解决" }],
  forbidden_list: ["攻击前司"], closing_tips: ["保持从容"],
};
const validReport = { final_package_summary: "35k", score: 80, leverage_efficiency: "表现稳健", turn_critiques: [], real_world_tips: ["核对带宽"], mentor_summary: "表现良好" };
const defenseItem = {
  original_text: "负责核心系统优化", section_hint: "工作经历", risk_level: "medium", risk_type: "vague_phrase",
  interviewer_roast: "请补充具体动作与职责边界", deadly_questions: ["具体优化了哪一部分？", "你个人完成了哪些工作？"],
  defense_plan: { interviewer_intent: "核实贡献", standard_defense: "我参与了核心系统优化，[待补充：个人职责与具体行动]。", taboo_mistakes: ["编造指标"] },
};
const defenseReport = { risk_level: "medium", overall_roast: "该表述缺少具体动作，建议补充可核实的职责与成果。", items: [defenseItem] };
function changedDefenseField(field: string, value: unknown) {
  const output = structuredClone(defenseReport) as Record<string, unknown>;
  let target = output;
  const keys = field.split(".");
  for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
  target[keys.at(-1)!] = value;
  return output;
}
const defenseBoundedFields: [string, number][] = [
  ["overall_roast", DEFENSE_LIMITS.overall_roast], ["items.0.section_hint", DEFENSE_LIMITS.section_hint],
  ["items.0.interviewer_roast", DEFENSE_LIMITS.interviewer_roast], ["items.0.deadly_questions.0", DEFENSE_LIMITS.deadly_question],
  ["items.0.defense_plan.interviewer_intent", DEFENSE_LIMITS.interviewer_intent],
  ["items.0.defense_plan.standard_defense", DEFENSE_LIMITS.standard_defense],
  ["items.0.defense_plan.taboo_mistakes.0", DEFENSE_LIMITS.taboo_mistake],
];
beforeEach(() => { boundary.chat.mockReset(); boundary.run.mockClear(); boundary.acquireCommandLock.mockReset().mockReturnValue(() => {}); });

describe.each(cases)("$name 模型输出边界", ({ route, body }) => {
  it.each(["not-json", "```json\n{broken}\n```", "null", "[]", "{}", '{"scripts": {"concise": "wrong"}}'])("不合法输出返回 JSON 502 且不写库：%s", async (output) => {
    boundary.chat.mockResolvedValue(output);
    const req = request(body);
    const response = await route(req, context());
    expect(response.status).toBe(502);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({ error: expect.any(String) });
    expect(boundary.run).not.toHaveBeenCalled();
    expect(boundary.chat.mock.calls[0]?.[2]?.signal).toBe(req.signal);
  });
});

it.each([0, 1, 2])("JD 画像允许保存 %i 个有依据的技能，不为雷达图凑轴", async (count) => {
  const skills = Array.from({ length: count }, (_, index) => ({ name: `技能${index + 1}`, weight: 8, why: "JD 明确要求" }));
  boundary.chat.mockResolvedValue(JSON.stringify({
    role: count ? "开发岗位" : "岗位信息不足",
    must_skills: skills,
    followups: [],
    company_style: { style: "信息不足", signals: [] },
  }));
  const response = await portrait(request({ jd: count ? "合成岗位要求" : "欢迎加入我们" }));
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ id: 1 });
  expect(boundary.run).toHaveBeenCalledOnce();
  expect(boundary.run).toHaveBeenCalledWith(expect.any(String), JSON.stringify({
    role: count ? "开发岗位" : "岗位信息不足", mustSkills: skills,
    followups: [], companyStyle: { style: "信息不足", signals: [] },
  }), expect.any(String));
});

it("单版自介重新生成接受请求的有效版本", async () => {
  boundary.chat.mockResolvedValue(JSON.stringify({ versions: [{ kind: "30s", sentences: [{ text: "我擅长工程建设。", comment: "聚焦能力" }] }] }));
  const response = await regenerate(request({ kind: "30s" }), context());
  expect(response.status).toBe(200);
  expect(boundary.run).toHaveBeenCalledOnce();
});

it("经历重塑接受至少一版模型提供的真实脚本", async () => {
  boundary.chat.mockResolvedValue(JSON.stringify(validRemedy));
  expect((await remedy(request({ rawStory: "换工作" }))).status).toBe(201);
  expect(boundary.run).toHaveBeenCalledOnce();
});

it("空点评不能覆盖已保存点评", async () => {
  boundary.chat.mockResolvedValue('{"comments":["   "]}');
  expect((await recomment(request({ kind: "30s" }), context())).status).toBe(502);
  expect(boundary.run).not.toHaveBeenCalled();
});

it.each([
  ["虚构引文", { ...defenseItem, original_text: "性能提升 300%" }],
  ["改写引文", { ...defenseItem, original_text: "主导核心系统优化" }],
  ["拼接引文", { ...defenseItem, original_text: "负责优化" }],
  ["引用目标岗位", { ...defenseItem, original_text: "架构师" }],
  ["缺少点评", { ...defenseItem, interviewer_roast: " " }],
  ["缺少预案", { ...defenseItem, defense_plan: {} }],
  ["条目额外字段", { ...defenseItem, confidence: 0.9 }],
  ["预案额外字段", { ...defenseItem, defense_plan: { ...defenseItem.defense_plan, note: "额外内容" } }],
  ["非法风险类别", { ...defenseItem, risk_type: "unknown" }],
  ["重复追问", { ...defenseItem, deadly_questions: ["具体做了什么？", " 具体做了什么？ "] }],
  ["仅格式不同的重复追问", { ...defenseItem, deadly_questions: ["确认 API 经验吗？", "确认 ａｐｉ　经验吗！"] }],
  ["缺少追问", { ...defenseItem, deadly_questions: [] }],
])("简历排雷拒绝%s且不写库", async (_label, item) => {
  boundary.chat.mockResolvedValue(JSON.stringify({ ...defenseReport, items: [item] }));
  expect((await defenseScan(request({ resumeContent: defenseItem.original_text, targetRole: "架构师" }))).status).toBe(502);
  expect(boundary.run).not.toHaveBeenCalled();
});

it.each([
  ["报告额外字段", { ...defenseReport, model_note: "额外内容" }],
  ["重复引文", { ...defenseReport, items: [defenseItem, defenseItem] }],
  ["超出八项", { ...defenseReport, items: Array.from({ length: 9 }, () => defenseItem) }],
  ["空结果仍有风险评级", { ...defenseReport, items: [] }],
  ["有风险条目却评为低风险", { ...defenseReport, risk_level: "low" }],
  ["整体评级低于高风险条目", { ...defenseReport, risk_level: "medium", items: [{ ...defenseItem, risk_level: "high" }] }],
  ["整体评级低于关键风险条目", { ...defenseReport, risk_level: "high", items: [{ ...defenseItem, risk_level: "critical" }] }],
  ["无效 items", { ...defenseReport, items: {} }],
])("简历排雷拒绝%s报告且不写库", async (_label, output) => {
  boundary.chat.mockResolvedValue(JSON.stringify(output));
  expect((await defenseScan(request({ resumeContent: defenseItem.original_text }))).status).toBe(502);
  expect(boundary.run).not.toHaveBeenCalled();
});

it.each(defenseBoundedFields)("简历排雷拒绝超限字段 %s 且不写库", async (field, limit) => {
  boundary.chat.mockResolvedValue(JSON.stringify(changedDefenseField(field, "字".repeat(limit + 1))));
  expect((await defenseScan(request({ resumeContent: defenseItem.original_text }))).status).toBe(502);
  expect(boundary.run).not.toHaveBeenCalled();
});

it.each(defenseBoundedFields)("简历排雷字段 %s 达到上限时保留句尾", async (field, limit) => {
  const ending = "尚待核实";
  boundary.chat.mockResolvedValue(JSON.stringify(changedDefenseField(field, "字".repeat(limit - ending.length) + ending)));
  const response = await defenseScan(request({ resumeContent: defenseItem.original_text }));
  expect(response.status).toBe(200);
  expect(JSON.stringify(await response.json())).toContain(ending);
});

it("简历排雷拒绝过多禁忌项，但保留完整引文", async () => {
  const tooMany = changedDefenseField("items.0.defense_plan.taboo_mistakes", Array.from({ length: DEFENSE_LIMITS.max_taboo_mistakes + 1 }, () => "编造事实"));
  boundary.chat.mockResolvedValueOnce(JSON.stringify(tooMany));
  expect((await defenseScan(request({ resumeContent: defenseItem.original_text }))).status).toBe(502);
  expect(boundary.run).not.toHaveBeenCalled();

  const longQuote = "连续原文".repeat(120);
  boundary.chat.mockResolvedValueOnce(JSON.stringify(changedDefenseField("items.0.original_text", longQuote)));
  expect((await defenseScan(request({ resumeContent: longQuote }))).status).toBe(200);
  expect(boundary.run).toHaveBeenCalledOnce();
});

it("简历排雷允许没有与该风险直接相关的禁忌项", async () => {
  boundary.chat.mockResolvedValueOnce(JSON.stringify(changedDefenseField("items.0.defense_plan.taboo_mistakes", [])));
  const response = await defenseScan(request({ resumeContent: defenseItem.original_text }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ items: [{ defensePlan: { tabooMistakes: [] } }] });
  expect(boundary.run).toHaveBeenCalledOnce();
});

it("排雷模型不生成可由服务端确定的条目 ID", async () => {
  expect(RESUME_DEFENSE_SCAN_SYSTEM_PROMPT).not.toContain('"id": "item_1"');
  expect(RESUME_DEFENSE_SCAN_SYSTEM_PROMPT).toContain("不要输出条目 id；服务端会按数组顺序生成稳定 ID");
  expect(RESUME_DEFENSE_SCAN_SYSTEM_PROMPT).toContain("medium 与 data_suspicion 仅为合法枚举值示意，不是默认评级或风险类型");
  expect(RESUME_DEFENSE_SCAN_SYSTEM_PROMPT).toContain("逐项依据原文独立选择最合适的 risk_level 和 risk_type");
  boundary.chat.mockResolvedValueOnce(JSON.stringify(defenseReport));
  const response = await defenseScan(request({ resumeContent: defenseItem.original_text }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ items: [{ id: "item_1", originalText: defenseItem.original_text }] });
});

it.each(["负责核心系统优化", "处理时间 < 1 秒 & 保持可用", "保留 &lt;strong&gt; 实体原文"])("简历排雷保存有原文依据的引文：%s", async (quote) => {
  boundary.chat.mockResolvedValue(JSON.stringify({ ...defenseReport, items: [{ ...defenseItem, original_text: quote }] }));
  const response = await defenseScan(request({ resumeContent: `工作经历\n${quote}\n后续经历` }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ items: [{ id: "item_1", originalText: quote }] });
  expect(boundary.run).toHaveBeenCalledOnce();
});

it("简历排雷允许明确说明未发现问题的低风险空报告", async () => {
  boundary.chat.mockResolvedValue(JSON.stringify({ risk_level: "low", overall_roast: "本次审阅范围有限，未发现明确问题。", items: [] }));
  const response = await defenseScan(request({ resumeContent: "参与订单接口开发" }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ riskLevel: "low", items: [] });
  expect(boundary.run).toHaveBeenCalledOnce();
});

it("简历排雷拒绝未声明的兼容别名，不把带额外字段的输出作为成功报告", async () => {
  boundary.chat.mockResolvedValue(JSON.stringify({ ...defenseReport, items: [{
    ...defenseItem, originalText: "虚构引文", riskLevel: "critical", interviewerRoast: "未校验点评", defensePlan: {},
  }] }));
  const response = await defenseScan(request({ resumeContent: defenseItem.original_text }));
  expect(response.status).toBe(502);
  expect(boundary.run).not.toHaveBeenCalled();
});

it.each(["final_words", "agreed_package"])("薪资复盘 %s 超出单条预算时不调用模型", async (field) => {
  boundary.chat.mockResolvedValue(JSON.stringify(validReport));
  expect((await finalize(request({ [field]: "x".repeat(4001), expected_revision: readSalaryNegotiationRevision(1) }), context())).status).toBe(400);
  expect(boundary.chat).not.toHaveBeenCalled();
  expect(boundary.run).not.toHaveBeenCalled();
});

it("同场谈薪已有命令执行时复盘返回冲突", async () => {
  boundary.acquireCommandLock.mockReturnValueOnce(null);
  boundary.chat.mockResolvedValue(JSON.stringify(validReport));
  expect((await finalize(request({ expected_revision: readSalaryNegotiationRevision(1) }), context())).status).toBe(409);
  expect(boundary.chat).not.toHaveBeenCalled();
});

it("复盘失败释放同场命令锁", async () => {
  const release = vi.fn(); boundary.acquireCommandLock.mockReturnValueOnce(release);
  boundary.chat.mockRejectedValueOnce(new Error("模型失败"));
  expect((await finalize(request({ expected_revision: readSalaryNegotiationRevision(1) }), context())).status).toBe(502);
  expect(release).toHaveBeenCalledOnce();
});

it("复盘写入时发现历史已改变则返回冲突", async () => {
  boundary.chat.mockResolvedValue(JSON.stringify(validReport));
  boundary.run.mockReturnValueOnce({ lastInsertRowid: 0, changes: 0 });
  expect((await finalize(request({ expected_revision: readSalaryNegotiationRevision(1) }), context())).status).toBe(409);
});
