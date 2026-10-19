import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tempDir: string;
let db: DatabaseSync;

beforeEach(async () => {
  vi.resetModules();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-review-route-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", path.join(tempDir, "data"));
  db = (await import("@/lib/db")).getDb();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (path.dirname(tempDir) !== os.tmpdir() || !path.basename(tempDir).startsWith("resume-life-review-route-")) {
    throw new Error("Unsafe cleanup path");
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

/** handleGet 不接 request，但 withRouteErrorHandling 的签名是 (request, context?)，故单参调用 */
async function callReview() {
  const route = await import("@/app/api/review/route");
  return route.GET(
    new Request("http://127.0.0.1/api/review", {
      headers: { origin: "http://127.0.0.1", host: "127.0.0.1" },
    }),
  );
}

const SCORES = '{"depth":8,"structure":8,"authenticity":8,"completeness":8}';
const ANSWERED_AT = "2026-01-01T00:00:00.000Z";

function insertDrillAnswers(count: number): void {
  const rows: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    rows.push(`(${index}, 1, ${index}, 'q${index}', '', '', '', '${SCORES}', '${ANSWERED_AT}', '')`);
  }
  db.exec("BEGIN");
  for (let offset = 0; offset < rows.length; offset += 250) {
    db.exec(
      `INSERT INTO drill_questions (id, drill_id, idx, question, answer, comment, reference, scores, answered_at, kind)
       VALUES ${rows.slice(offset, offset + 250).join(",")}`,
    );
  }
  db.exec("COMMIT");
}

function insertInterviewAnswers(count: number): void {
  const rows: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    rows.push(`(${index}, 1, ${index}, 'q${index}', '', '', '${SCORES}', '', '[]', '${ANSWERED_AT}')`);
  }
  db.exec("BEGIN");
  for (let offset = 0; offset < rows.length; offset += 250) {
    db.exec(
      `INSERT INTO interview_turns (id, interview_id, idx, question, answer, comment, scores, reference, retries, answered_at)
       VALUES ${rows.slice(offset, offset + 250).join(",")}`,
    );
  }
  db.exec("COMMIT");
}

describe("/api/review 聚合", () => {
  it("练习作答超过 10000 条时只聚合最近作答并标记截断", async () => {
    db.exec("INSERT INTO projects (id, name, created_at, updated_at) VALUES (1, '测试项目', '', '')");
    db.exec(
      `INSERT INTO drills (id, source, project_id, direction, jd, focus, created_at)
       VALUES (1, 'project', 1, '', '', '', '')`,
    );
    const execSpy = vi.spyOn(db, "exec");
    insertDrillAnswers(10_001);
    expect(execSpy.mock.calls.filter(([sql]) => sql.startsWith("INSERT INTO drill_questions"))).toHaveLength(41);

    const res = await callReview();
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.totals).toEqual({ drills: 1, interviews: 0, scoredAnswers: 10_000 });
    expect(payload.sessions[0].count).toBe(10_000);
    expect(payload.projects).toEqual([{ id: 1, name: "测试项目", answers: 10_000, overall: 8 }]);
    expect(payload.truncated).toBe(true);
  }, 15_000);

  it("面试作答超过 10000 条时只聚合最近作答并标记截断", async () => {
    db.exec("INSERT INTO resumes (id, title, created_at, updated_at) VALUES (1, '测试简历', '', '')");
    db.exec("INSERT INTO interviews (id, resume_id, jd, created_at) VALUES (1, 1, 'JD', '')");
    const execSpy = vi.spyOn(db, "exec");
    insertInterviewAnswers(10_001);
    expect(execSpy.mock.calls.filter(([sql]) => sql.startsWith("INSERT INTO interview_turns"))).toHaveLength(41);

    const res = await callReview();
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.totals).toEqual({ drills: 0, interviews: 1, scoredAnswers: 10_000 });
    expect(payload.sessions[0].count).toBe(10_000);
    expect(payload.truncated).toBe(true);
  }, 15_000);

  it("按来源分类统计，综合分取四维均值", async () => {
    db.exec(
      `INSERT INTO drills (id, source, project_id, direction, jd, focus, created_at)
       VALUES (1, 'project', NULL, '', '', '', '')`,
    );
    db.exec(
      `INSERT INTO drill_questions (id, drill_id, idx, question, answer, comment, reference, scores, answered_at, kind)
       VALUES (1, 1, 1, 'q1', '', '', '', '{"depth":6,"structure":6,"authenticity":6,"completeness":6}', '${ANSWERED_AT}', '')`,
    );
    db.exec("INSERT INTO resumes (id, title, created_at, updated_at) VALUES (1, '测试简历', '', '')");
    db.exec("INSERT INTO interviews (id, resume_id, jd, created_at) VALUES (1, 1, 'JD', '')");
    db.exec(
      `INSERT INTO interview_turns (id, interview_id, idx, question, answer, comment, scores, reference, retries, answered_at)
       VALUES (1, 1, 1, 'q1', '', '', '{"depth":10,"structure":10,"authenticity":10,"completeness":10}', '', '[]', '${ANSWERED_AT}')`,
    );

    const payload = await (await callReview()).json();
    expect(payload.totals).toEqual({ drills: 1, interviews: 1, scoredAnswers: 2 });
    expect(payload.drillAvg).toEqual({ depth: 6, structure: 6, authenticity: 6, completeness: 6 });
    expect(payload.interviewAvg).toEqual({ depth: 10, structure: 10, authenticity: 10, completeness: 10 });
    // 四维均值再取均值：(6+10)/2 = 8
    expect(payload.overallScore).toBe(8);
  });

  it("scores 列是损坏 JSON 时按无分处理而不是让接口 500", async () => {
    db.exec(
      `INSERT INTO drills (id, source, project_id, direction, jd, focus, created_at)
       VALUES (1, 'project', NULL, '', '', '', '')`,
    );
    db.exec(
      `INSERT INTO drill_questions (id, drill_id, idx, question, answer, comment, reference, scores, answered_at, kind)
       VALUES (1, 1, 1, 'q1', '', '', '', '不是 JSON', '${ANSWERED_AT}', '')`,
    );

    const res = await callReview();
    expect(res.status).toBe(200);
    expect((await res.json()).totals.scoredAnswers).toBe(0);
  });

  it("主键为非正数的导入作答仍计入复盘", async () => {
    db.exec(
      `INSERT INTO drills (id, source, project_id, direction, jd, focus, created_at)
       VALUES (1, 'project', NULL, '', '', '', '')`,
    );
    db.exec(
      `INSERT INTO drill_questions (id, drill_id, idx, question, answer, comment, reference, scores, answered_at, kind)
       VALUES (0, 1, 1, 'q1', '', '', '', '${SCORES}', '${ANSWERED_AT}', '')`,
    );

    const payload = await (await callReview()).json();
    expect(payload.totals.scoredAnswers).toBe(1);
  });
});
