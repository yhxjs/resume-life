import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEMP_PREFIX = "resume-life-overall-score-";

let directory = "";
let db: DatabaseSync | undefined;

function insertScoredAnswer(table: "drill_questions" | "interview_turns", scores: object, answeredAt = "2026-09-22"): void {
  if (table === "drill_questions") {
    db!.prepare("INSERT INTO projects (id,name,created_at,updated_at) VALUES (1,'项目','','')").run();
    db!.prepare("INSERT INTO drills (id,project_id,created_at) VALUES (1,1,'')").run();
    db!.prepare("INSERT INTO drill_questions (id,drill_id,idx,question,scores,answered_at) VALUES (?,1,1,'题',?,?)")
      .run(Math.floor(Math.random() * 1e9), JSON.stringify(scores), answeredAt);
  } else {
    db!.prepare("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'简历','','')").run();
    db!.prepare("INSERT INTO interviews (id,resume_id,jd,created_at) VALUES (1,1,'JD','')").run();
    db!.prepare("INSERT INTO interview_turns (id,interview_id,idx,kind,question,scores,answered_at) VALUES (?,1,1,'question','题',?,?)")
      .run(Math.floor(Math.random() * 1e9), JSON.stringify(scores), answeredAt);
  }
}

beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("../db")).getDb();
});

afterEach(() => {
  db?.close();
  db = undefined;
  vi.unstubAllEnvs();
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(TEMP_PREFIX)) {
    throw new Error(`Unsafe cleanup target: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
});

describe("getOverallScore 跨表聚合", () => {
  it("大量历史作答只从 SQLite 取一行聚合结果，不逐行加载评分", async () => {
    insertScoredAnswer("drill_questions", { depth: 8, structure: 7, authenticity: 9, completeness: 6 });
    const insert = db!.prepare("INSERT INTO drill_questions (drill_id, idx, question, scores, answered_at) VALUES (1, ?, '题', ?, '2026-09-22')");
    for (let index = 2; index <= 300; index += 1) {
      insert.run(index, JSON.stringify({ depth: 8, structure: 7, authenticity: 9, completeness: 6 }));
    }
    const prepare = vi.spyOn(db!, "prepare");
    try {
      const { getOverallScore } = await import("../overall-score");
      expect(getOverallScore()).toBe(7.5);
      expect(prepare.mock.calls.some(([sql]) => /^SELECT scores FROM drill_questions/iu.test(sql.trim()))).toBe(false);
    } finally {
      prepare.mockRestore();
    }
  });
  it("没有已评分作答时返回 null，而不是 0", async () => {
    const { getOverallScore } = await import("../overall-score");
    expect(getOverallScore()).toBeNull();
  });

  it("同时聚合题目练习与模拟面试的作答，两种来源权重相同", async () => {
    insertScoredAnswer("drill_questions", { depth: 10, structure: 10, authenticity: 10, completeness: 10 });
    insertScoredAnswer("interview_turns", { depth: 0, structure: 0, authenticity: 0, completeness: 0 });

    const { getOverallScore } = await import("../overall-score");
    // 两题各维均分 5 → 综合 5.0；若只扫了一张表会是 10 或 0
    expect(getOverallScore()).toBe(5);
  });

  it("忽略未作答与空评分的行", async () => {
    insertScoredAnswer("drill_questions", { depth: 8, structure: 8, authenticity: 8, completeness: 8 });
    db!.prepare("INSERT INTO drill_questions (id,drill_id,idx,question,scores,answered_at) VALUES (99,1,2,'未答','', '')").run();
    db!.prepare("INSERT INTO drill_questions (id,drill_id,idx,question,scores,answered_at) VALUES (98,1,3,'无分','', '2026-09-22')").run();

    const { getOverallScore } = await import("../overall-score");
    expect(getOverallScore()).toBe(8);
  });

  it("损坏的 scores 按无分跳过，不让整页 500", async () => {
    insertScoredAnswer("drill_questions", { depth: 9, structure: 9, authenticity: 9, completeness: 9 });
    db!.prepare("INSERT INTO drill_questions (id,drill_id,idx,question,scores,answered_at) VALUES (97,1,4,'坏','{broken','2026-09-22')").run();

    const { getOverallScore } = await import("../overall-score");
    expect(getOverallScore()).toBe(9);
  });

  it("overallOf 就是综合分的唯一实现：维度均值再取均值", async () => {
    const { overallOf } = await import("../scores");
    expect(overallOf({ depth: 8, structure: 7, authenticity: 9, completeness: 6 })).toBe(7.5);
  });
});
