import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readReviewDashboard } from "../review-dashboard";

const model = vi.hoisted(() => ({ chat: vi.fn() }));
vi.mock("@/lib/llm", async original => ({ ...await original<typeof import("@/lib/llm")>(), ...model }));
const prefix = "resume-life-stored-scores-";
let directory: string;
let db: DatabaseSync;
const uniform = (value: number) => ({ depth: value, structure: value, authenticity: value, completeness: value });
const context = { params: Promise.resolve({ id: "1" }) };
const snapshot = () => ["drills", "drill_questions", "interviews", "interview_turns", "notebook_entries", "review_cards"]
  .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());

beforeEach(async () => {
  vi.resetModules(); model.chat.mockReset();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
  db.exec(`
    INSERT INTO projects (id,name,created_at,updated_at) VALUES (1,'小数评分项目','','');
    INSERT INTO drills (id,project_id,created_at) VALUES (1,1,'');
    INSERT INTO drill_questions (id,drill_id,idx,question,answer,answered_at) VALUES (1,1,1,'练习原题','练习原答','saved');
    INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'小数评分简历','','');
    INSERT INTO interviews (id,resume_id,jd,created_at) VALUES (1,1,'岗位','');
    INSERT INTO interview_turns (id,interview_id,idx,question,answer,answered_at) VALUES (1,1,1,'面试原题','面试原答','saved');
  `);
});
afterEach(() => {
  db.close(); vi.unstubAllEnvs();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith(prefix)) throw new Error("Unsafe cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
});

async function seedScores(interview: string, drill = interview) {
  db.prepare("UPDATE interview_turns SET scores=?").run(interview);
  db.prepare("UPDATE drill_questions SET scores=?").run(drill);
  const { POST } = await import("@/app/api/notebook/route");
  for (const source of ["interview", "drill"]) {
    const response = await POST(new Request("http://localhost/api/notebook", {
      method: "POST", body: JSON.stringify({ source, source_id: 1 }),
      headers: { "Content-Type": "application/json" },
    }));
    expect(response.status).toBe(201);
  }
}

async function readAll() {
  const interview = await (await import("@/app/api/interviews/[id]/route")).GET(new Request("http://localhost/api/interviews/1"), context);
  const drill = await (await import("@/app/api/drills/[id]/route")).GET(new Request("http://localhost/api/drills/1"), context);
  const notebook = await (await import("@/app/api/notebook/route")).GET(new Request("http://localhost/api/notebook"));
  const review = await (await import("@/app/api/review/route")).GET(new Request("http://localhost/api/review"));
  for (const response of [interview, drill, notebook, review]) expect(response.status).toBe(200);
  const reviewData = await review.json();
  expect(readReviewDashboard(reviewData)).toEqual(reviewData);
  return { interview: await interview.json(), drill: await drill.json(), notebook: await notebook.json(), review: reviewData,
    overall: (await import("../overall-score")).getOverallScore() };
}

it("同一原分在面试、练习、收藏快照和全部统计中保持小数，读取不写库也不调用模型", async () => {
  await seedScores(JSON.stringify(uniform(7.4)), JSON.stringify(uniform(8.2)));
  const before = snapshot();
  const result = await readAll();
  const { readNotebookListPage } = await import("../notebook-records");
  expect(readNotebookListPage(result.notebook)).toEqual(result.notebook);
  expect.soft(result.interview.turns[0].scores).toEqual(uniform(7.4));
  expect.soft(result.drill.questions[0].scores).toEqual(uniform(8.2));
  expect.soft(result.notebook.items.map((item: { source: string; scores: unknown }) => ({ source: item.source, scores: item.scores })))
    .toEqual([{ source: "drill", scores: uniform(8.2) }, { source: "interview", scores: uniform(7.4) }]);
  expect.soft(result.review).toMatchObject({
    totals: { drills: 1, interviews: 1, scoredAnswers: 2 }, overall: uniform(7.8), overallScore: 7.8,
    drillAvg: uniform(8.2), interviewAvg: uniform(7.4), truncated: false,
    projects: [{ id: 1, name: "小数评分项目", answers: 1, overall: 8.2 }],
  });
  expect.soft(result.review.sessions).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: "drill-1", avg: uniform(8.2), overall: 8.2, count: 1 }),
    expect.objectContaining({ id: "interview-1", avg: uniform(7.4), overall: 7.4, count: 1 }),
  ]));
  expect.soft(result.overall).toBe(7.8);
  expect(snapshot()).toEqual(before);
  expect(model.chat).not.toHaveBeenCalled();
});

it("逐题保留多位小数与零十分边界，只在最终均值取一位；未答题不参与统计", async () => {
  const scores = { depth: 7.44, structure: 0, authenticity: 10, completeness: 8.36 };
  await seedScores(JSON.stringify(scores));
  db.prepare("INSERT INTO drill_questions (drill_id,idx,question,scores) VALUES (1,2,'未答',?)").run(JSON.stringify(uniform(10)));
  db.prepare("INSERT INTO interview_turns (interview_id,idx,question,scores) VALUES (1,2,'未答',?)").run(JSON.stringify(uniform(10)));
  const before = snapshot();
  const result = await readAll();
  expect.soft(result.interview.turns[0].scores).toEqual(scores);
  expect.soft(result.drill.questions[0].scores).toEqual(scores);
  for (const item of result.notebook.items) expect.soft(item.scores).toEqual(scores);
  expect.soft(result.review).toMatchObject({ totals: { scoredAnswers: 2 }, overall: { ...scores, depth: 7.4, completeness: 8.4 }, overallScore: 6.5 });
  expect.soft(result.overall).toBe(6.5);
  expect(snapshot()).toEqual(before);
  expect(model.chat).not.toHaveBeenCalled();
});

it.each([
  ["空列", ""], ["旧 null", "null"], ["坏 JSON", "{"], ["数组", "[]"], ["缺维度", "{}"],
  ["空维度", JSON.stringify({ ...uniform(7.4), depth: null })],
  ["布尔维度", JSON.stringify({ ...uniform(7.4), depth: true })],
  ["负分", JSON.stringify({ ...uniform(7.4), depth: -0.1 })],
  ["超范围", JSON.stringify({ ...uniform(7.4), depth: 10.1 })],
  ["无限值", '{"depth":1e309,"structure":8,"authenticity":7,"completeness":9}'],
])("%s 不被其他入口转换或统计成有效原分，原始记录仍保留", async (_label, raw) => {
  await seedScores(raw);
  const before = snapshot();
  const result = await readAll();
  expect.soft(result.interview.turns[0].scores).toBeNull();
  expect.soft(result.interview.turns[0].scores_error).toContain("原答评分缺失或损坏");
  expect.soft(result.drill.questions[0].scores).toBeNull();
  for (const item of result.notebook.items) expect.soft(item.scores).toBeNull();
  expect.soft(result.review).toMatchObject({ totals: { scoredAnswers: 0 }, overall: null, overallScore: null, sessions: [], projects: [] });
  expect.soft(result.overall).toBeNull();
  expect(snapshot()).toEqual(before);
  expect(model.chat).not.toHaveBeenCalled();
});
