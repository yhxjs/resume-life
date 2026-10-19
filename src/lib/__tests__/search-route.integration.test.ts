import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let directory: string;
let database: DatabaseSync | undefined;

beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-search-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  database = (await import("../db")).getDb();
});

afterEach(() => {
  vi.restoreAllMocks();
  database?.close();
  database = undefined;
  vi.unstubAllEnvs();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-search-")) {
    throw new Error("Unsafe cleanup path");
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

async function search(query: string) {
  const url = new URL("http://127.0.0.1/api/search");
  url.searchParams.set("q", query);
  const { GET } = await import("@/app/api/search/route");
  const response = await GET(new Request(url, { headers: { host: "127.0.0.1" } }));
  expect(response.status).toBe(200);
  return response.json();
}

describe("全局搜索索引", () => {
  it("给五类搜索结果建三元组索引，并同步处理修改和级联删除", async () => {
    const db = database!;
    db.exec(`
      INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'helios resume','','');
      INSERT INTO resume_modules (resume_id,module_key,type,content,updated_at) VALUES (1,'basic','basic','{"summary":"helios module"}','');
      INSERT INTO projects (id,name,created_at,updated_at) VALUES (1,'helios project','','');
      INSERT INTO project_materials (project_id,title,content,created_at) VALUES (1,'helios material','content','');
      INSERT INTO drills (id,source,direction,created_at) VALUES (1,'bank','前端','');
      INSERT INTO drill_questions (drill_id,idx,question) VALUES (1,1,'helios question');
      INSERT INTO interviews (id,resume_id,jd,created_at) VALUES (1,1,'helios JD','');
      INSERT INTO interview_turns (interview_id,idx,question) VALUES (1,1,'helios followup');
      INSERT INTO applications (company,role,stage,notes,created_at,updated_at) VALUES ('公司','工程师','interested','helios notes','','');
    `);
    const initial = await search("lio");
    for (const category of ["resumes", "projects", "questions", "interviews", "applications"]) {
      expect(initial[category]).toHaveLength(1);
    }
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT rowid FROM search_fts_applications WHERE search_fts_applications MATCH 'lio'").all() as { detail: string }[];
    expect(plan.some((step) => step.detail.includes("VIRTUAL TABLE INDEX"))).toBe(true);

    db.exec(`
      UPDATE resumes SET title='ordinary resume';
      UPDATE resume_modules SET content='{}';
      UPDATE projects SET name='ordinary project';
      UPDATE project_materials SET title='ordinary material';
      UPDATE drill_questions SET question='ordinary question';
      UPDATE interviews SET jd='ordinary JD';
      UPDATE interview_turns SET question='ordinary followup';
      UPDATE applications SET notes='ordinary notes';
    `);
    const updated = await search("lio");
    for (const category of ["resumes", "projects", "questions", "interviews", "applications"]) {
      expect(updated[category]).toEqual([]);
    }

    db.exec("UPDATE resume_modules SET content='helios again'; DELETE FROM resumes WHERE id=1");
    expect((await search("lio")).resumes).toEqual([]);
  });

  it("单一主体有多个匹配片段时正确返回 snippets", async () => {
    const db = database!;
    db.exec(`
      INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'普通标题简历','','');
      INSERT INTO resume_modules (resume_id,module_key,type,content,updated_at) VALUES
        (1,'work','work','{"company":"Alpha","desc":"负责React架构演进与微前端改造"}',''),
        (1,'projects','projects','{"name":"Beta","desc":"基于React服务端渲染提升性能"}','');

      INSERT INTO projects (id,name,summary,created_at,updated_at) VALUES (1,'项目A','核心技术栈包含React与Redux','','');
      INSERT INTO project_materials (project_id,title,content,created_at) VALUES
        (1,'架构说明','详细说明React状态流转机制与设计规范','');

      INSERT INTO drills (id,source,direction,created_at) VALUES (1,'bank','前端','');
      INSERT INTO drill_questions (drill_id,idx,question,answer,comment,reference) VALUES
        (1,1,'讲讲React底层实现','在项目中React组件树调度使用Fiber机制','React要点总结不错','掌握React协调算法');

      INSERT INTO applications (company,role,stage,notes,jd,created_at,updated_at) VALUES
        ('字节','前端工程师','interviewing','面试重点问了React底层实现','要求精通React生态和源码','','');
    `);

    const result = await search("React");
    expect(result.resumes[0].snippets.length).toBeGreaterThanOrEqual(2);
    expect(result.projects[0].snippets.length).toBeGreaterThanOrEqual(2);
    expect(result.questions[0].snippets.length).toBeGreaterThanOrEqual(2);
    expect(result.applications[0].snippets.length).toBeGreaterThanOrEqual(2);

    for (const snippet of result.resumes[0].snippets) {
      expect(snippet.text).toContain("React");
    }
  });

  it("短中文词和 LIKE 转义字符保持原有匹配语义", async () => {
    database!.prepare("INSERT INTO applications (company,role,stage,notes,created_at,updated_at) VALUES ('公司','工程师','interested',?,'','')")
      .run("前端框架 a+b 💼工作 100% 性能_x 路径\\tmp");
    for (const query of ["前端", "前端框", "a+b", "💼工", "100%", "_x", "\\tmp"]) {
      expect((await search(query)).applications).toHaveLength(1);
    }
    expect((await search("100_"))).toEqual({ resumes: [], projects: [], questions: [], interviews: [], applications: [] });
  });

  it.each(["needle", "针", "100%", "_needle", "\\needle"])("批量片段查询保持主体上限、顺序和有界读取：%s", async (query) => {
    const db = database!;
    const resume = db.prepare("INSERT INTO resumes(id,title,created_at,updated_at) VALUES (?,'简历','',?)");
    const project = db.prepare("INSERT INTO projects(id,name,created_at,updated_at) VALUES (?,'项目','',?)");
    const interview = db.prepare("INSERT INTO interviews(id,resume_id,jd,created_at) VALUES (?,?,'','')");
    const insertModule = db.prepare("INSERT INTO resume_modules(resume_id,module_key,type,label,content,updated_at) VALUES (?,?,'custom',?,?,'')");
    const material = db.prepare("INSERT INTO project_materials(project_id,title,content,created_at) VALUES (?,?,?,'')");
    const turn = db.prepare("INSERT INTO interview_turns(interview_id,idx,question) VALUES (?,?,?)");
    db.exec("BEGIN");
    for (let id = 1; id <= 9; id += 1) {
      const timestamp = `2026-10-01T00:00:${String(id).padStart(2, "0")}Z`;
      resume.run(id, timestamp);
      project.run(id, timestamp);
      interview.run(id, id);
      for (let child = 1; child <= 10; child += 1) {
        insertModule.run(id, `custom_${child}`, `简历${id}-${child}`, JSON.stringify({ text: `${query} 模块${child}` }));
        material.run(id, `项目${id}-${child}`, `${query} 材料${child}`);
        turn.run(id, child, `${query} 追问${child}`);
      }
    }
    db.exec("COMMIT");

    let queryCount = 0;
    const childBatchSizes: number[] = [];
    const prepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation((sql) => {
      const statement = prepare(sql);
      const all = statement.all.bind(statement);
      vi.spyOn(statement, "all").mockImplementation((...params) => {
        queryCount += 1;
        const rows = all(...params);
        if (rows.length && !Object.hasOwn(rows[0]!, "id")) childBatchSizes.push(rows.length);
        return rows;
      });
      return statement;
    });

    const result = await search(query);
    const expectedIds = [9, 8, 7, 6, 5, 4, 3, 2];
    for (const category of ["resumes", "projects", "interviews"]) {
      expect(result[category].map((item: { id: number }) => item.id)).toEqual(expectedIds);
      for (const item of result[category]) {
        expect(item.snippets).toHaveLength(3);
        expect(item.snippets.every((snippet: { text: string }) => snippet.text.includes(query))).toBe(true);
      }
    }
    expect(result.resumes[0].snippets.map((snippet: { source: string }) => snippet.source)).toEqual(["简历9-1", "简历9-2", "简历9-3"]);
    expect(result.projects[0].snippets.map((snippet: { source: string }) => snippet.source)).toEqual(["项目9-1", "项目9-2", "项目9-3"]);
    // 五类主查询，加三类片段查询；主体数增加不会增加数据库调用。
    expect(queryCount).toBeLessThanOrEqual(8);
    expect(childBatchSizes).toHaveLength(3);
    expect(childBatchSizes.every((size) => size <= 8 * 4)).toBe(true);

    const { loadSearchMatches } = await import("../search-matches");
    const { escapeLike } = await import("../db");
    for (const kind of ["resume", "project", "interview"] as const) {
      const matches = loadSearchMatches(db, kind, expectedIds, `%${escapeLike(query)}%`);
      expect([...matches.keys()].toSorted()).toEqual(expectedIds.toSorted());
      for (const id of expectedIds) expect(matches.get(id)).toHaveLength(4);
    }
  });

  it("没有主体时不执行片段查询，空搜索保持空结果", async () => {
    const { loadSearchMatches } = await import("../search-matches");
    const prepare = vi.spyOn(database!, "prepare");
    for (const kind of ["resume", "project", "interview"] as const) {
      expect(loadSearchMatches(database!, kind, [], "%needle%").size).toBe(0);
    }
    expect(prepare).not.toHaveBeenCalled();
    expect(await search(" ")).toEqual({ resumes: [], projects: [], questions: [], interviews: [], applications: [] });
    expect(prepare.mock.calls.filter(([sql]) => !sql.includes("FROM runtime_state"))).toEqual([]);
  });

  it("多表大样本的稀有词检索完整且 p95 低于慢查询阈值", async () => {
    const db = database!;
    db.exec("INSERT INTO drills (id,source,direction,created_at) VALUES (1,'bank','测试','')");
    const insertResume = db.prepare("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (?,?,'','')");
    const insertModule = db.prepare("INSERT INTO resume_modules (resume_id,module_key,type,content,updated_at) VALUES (?,'basic','basic',?,'')");
    const insertProject = db.prepare("INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,'','')");
    const insertMaterial = db.prepare("INSERT INTO project_materials (project_id,title,content,created_at) VALUES (?,'材料',?,'')");
    const insertQuestion = db.prepare("INSERT INTO drill_questions (drill_id,idx,question) VALUES (1,?,?)");
    const insertInterview = db.prepare("INSERT INTO interviews (id,resume_id,jd,created_at) VALUES (?,?,?,'')");
    const insertTurn = db.prepare("INSERT INTO interview_turns (interview_id,idx,question) VALUES (?,1,?)");
    const insertApplication = db.prepare("INSERT INTO applications (company,role,stage,notes,created_at,updated_at) VALUES ('公司','工程师','interested',?,'','')");
    db.exec("BEGIN");
    for (let index = 1; index <= 1_000; index += 1) {
      const text = index === 500 ? "unique-trigram-needle" : `ordinary record ${index}`;
      insertResume.run(index, text);
      insertModule.run(index, JSON.stringify({ summary: text }));
      insertProject.run(index, text);
      insertMaterial.run(index, text);
      insertQuestion.run(index, index === 500 ? text : `ordinary question ${index}`);
      insertInterview.run(index, index, text);
      insertTurn.run(index, text);
      insertApplication.run(text);
    }
    db.exec("COMMIT");

    const durations: number[] = [];
    const shortDurations: number[] = [];
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const started = performance.now();
      const result = await search("unique-trigram-needle");
      durations.push(performance.now() - started);
      for (const category of ["resumes", "projects", "questions", "interviews", "applications"]) {
        expect(result[category]).toHaveLength(1);
      }
      const shortStarted = performance.now();
      const shortResult = await search("不");
      shortDurations.push(performance.now() - shortStarted);
      for (const category of ["resumes", "projects", "questions", "interviews", "applications"]) {
        expect(shortResult[category]).toHaveLength(0);
      }
    }
    const p95 = (samples: number[]) => samples.sort((left, right) => left - right)[Math.ceil(samples.length * 0.95) - 1]!;
    console.info(`搜索合成基准：约 8000 行，稀有词 p95=${p95(durations).toFixed(1)}ms，短词 p95=${p95(shortDurations).toFixed(1)}ms`);
    expect(p95(durations)).toBeLessThan(500);
    expect(p95(shortDurations)).toBeLessThan(500);
  }, 30_000);
});
