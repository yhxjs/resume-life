import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const model = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock("@/lib/llm", async original => ({ ...await original<typeof import("@/lib/llm")>(), ...model }));
const PREFIX = "resume-life-salary-stale-context-";
const proposal = {
  hr_response: "模拟替代方案 B：32k×12，试用期八折，仍需审批；原方案 A 不再提供。", hr_tactics: "核实替代方案",
  hr_mindset: { looseness: 20, current_attitude: "模拟待审批", estimated_package: "模拟32k×12，试用期八折，待审批", tactics_label: "澄清条件", internal_pressure: "模拟审批约束" },
  mentor_analysis: { user_argument_score: 7, strengths: ["区分薪酬口径"], vulnerabilities: ["条件待确认"], tactical_tips: "核实审批与试用期条件", suggested_replies: [{ title: "澄清", content: "请确认试用期条件与审批状态。", rationale: "保留条件边界" }] },
};
const report = { final_package_summary: "模拟方案尚未达成一致", score: 70, leverage_efficiency: "分别核实公开报价与结束补记。", turn_critiques: [], real_world_tips: ["确认保证薪数与试用期条件。"], mentor_summary: "补记不代表 HR 承诺。" };
type Phase = "turn" | "finalize";
let directory: string;
let db: DatabaseSync;
beforeEach(async () => {
  vi.resetModules(); model.chat.mockReset();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.exec("INSERT INTO salary_negotiations (id,target_company_tier,target_role,expected_salary,initial_offer,created_at) VALUES (1,'custom','工程师','30k×14','模拟方案 A：30k×14，无试用期折扣。','original')");
  db.prepare("INSERT INTO salary_negotiation_turns (negotiation_id,turn_no,user_message,hr_response,hr_tactics,hr_mindset,mentor_analysis,created_at) VALUES (1,1,'','模拟方案 A：30k×14，无试用期折扣。','模拟开场',?,?,'original')")
    .run(JSON.stringify(proposal.hr_mindset), JSON.stringify({ ...proposal.mentor_analysis, user_argument_score: 5 }));
});
afterEach(() => {
  db?.close(); vi.unstubAllEnvs();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith(PREFIX)) throw new Error("Unsafe cleanup path");
  fs.rmSync(directory, { recursive: true, force: true });
});
const context = (id = 1) => ({ params: Promise.resolve({ id: String(id) }) });
function persisted() {
  return { negotiation: db.prepare("SELECT * FROM salary_negotiations").all(), turns: db.prepare("SELECT * FROM salary_negotiation_turns ORDER BY turn_no").all() };
}
async function detail() {
  const response = await (await import("@/app/api/tools/salary-negotiations/[id]/route")).GET(new Request("http://localhost"), context());
  expect(response.status).toBe(200);
  return response.json();
}
async function submit(phase: Phase, revision: unknown, extra: Record<string, unknown> = {}, id = 1) {
  const route = phase === "turn" ? await import("@/app/api/tools/salary-negotiations/[id]/turn/route") : await import("@/app/api/tools/salary-negotiations/[id]/finalize/route");
  return route.POST(new Request("http://localhost", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...(phase === "turn" ? { user_message: "刚才的方案我可以接受；其他条件按刚才说的。" } : { final_words: "刚才的方案我可以接受；其他条件按刚才说的。" }), expected_revision: revision, ...extra }),
  }), context(id));
}

it("详情版本稳定且原文任意变化或恢复世代变化都会产生新版本", async () => {
  const original = await detail();
  expect(original.revision).toMatch(/^[a-f0-9]{64}$/);
  expect((await detail()).revision).toBe(original.revision);
  db.prepare("UPDATE salary_negotiation_turns SET hr_response = ? WHERE negotiation_id=1").run("模拟方案 A：30k×14，尚需审批 <T> &amp;\n内部  空格");
  const changed = await detail(); expect(changed.revision).not.toBe(original.revision);
  db.exec("INSERT INTO runtime_state (id,data_generation) VALUES (1,'restored')");
  expect((await detail()).revision).not.toBe(changed.revision);
});

it("详情等待另一连接的成组写入完成，背景、报价和版本来自同一快照", async () => {
  const old = await detail();
  const locked = Promise.withResolvers<void>();
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const database = new DatabaseSync(workerData);
    database.exec('BEGIN IMMEDIATE');
    database.prepare("UPDATE salary_negotiations SET target_role='成组更新后的岗位' WHERE id=1").run();
    parentPort.postMessage('locked');
    parentPort.once('message', () => setTimeout(() => {
      database.prepare("UPDATE salary_negotiation_turns SET hr_response='成组更新后的模拟报价，尚需审批' WHERE negotiation_id=1").run();
      database.exec('COMMIT'); database.close(); parentPort.close();
    }, 100));
  `, { eval: true, workerData: path.join(directory, "resume-life.db") });
  worker.once("message", () => locked.resolve()); worker.once("error", locked.reject);
  try {
    await locked.promise; worker.postMessage("release");
    const current = await detail();
    expect(current.target_role).toBe("成组更新后的岗位");
    expect(current.turns[0].hr_response).toBe("成组更新后的模拟报价，尚需审批");
    expect(current.revision).not.toBe(old.revision);
    expect(current.revision).toBe((await import("../salary-negotiation-snapshot")).readSalaryNegotiationRevision(1));
  } finally { await worker.terminate(); }
});

it("原始版本读取不解析损坏旧JSON，也不会回填或改写旧记录", async () => {
  db.exec("UPDATE salary_negotiations SET report='{broken' WHERE id=1; UPDATE salary_negotiation_turns SET mentor_analysis='legacy non-JSON' WHERE negotiation_id=1");
  const before = persisted();
  const { readSalaryNegotiationRevision } = await import("../salary-negotiation-snapshot");
  const revision = readSalaryNegotiationRevision(1);
  expect(revision).toMatch(/^[a-f0-9]{64}$/); expect(readSalaryNegotiationRevision(1)).toBe(revision);
  expect(readSalaryNegotiationRevision(999)).toBeNull(); expect(persisted()).toEqual(before);
});

describe.each<Phase>(["turn", "finalize"])("%s 绑定用户已读的谈判快照", phase => {
  it("另一页新增报价后拒绝旧页面原话，重读后显式重试才可生成", async () => {
    const oldPage = await detail();
    model.chat.mockResolvedValueOnce(JSON.stringify(proposal));
    expect((await submit("turn", oldPage.revision, { user_message: "请提供另一套可比较方案。" })).status).toBe(201);
    const before = persisted(); model.chat.mockClear();
    model.chat.mockResolvedValue(JSON.stringify(phase === "turn" ? proposal : report));
    const stale = await submit(phase, oldPage.revision);
    expect(stale.status).toBe(409); expect(model.chat).not.toHaveBeenCalled(); expect(persisted()).toEqual(before);
    const current = await detail();
    const retried = await submit(phase, current.revision);
    expect(retried.status).toBe(phase === "turn" ? 201 : 200);
    expect(await retried.json()).toMatchObject({ base_revision: current.revision, revision: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(model.chat).toHaveBeenCalledOnce();
  });

  it.each([undefined, null, [], {}, 123, "", "A".repeat(64), "a".repeat(63)])("拒绝缺失或非法版本 %j，不调用模型或写入", async revision => {
    const before = persisted(); model.chat.mockResolvedValue(JSON.stringify(phase === "turn" ? proposal : report));
    const response = await submit(phase, revision);
    expect(response.status).toBe(400); expect((await response.json()).error).toContain("版本");
    expect(model.chat).not.toHaveBeenCalled(); expect(persisted()).toEqual(before);
  });

  it.each([
    ["报价原文", "UPDATE salary_negotiation_turns SET hr_response='模拟新报价，仍未确认' WHERE negotiation_id=1"],
    ["岗位背景", "UPDATE salary_negotiations SET target_role='另一岗位' WHERE id=1"],
    ["旧点评", "UPDATE salary_negotiation_turns SET mentor_analysis='{}' WHERE negotiation_id=1"],
    ["原保存时间", "UPDATE salary_negotiations SET created_at='changed' WHERE id=1"],
    ["恢复世代", "INSERT INTO runtime_state (id,data_generation) VALUES (1,'new-generation')"],
  ])("提交前%s改变，即使回合数相同也拒绝旧版本", async (_label, sql) => {
    const old = await detail(); db.exec(sql); const before = persisted();
    model.chat.mockResolvedValue(JSON.stringify(phase === "turn" ? proposal : report));
    expect((await submit(phase, old.revision)).status).toBe(409);
    expect(model.chat).not.toHaveBeenCalled(); expect(persisted()).toEqual(before);
  });

  it("返回实际写入前后版本，保存后旧版本不能再次生成", async () => {
    const before = await detail(); model.chat.mockResolvedValue(JSON.stringify(phase === "turn" ? proposal : report));
    const response = await submit(phase, before.revision); expect(response.status).toBe(phase === "turn" ? 201 : 200);
    const result = await response.json(); const saved = await detail();
    expect(result.base_revision).toBe(before.revision); expect(result.revision).toBe(saved.revision); expect(result.revision).not.toBe(before.revision);
    expect((await submit(phase, before.revision)).status).toBe(409); expect(model.chat).toHaveBeenCalledOnce();
  });

  it("生成等待期间未使用的点评变化仍可保存，但基础版本必须反映真实提交前快照", async () => {
    const before = await detail(); let actualBase: string | undefined;
    model.chat.mockImplementationOnce(async () => {
      db.exec("UPDATE salary_negotiation_turns SET mentor_analysis='{}',hr_tactics='新存档策略' WHERE negotiation_id=1");
      actualBase = (await detail()).revision;
      return JSON.stringify(phase === "turn" ? proposal : report);
    });
    const response = await submit(phase, before.revision); expect(response.status).toBe(phase === "turn" ? 201 : 200);
    const result = await response.json();
    expect(actualBase).not.toBe(before.revision); expect(result.base_revision).toBe(actualBase);
    expect(result.revision).toBe((await detail()).revision); expect(result.revision).not.toBe(result.base_revision);
  });

  it("不存在的记录保持404；原有文字校验优先于缺失版本", async () => {
    expect((await submit(phase, "a".repeat(64), {}, 999)).status).toBe(404);
    const invalid = await submit(phase, undefined, phase === "turn" ? { user_message: "" } : { final_words: null });
    expect(invalid.status).toBe(400); expect((await invalid.json()).error).toContain(phase === "turn" ? "不能为空" : "字符串");
    expect(model.chat).not.toHaveBeenCalled();
  });
});

it("已结束记录仅接受当前版本回读，原报告和结束时间不被补记覆盖", async () => {
  const before = await detail(); model.chat.mockResolvedValueOnce(JSON.stringify(report));
  const first = await submit("finalize", before.revision); expect(first.status).toBe(200);
  const completed = await first.json(); const stored = persisted();
  expect((await submit("finalize", before.revision, { final_words: "新的补记不得改写" })).status).toBe(409);
  const repeated = await submit("finalize", completed.revision, { final_words: "新的补记不得改写" });
  expect(repeated.status).toBe(200);
  expect(await repeated.json()).toEqual({ ...completed, base_revision: completed.revision });
  expect(persisted()).toEqual(stored); expect(model.chat).toHaveBeenCalledOnce();
});
