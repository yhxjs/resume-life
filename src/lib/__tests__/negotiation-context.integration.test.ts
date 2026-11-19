import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const model = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock("@/lib/llm", async (original) => ({ ...await original<typeof import("@/lib/llm")>(), ...model }));

const PREFIX = "resume-life-negotiation-context-";
const turn = {
  hr_response: "模拟报价仍需确认", hr_tactics: "澄清条件",
  hr_mindset: { looseness: 20, current_attitude: "模拟态度", estimated_package: "模拟税前月薪30k", tactics_label: "澄清", internal_pressure: "模拟审批约束" },
  mentor_analysis: { user_argument_score: 7, strengths: ["诉求明确"], vulnerabilities: ["薪数待确认"], tactical_tips: "核实保证薪数", suggested_replies: [{ title: "核实", content: "请确认保证薪数", rationale: "统一口径" }] },
};
const report = {
  final_package_summary: "模拟方案尚未达成一致", score: 75, leverage_efficiency: "澄清部分条件",
  turn_critiques: [{ turn_no: 5, gain_or_loss: "neutral", summary: "澄清结构", key_point: "核实保证薪数" }],
  real_world_tips: ["确认保证薪数"], mentor_summary: "继续核实条件",
};
let directory: string;
let db: DatabaseSync;

beforeEach(async () => {
  vi.resetModules();
  model.chat.mockReset();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.exec("INSERT INTO salary_negotiations (id,target_company_tier,target_role,expected_salary,initial_offer,created_at) VALUES (1,'custom','工程师','税前月薪30k','模拟税前月薪28k',''),(2,'custom','其他岗位','其他期望','其他开价','')");
  const insert = db.prepare("INSERT INTO salary_negotiation_turns (negotiation_id,turn_no,user_message,hr_response,hr_mindset,mentor_analysis,created_at) VALUES (1,?,?,?,?,?,'')");
  insert.run(1, "", "模拟 HR 开场", "旧内部状态", "旧点评");
  insert.run(3, "请确认税前口径", "模拟税前月薪29k", "旧内部状态", "旧点评");
  insert.run(5, "请确认保证薪数", "模拟税前月薪30k，需要审批", JSON.stringify(turn.hr_mindset), "旧点评");
});

afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(PREFIX)) throw new Error("Unsafe cleanup path");
  fs.rmSync(resolved, { recursive: true, force: true });
});

function snapshot() {
  return {
    negotiations: db.prepare("SELECT * FROM salary_negotiations ORDER BY id").all(),
    turns: db.prepare("SELECT * FROM salary_negotiation_turns ORDER BY id").all(),
  };
}

async function generate(phase: string) {
  const handler = phase === "turn"
    ? (await import("@/app/api/tools/salary-negotiations/[id]/turn/route")).POST
    : (await import("@/app/api/tools/salary-negotiations/[id]/finalize/route")).POST;
  const expected_revision = (await import("../salary-negotiation-snapshot")).readSalaryNegotiationRevision(1);
  return handler(new Request(`http://localhost/api/tools/salary-negotiations/1/${phase}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(phase === "turn" ? { user_message: "请说明审批条件" } : {}), expected_revision }),
  }), { params: Promise.resolve({ id: "1" }) });
}

function changeDuringReply(phase: string, sql: string) {
  let afterChange: ReturnType<typeof snapshot>;
  model.chat.mockImplementationOnce(async () => {
    const writer = new DatabaseSync(path.join(directory, "resume-life.db"));
    try { writer.exec(sql); } finally { writer.close(); }
    afterChange = snapshot();
    return JSON.stringify(phase === "turn" ? turn : report);
  });
  return () => afterChange;
}

describe.each(["turn", "finalize"])("谈薪 %s 的生成依据一致性", (phase) => {
  it.each([
    ["公司类型", "UPDATE salary_negotiations SET target_company_tier='growth' WHERE id=1"],
    ["岗位", "UPDATE salary_negotiations SET target_role='新岗位_兼容性验证' WHERE id=1"],
    ["薪资期望", "UPDATE salary_negotiations SET expected_salary='税前月薪31k' WHERE id=1"],
    ["现有筹码", "UPDATE salary_negotiations SET current_or_competing_offer='尚无其他报价' WHERE id=1"],
    ["初始方案", "UPDATE salary_negotiations SET initial_offer='模拟方案：签字费尚需审批' WHERE id=1"],
    ["历史候选人原话", "UPDATE salary_negotiation_turns SET user_message='尚未接受报价，只是在确认条件' WHERE negotiation_id=1 AND turn_no=3"],
    ["最新公开报价", "UPDATE salary_negotiation_turns SET hr_response='模拟方案：税前月薪29k，待审批' WHERE negotiation_id=1 AND turn_no=5"],
    ["原回合编号", "UPDATE salary_negotiation_turns SET turn_no=4 WHERE negotiation_id=1 AND turn_no=3"],
  ])("等待模型期间%s变化且行数不变，旧结果零写入并可重试", async (_label, sql) => {
    const afterChange = changeDuringReply(phase, sql);
    const response = await generate(phase);
    expect(response.status).toBe(409);
    expect(snapshot()).toEqual(afterChange());
    model.chat.mockResolvedValueOnce(JSON.stringify(phase === "turn" ? turn : report));
    expect((await generate(phase)).status).toBe(phase === "turn" ? 201 : 200);
    expect(model.chat).toHaveBeenCalledTimes(2);
    if (sql.includes("新岗位_兼容性验证")) {
      expect(JSON.stringify(model.chat.mock.calls[1]![1])).toContain("新岗位_兼容性验证");
    }
  });

  it("其他谈判与未传入的旧点评、旧内部状态变化不阻止保存", async () => {
    changeDuringReply(phase, `UPDATE salary_negotiations SET target_role='其他谈判的新岗位' WHERE id=2;
      UPDATE salary_negotiation_turns SET mentor_analysis='后来修改的旧点评',hr_tactics='后来修改的旧策略' WHERE negotiation_id=1;
      UPDATE salary_negotiation_turns SET hr_mindset='旧回合的新状态' WHERE negotiation_id=1 AND turn_no < 5`);
    expect((await generate(phase)).status).toBe(phase === "turn" ? 201 : 200);
    expect(db.prepare("SELECT target_role FROM salary_negotiations WHERE id=2").get()!.target_role).toBe("其他谈判的新岗位");
    expect(db.prepare("SELECT mentor_analysis,hr_mindset FROM salary_negotiation_turns WHERE negotiation_id=1 AND turn_no=3").get())
      .toEqual({ mentor_analysis: "后来修改的旧点评", hr_mindset: "旧回合的新状态" });
  });
});

it.each([
  ["HR 风格", "UPDATE salary_negotiations SET hr_style='pressure' WHERE id=1"],
  ["最新内部状态", "UPDATE salary_negotiation_turns SET hr_mindset='最新模拟状态已变更' WHERE negotiation_id=1 AND turn_no=5"],
])("续轮使用的%s变化时拒绝旧回复", async (_label, sql) => {
  const afterChange = changeDuringReply("turn", sql);
  expect((await generate("turn")).status).toBe(409);
  expect(snapshot()).toEqual(afterChange());
  model.chat.mockResolvedValueOnce(JSON.stringify(turn));
  expect((await generate("turn")).status).toBe(201);
});

it.each([
  ["已保存复盘", "UPDATE salary_negotiations SET report='另一操作保存的报告' WHERE id=1"],
  ["已保存方案", "UPDATE salary_negotiations SET final_package='另一操作保存的方案' WHERE id=1"],
])("结束前%s变化时不覆盖其他操作的结果", async (_label, sql) => {
  const afterChange = changeDuringReply("finalize", sql);
  expect((await generate("finalize")).status).toBe(409);
  expect(snapshot()).toEqual(afterChange());
});

it("复盘不使用 HR 风格或内部状态，修改它们不误报冲突", async () => {
  changeDuringReply("finalize", "UPDATE salary_negotiations SET hr_style='pressure' WHERE id=1; UPDATE salary_negotiation_turns SET hr_mindset='新的模拟内部状态' WHERE negotiation_id=1");
  expect((await generate("finalize")).status).toBe(200);
  expect(db.prepare("SELECT hr_style FROM salary_negotiations WHERE id=1").get()!.hr_style).toBe("pressure");
});
