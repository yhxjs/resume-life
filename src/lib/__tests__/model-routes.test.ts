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

import { POST as portrait } from "../../app/api/tools/jd-portraits/route";
import { POST as decoder } from "../../app/api/tools/jargon-decodings/route";
import { POST as remedy } from "../../app/api/tools/career-gap-remedies/route";
import { POST as regenerate } from "../../app/api/intros/[id]/regenerate/route";
import { POST as recomment } from "../../app/api/intros/[id]/recomment/route";
import { POST as finalize } from "../../app/api/tools/salary-negotiations/[id]/finalize/route";

const cases = [
  { name: "JD画像", route: portrait, body: { jd: "TypeScript" } },
  { name: "黑话解码", route: decoder, body: { text: "抗压能力" } },
  { name: "经历重塑", route: remedy, body: { rawStory: "换工作" } },
  { name: "自介重新生成", route: regenerate, body: { kind: "30s" } },
  { name: "自介重新点评", route: recomment, body: { kind: "30s" } },
  { name: "薪资复盘", route: finalize, body: {} },
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
const validReport = { final_package_summary: "35k", persuasion_grade: "B", score: 80, leverage_efficiency: "表现稳健", turn_critiques: [{ turn_no: 1, gain_or_loss: "neutral", summary: "正常", key_point: "保持" }], real_world_tips: ["核对带宽"], mentor_summary: "表现良好" };
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

it("单版自介重新生成接受请求的有效版本", async () => {
  boundary.chat.mockResolvedValue(JSON.stringify({ versions: [{ kind: "30s", sentences: [{ text: "我擅长工程建设", comment: "聚焦能力" }] }] }));
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

it.each(["final_words", "agreed_package"])("薪资复盘 %s 超出单条预算时不调用模型", async (field) => {
  boundary.chat.mockResolvedValue(JSON.stringify(validReport));
  expect((await finalize(request({ [field]: "x".repeat(4001) }), context())).status).toBe(400);
  expect(boundary.chat).not.toHaveBeenCalled();
  expect(boundary.run).not.toHaveBeenCalled();
});

it("同场谈薪已有命令执行时复盘返回冲突", async () => {
  boundary.acquireCommandLock.mockReturnValueOnce(null);
  boundary.chat.mockResolvedValue(JSON.stringify(validReport));
  expect((await finalize(request({}), context())).status).toBe(409);
  expect(boundary.chat).not.toHaveBeenCalled();
});

it("复盘失败释放同场命令锁", async () => {
  const release = vi.fn(); boundary.acquireCommandLock.mockReturnValueOnce(release);
  boundary.chat.mockRejectedValueOnce(new Error("模型失败"));
  expect((await finalize(request({}), context())).status).toBe(502);
  expect(release).toHaveBeenCalledOnce();
});

it("复盘写入时发现历史已改变则返回冲突", async () => {
  boundary.chat.mockResolvedValue(JSON.stringify(validReport));
  boundary.run.mockReturnValueOnce({ lastInsertRowid: 0, changes: 0 });
  expect((await finalize(request({}), context())).status).toBe(409);
});
