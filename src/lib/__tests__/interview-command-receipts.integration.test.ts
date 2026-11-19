import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertInterviewReportReceipt, assertInterviewReverseReceipt } from "../interview-command-receipts";
const model = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock("@/lib/llm", async original => ({ ...await original<typeof import("@/lib/llm")>(), ...model }));
let directory: string;
let db: DatabaseSync;
const mining = { project_name: "项目", background: "已有任务", actions: "实际行动", tradeoffs: "待核实", results: "尚未上线", contribution: "负责校验", resume_bullets: [], pending_confirmations: [] };
const evaluator = { recommendation: "Hire", level: "待核实", level_justification: "参考依据", summary_for_hr: "总结", hire_reasons: [], concerns_and_risks: [], placement_suggestion: "建议", evidence_quotes: [] };
beforeEach(async () => {
  vi.resetModules(); model.chat.mockReset();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-command-receipts-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'原简历','',''); INSERT INTO interviews (id,resume_id,jd,rounds,created_at) VALUES (1,1,'原岗位',3,''),(2,1,'另一面试',3,''); INSERT INTO interview_turns (id,interview_id,idx,question,answer,answered_at) VALUES (1,1,1,'原题一','原答一','saved'),(2,1,2,'原题二','原答二','saved')");
  for (const id of [1, 2]) db.prepare("UPDATE interview_turns SET scores=? WHERE id=?").run(JSON.stringify({ depth: id + 6, structure: 8, authenticity: 7, completeness: 7 }), id);
});
afterEach(() => {
  db.close(); vi.unstubAllEnvs();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-command-receipts-")) throw new Error("Unsafe cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
});

it.each(["report", "mining", "evaluator", "reverse"])("真实 %s POST 回执与 SQLite 保存结果一致并满足客户端契约", async scenario => {
  if (scenario === "mining") db.exec("UPDATE interviews SET style='mining' WHERE id=1");
  const other = db.prepare("SELECT * FROM interviews WHERE id=2").get();
  const turns = db.prepare("SELECT * FROM interview_turns ORDER BY id").all();
  const question = "  实际验收 <T> &amp;\n如何核实？  ";
  model.chat.mockResolvedValue(JSON.stringify(scenario === "reverse"
    ? { answer: "模拟答复，实际情况待核实", evaluation: { score: 8, insight: "核实依据", feedback: "问题具体", suggestions: "请向招聘方确认" } }
    : { jd_match: 7, strengths: "原答依据", weaknesses: "待验证", suggestions: "核实实际结果", ...(scenario === "mining" ? { mining_summary: mining } : {}), ...(scenario === "evaluator" ? { evaluator_report: evaluator } : {}) }));
  const route = scenario === "reverse" ? await import("@/app/api/interviews/[id]/reverse/route") : await import("@/app/api/interviews/[id]/finish/route");
  const response = await route.POST(new Request("http://localhost/api/interviews/1", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question }) }), { params: Promise.resolve({ id: "1" }) });
  expect(response.status).toBe(200);
  const receipt = await response.json();
  expect(receipt.interview_id).toBe(1);
  const stored = db.prepare("SELECT * FROM interviews WHERE id=1").get()!;
  const snapshot = JSON.stringify(receipt);
  if (scenario === "reverse") {
    expect(() => assertInterviewReverseReceipt(receipt, 1, question.trim())).not.toThrow();
    expect(receipt.reverse).toEqual(JSON.parse(String(stored.reverse_interview)));
    expect(receipt.reverse.question).toBe(question.trim());
  } else {
    expect(() => assertInterviewReportReceipt(receipt, 1, scenario === "mining")).not.toThrow();
    expect(receipt.report).toEqual(JSON.parse(String(stored.report)));
    expect(receipt.report.depth).toBe(7.5);
    expect(receipt.evaluator_report).toEqual(stored.evaluator_report ? JSON.parse(String(stored.evaluator_report)) : null);
    expect(receipt.finished_at).toBe(stored.finished_at);
  }
  expect(JSON.stringify(receipt)).toBe(snapshot);
  expect(db.prepare("SELECT * FROM interviews WHERE id=2").get()).toEqual(other);
  expect(db.prepare("SELECT * FROM interview_turns ORDER BY id").all()).toEqual(turns);
  expect(model.chat).toHaveBeenCalledOnce();
});
