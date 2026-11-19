import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const model = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock("@/lib/llm", async (original) => ({ ...await original<typeof import("@/lib/llm")>(), chat: model.chat }));
const output = { initial_offer: "模拟月薪，奖金待确认", hr_response: "模拟 HR：先核对条件", hr_tactics: "澄清",
  hr_mindset: { looseness: 20, current_attitude: "模拟态度", estimated_package: "模拟方案", tactics_label: "澄清", internal_pressure: "模拟预算" },
  mentor_analysis: { user_argument_score: 5, strengths: ["明确期望"], vulnerabilities: ["薪数未知"], tactical_tips: "确认保证现金",
    suggested_replies: [{ title: "核对", content: "请确认保证薪数", rationale: "区分浮动" }] } };
const input = { target_company_tier: "custom", target_role: "  工程师 <T>  ", expected_salary: "30k，薪数未知", current_or_competing_offer: "口头询价 &amp;\n没有书面承诺", hr_style: "pressure" };
let directory: string; let db: DatabaseSync;
beforeEach(async () => {
  vi.resetModules(); model.chat.mockReset().mockResolvedValue(JSON.stringify(output));
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-salary-requests-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory); db = (await import("../db")).getDb();
});
afterEach(() => {
  db.close(); vi.unstubAllEnvs();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-salary-requests-")) throw new Error("Unsafe cleanup path");
  fs.rmSync(directory, { recursive: true, force: true });
});
async function post(id: string | null, changes = {}, signal?: AbortSignal) {
  return (await import("@/app/api/tools/salary-negotiations/route")).POST(new Request("http://localhost/api/tools/salary-negotiations", {
    method: "POST", headers: { "Content-Type": "application/json", ...(id === null ? {} : { "Idempotency-Key": id }) },
    body: JSON.stringify({ ...input, ...changes }), signal,
  }));
}
async function read(id: string) {
  return (await import("@/app/api/tools/salary-negotiations/requests/[requestId]/route")).GET(new Request("http://localhost/api/tools/salary-negotiations/requests/" + id), { params: Promise.resolve({ requestId: id }) });
}
const counts = () => ["salary_negotiations", "salary_negotiation_turns"].map(table => db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n);

describe("谈薪创建的持久请求回执", () => {
  it.each([
    ["围栏", (json: string) => ["```json", json, "```"].join("\n")],
    ["前置说明", (json: string) => `以下为初稿：\n${json}`],
    ["后置说明", (json: string) => `${json}\n上述报价仍需修订。`],
    ["追加截断内容", (json: string) => `${json}\n{"correction":`],
  ] as const)("%s 的开局回复失败后回执终结，不保存或同编号重调模型，新编号可显式创建", async (_label, wrap) => {
    const id = randomUUID();
    model.chat.mockResolvedValueOnce(wrap(JSON.stringify(output)));
    expect((await post(id)).status).toBe(502);
    expect(counts()).toEqual([0, 0]);
    expect(await (await read(id)).json()).toEqual({ request_id: id, status: "failed" });
    expect((await post(id)).status).toBe(422);
    expect(model.chat).toHaveBeenCalledOnce();
    expect((await post(randomUUID())).status).toBe(201);
    expect(counts()).toEqual([1, 1]);
    expect(model.chat).toHaveBeenCalledTimes(2);
    expect(await (await read(id)).json()).toEqual({ request_id: id, status: "failed" });
  });

  it.each([
    ...["target_company_tier", "current_or_competing_offer", "hr_style"].flatMap(field =>
      [null, true, 42, [], { toString: null }].map(value => ({ [field]: value }))),
    { hr_style: "unknown" }, { hr_style: "  " },
  ])("错误配置或筹码 %# 在认领前拒绝，修正后同编号仍可创建", async changes => {
    const id = randomUUID();
    const response = await post(id, changes);
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()).error).toEqual(expect.any(String));
    expect(model.chat).not.toHaveBeenCalled();
    expect(counts()).toEqual([0, 0]);
    expect(db.prepare("SELECT * FROM salary_creation_requests").all()).toEqual([]);
    expect((await read(id)).status).toBe(404);
    expect((await post(id)).status).toBe(201);
    expect((await post(id)).status).toBe(200);
    expect(model.chat).toHaveBeenCalledOnce();
    expect(counts()).toEqual([1, 1]);
  });

  it("坏筹码不能被当成空筹码匹配已完成回执", async () => {
    const id = randomUUID();
    expect((await post(id, { current_or_competing_offer: "" })).status).toBe(201);
    const before = ["salary_negotiations", "salary_negotiation_turns", "salary_creation_requests"]
      .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const response = await post(id, { current_or_competing_offer: [] });
    expect(response.status).toBe(400);
    expect(model.chat).toHaveBeenCalledOnce();
    expect(["salary_negotiations", "salary_negotiation_turns", "salary_creation_requests"]
      .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())).toEqual(before);
    expect((await post(id, { current_or_competing_offer: "" })).status).toBe(200);
  });

  it.each([
    { changes: { target_company_tier: undefined, hr_style: undefined, current_or_competing_offer: undefined }, tier: "top_tech", style: "standard", offer: "" },
    { changes: { target_company_tier: "  自定义企业 <T> & 独立团队  ", hr_style: " emotional ", current_or_competing_offer: "  仅为口头询价  " }, tier: "自定义企业 <T> & 独立团队", style: "emotional", offer: "仅为口头询价" },
  ])("缺省值及自定义企业字符串仍按原规则保存 %#", async ({ changes, tier, style, offer }) => {
    const response = await post(randomUUID(), changes);
    expect(response.status).toBe(201);
    const { id } = await response.json();
    expect(db.prepare("SELECT target_company_tier,hr_style,current_or_competing_offer FROM salary_negotiations WHERE id=?").get(id))
      .toEqual({ target_company_tier: tier, hr_style: style, current_or_competing_offer: offer });
  });

  it("v1 用户备份可恢复，回执不导出，恢复失败回滚回执，成功恢复清除本机请求状态", async () => {
    const id = randomUUID(); const saved = await (await post(id)).json();
    const { createBackupRecordStream } = await import("../backup-records");
    const chunks: Buffer[] = []; for await (const chunk of createBackupRecordStream(db)) chunks.push(Buffer.from(chunk));
    const records = Buffer.concat(chunks).toString().trim().split("\n").map(line => JSON.parse(line));
    expect(records[0].tables).not.toContain("salary_creation_requests");
    expect(records.some(record => record.table === "salary_creation_requests")).toBe(false);
    records[0].dbVersion = 1;
    records[0].tables = records[0].tables.filter((table: string) => table !== "application_interview_recap_contexts" && table !== "project_material_table_provenance");
    delete records.at(-1).stats.application_interview_recap_contexts;
    delete records.at(-1).stats.project_material_table_provenance;
    const bytes = Buffer.from(records.map(record => JSON.stringify(record)).join("\n") + "\n");
    const { stageBackupRecordStream } = await import("../backup-staging");
    const staged = await stageBackupRecordStream((async function* () { yield bytes; })(), db);
    const { restoreAllData } = await import("../backup");
    try {
      let checks = 0;
      expect(() => restoreAllData(staged, true, () => { if (++checks === 2) throw new Error("synthetic restore deadline"); })).toThrow("synthetic restore deadline");
      expect(await (await read(id)).json()).toMatchObject({ status: "succeeded", id: saved.id });
      restoreAllData(staged, true);
      expect((await read(id)).status).toBe(404);
      expect(db.prepare("SELECT id FROM salary_negotiations").all()).toEqual([{ id: saved.id }]);
      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: (await import("../db-schema")).CURRENT_DB_VERSION });
    } finally { staged.dispose(); }
  });

  it("恢复世代改变后旧模型不能保存或把新请求标为失败", async () => {
    const id = randomUUID(); const old = Promise.withResolvers<string>(); const fresh = Promise.withResolvers<string>();
    model.chat.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const previous = post(id); await vi.waitFor(() => expect(model.chat).toHaveBeenCalledOnce());
    db.exec("DELETE FROM salary_creation_requests; INSERT INTO runtime_state (id,data_generation) VALUES (1,'restored')");
    const current = post(id); await vi.waitFor(() => expect(model.chat).toHaveBeenCalledTimes(2));
    old.resolve(JSON.stringify(output)); expect((await previous).status).toBe(409);
    expect(await (await read(id)).json()).toMatchObject({ status: "pending" }); expect(counts()).toEqual([0, 0]);
    fresh.resolve(JSON.stringify(output)); expect((await current).status).toBe(201); expect(counts()).toEqual([1, 1]);
  });

  it.each(["bad", "1", "", "../escape", "a".repeat(200)])("拒绝无效请求编号 %j，不调用模型或写回执", async (id) => {
    expect((await post(id)).status).toBe(400); expect((await read(id)).status).toBe(400);
    expect(model.chat).not.toHaveBeenCalled(); expect(counts()).toEqual([0, 0]);
    expect(db.prepare("SELECT * FROM salary_creation_requests").all()).toEqual([]);
  });
  it("重复完成请求与重启后重放均返回原 ID，同文新编号仍可创建", async () => {
    const id = randomUUID(); const first = await post(id); expect(first.status).toBe(201);
    const saved = await first.json();
    expect(await (await read(id)).json()).toEqual({ request_id: id, status: "succeeded", ...saved });
    expect((await read(id)).headers.get("Cache-Control")).toBe("no-store");
    expect((await post(id, { target_role: input.target_role.trim() })).status).toBe(200);
    db.close(); vi.resetModules(); db = (await import("../db")).getDb();
    expect(await (await post(id)).json()).toEqual(saved);
    expect(model.chat).toHaveBeenCalledOnce(); expect(counts()).toEqual([1, 1]);
    expect((await post(randomUUID())).status).toBe(201); expect(counts()).toEqual([2, 2]);
    const row = db.prepare("SELECT * FROM salary_creation_requests WHERE request_id=?").get(id)!;
    expect(row.input_hash).toMatch(/^[a-f0-9]{64}$/); expect(Object.values(row).join(" ")).not.toContain("口头询价");
  });
  it("处理中重复和串背景在模型前拒绝，不释放原请求的认领", async () => {
    const pending = Promise.withResolvers<string>(); model.chat.mockReturnValueOnce(pending.promise);
    const id = randomUUID(); const first = post(id);
    await vi.waitFor(() => expect(model.chat).toHaveBeenCalledOnce());
    expect(await (await read(id)).json()).toEqual({ request_id: id, status: "pending" });
    for (const body of [{}, { target_role: "另一岗位" }, {}]) expect((await post(id, body)).status).toBe(409);
    expect(model.chat).toHaveBeenCalledOnce(); expect(counts()).toEqual([0, 0]);
    pending.resolve(JSON.stringify(output)); expect((await first).status).toBe(201);
    expect((await post(id, { expected_salary: "不同条件" })).status).toBe(409);
    expect(counts()).toEqual([1, 1]);
  });
  it("独立 SQLite 连接留下的处理中回执不会因重启或超时猜测重新执行", async () => {
    const id = randomUUID(); const { claimSalaryCreationRequest } = await import("../salary-creation-requests");
    const values = [input.target_company_tier, input.target_role.trim(), input.expected_salary, input.current_or_competing_offer, input.hr_style];
    expect(claimSalaryCreationRequest(id, values)).toEqual({ status: "claimed" });
    db.close(); vi.resetModules(); db = (await import("../db")).getDb();
    const independent = new DatabaseSync(path.join(directory, "resume-life.db"));
    try { expect(independent.prepare("SELECT status FROM salary_creation_requests WHERE request_id=?").get(id)).toEqual({ status: "pending" }); }
    finally { independent.close(); }
    expect((await post(id)).status).toBe(409); expect(model.chat).not.toHaveBeenCalled();
  });
  it.each(["upstream", "protocol", "cancel", "save"])("%s 失败保存失败回执，不留空壳或重调同编号", async (mode) => {
    const id = randomUUID(); const abort = new AbortController();
    if (mode === "upstream") model.chat.mockRejectedValueOnce(new Error("synthetic upstream error"));
    if (mode === "protocol") model.chat.mockResolvedValueOnce("{}");
    if (mode === "cancel") model.chat.mockImplementationOnce(() => { abort.abort(); return JSON.stringify(output); });
    if (mode === "save") db.exec("CREATE TRIGGER synthetic_fail BEFORE INSERT ON salary_negotiation_turns BEGIN SELECT RAISE(ABORT,'synthetic save error'); END");
    expect((await post(id, {}, abort.signal)).status).toBeGreaterThanOrEqual(500);
    expect(await (await read(id)).json()).toEqual({ request_id: id, status: "failed" });
    expect((await post(id)).status).toBe(422); expect(model.chat).toHaveBeenCalledOnce(); expect(counts()).toEqual([0, 0]);
  });
  it("已删除的完成回执不会复活原演练，未认领的编号只读返回 404", async () => {
    const id = randomUUID(); const saved = await (await post(id)).json();
    db.prepare("DELETE FROM salary_negotiations WHERE id=?").run(saved.id);
    expect(await (await read(id)).json()).toEqual({ request_id: id, status: "deleted" });
    expect((await post(id)).status).toBe(410); expect(model.chat).toHaveBeenCalledOnce(); expect(counts()).toEqual([0, 0]);
    expect((await read(randomUUID())).status).toBe(404);
  });
  it("旧调用者未带编号仍可创建，不写请求回执", async () => {
    expect((await post(null)).status).toBe(201); expect(db.prepare("SELECT * FROM salary_creation_requests").all()).toEqual([]);
  });
});
