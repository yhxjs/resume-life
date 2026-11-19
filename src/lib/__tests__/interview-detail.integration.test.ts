import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseInterviewDetail } from "../interview-detail";

let directory: string;
let db: DatabaseSync;
beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-detail-contract-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.exec("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'原简历','',''); INSERT INTO interviews (id,resume_id,jd,rounds,created_at) VALUES (1,1,'完整 JD',1,''); INSERT INTO interview_turns (id,interview_id,idx,question) VALUES (1,1,1,'原题')");
});
afterEach(() => {
  db.close(); vi.unstubAllEnvs();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-detail-contract-")) throw new Error("Unsafe cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
});

it.each(["single", "series", "reports", "damaged-history"])("真实详情 GET 的 %s 结果满足客户端读取契约，读取零写入", async scenario => {
  const scores = { depth: 7, structure: 8, authenticity: 9, completeness: 7 };
  if (scenario === "series") {
    db.exec("INSERT INTO interview_series (id,resume_id,jd,created_at) VALUES (1,1,'岗位',''); UPDATE interviews SET series_id=1,round_no=1 WHERE id=1");
  }
  if (scenario === "reports") {
    const report = { ...scores, jd_match: 8, overall: 7.8, strengths: "依据", weaknesses: "待核实", suggestions: "建议", mining_summary: {
      project_name: "项目", background: "", actions: "动作", tradeoffs: "", results: "", contribution: "", resume_bullets: [], pending_confirmations: [],
    } };
    const evaluator = { recommendation: "Hire", level: "待核实", level_justification: "依据", summary_for_hr: "摘要", hire_reasons: [], concerns_and_risks: [], placement_suggestion: "建议", evidence_quotes: [] };
    const reverse = { question: "真实反问", answer: "待核实答复", created_at: "", evaluation: { score: 7, level: "良好", insight: "依据", feedback: "反馈", suggestions: "建议" } };
    db.prepare("UPDATE interviews SET status='finished',report=?,evaluator_report=?,reverse_interview=? WHERE id=1").run(JSON.stringify(report), JSON.stringify(evaluator), JSON.stringify(reverse));
    db.prepare("UPDATE interview_turns SET answer='原答',answered_at='已答',scores=? WHERE id=1").run(JSON.stringify(scores));
  }
  if (scenario === "damaged-history") db.exec("UPDATE interview_turns SET retries='[null]' WHERE id=1");
  const before = db.prepare("SELECT * FROM interviews").all();
  const turnsBefore = db.prepare("SELECT * FROM interview_turns").all();
  const response = await (await import("@/app/api/interviews/[id]/route")).GET(new Request("http://localhost/api/interviews/1"), { params: Promise.resolve({ id: "1" }) });
  expect(response.status).toBe(200);
  const payload = await response.json();
  expect(parseInterviewDetail(payload, 1)).toEqual(payload);
  expect(payload.round_no).toBe(scenario === "series" ? 1 : 0);
  expect(db.prepare("SELECT * FROM interviews").all()).toEqual(before);
  expect(db.prepare("SELECT * FROM interview_turns").all()).toEqual(turnsBefore);
});

it.each([-1, 1.5])("历史评估证据题号 %s 不阻断原题原答读取，且不改写历史记录", async turn_idx => {
  const evaluator = {
    recommendation: "Hire", level: "待核实", level_justification: "依据", summary_for_hr: "摘要",
    hire_reasons: ["回答描述了项目流程"], concerns_and_risks: [], placement_suggestion: "建议",
    evidence_quotes: [{ turn_idx, topic: "项目", observation: "说明项目流程" }],
  };
  db.prepare("UPDATE interviews SET status='finished',evaluator_report=? WHERE id=1").run(JSON.stringify(evaluator));
  db.exec("UPDATE interview_turns SET answer='原答',answered_at='已答' WHERE id=1");
  const before = db.prepare("SELECT * FROM interviews").all();
  const turnsBefore = db.prepare("SELECT * FROM interview_turns").all();

  const response = await (await import("@/app/api/interviews/[id]/route")).GET(new Request("http://localhost/api/interviews/1"), { params: Promise.resolve({ id: "1" }) });
  expect(response.status).toBe(200);
  const detail = parseInterviewDetail(await response.json(), 1);
  expect(detail.turns).toEqual([expect.objectContaining({ question: "原题", answer: "原答" })]);
  expect(detail.evaluator_report).toEqual(evaluator);
  expect(db.prepare("SELECT * FROM interviews").all()).toEqual(before);
  expect(db.prepare("SELECT * FROM interview_turns").all()).toEqual(turnsBefore);
});
