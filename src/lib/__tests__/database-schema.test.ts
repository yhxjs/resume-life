import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURRENT_DB_VERSION, initializeDatabase, validateDatabaseSchema } from "../db-schema";
import { AUTOINCREMENT_TABLES, TABLES_CLEAR_ORDER } from "../backup";

let database: DatabaseSync;

beforeEach(() => {
  database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
});

afterEach(() => {
  vi.restoreAllMocks();
  database.close();
});

describe("当前版本数据库契约", () => {
  function legacyRecap(version: number) {
    initializeDatabase(database);
    database.exec(`
      INSERT INTO applications (id,company,role,stage,jd,created_at,updated_at) VALUES (1,'现在公司','现在岗位','interviewing','现在 JD','','');
      INSERT INTO application_interviews (id,application_id,round_name,created_at,updated_at) VALUES (1,1,'现在轮次','','');
      INSERT INTO application_interview_recaps (id,interview_id,input_hash,questions,result,created_at) VALUES (1,1,'${"a".repeat(64)}','[]','{}','');
      DROP TABLE application_preparation_plans; DROP TABLE mcp_generation_requests; DROP TABLE mcp_drafts; DROP TABLE mcp_creation_receipts; DROP TABLE mcp_operation_logs; DROP TABLE interview_question_graphs; DROP TABLE resume_import_source_receipts; DROP TABLE project_material_table_provenance; DROP TABLE application_interview_recap_contexts;
    `);
    if (version < 3) database.exec("DROP TABLE resume_creation_requests");
    if (version < 2) database.exec("DROP TABLE salary_creation_requests");
    database.exec(`PRAGMA user_version=${version}`);
  }

  it.each([1, 2, 3])("v%s 迁移保留历史复盘且来源保持未知，不按当前投递回填", version => {
    legacyRecap(version);
    const recaps = database.prepare("SELECT * FROM application_interview_recaps").all();
    initializeDatabase(database);
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_DB_VERSION });
    expect(database.prepare("SELECT * FROM application_interview_recaps").all()).toEqual(recaps);
    expect(database.prepare("SELECT * FROM application_interview_recap_contexts").all()).toEqual([]);
    expect(() => validateDatabaseSchema(database)).not.toThrow();
  });

  it.each([1, 2, 3])("v%s 在新表创建后失败仍回滚全部结构、版本与历史复盘", version => {
    legacyRecap(version);
    const schema = database.prepare("SELECT * FROM sqlite_master ORDER BY name").all();
    const recaps = database.prepare("SELECT * FROM application_interview_recaps").all();
    const execute = database.exec.bind(database);
    vi.spyOn(database, "exec").mockImplementation(sql => {
      if (sql === `PRAGMA user_version = ${CURRENT_DB_VERSION}`) throw new Error("synthetic final migration failure");
      execute(sql);
    });
    expect(() => initializeDatabase(database)).toThrow("synthetic final migration failure");
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: version });
    expect(database.prepare("SELECT * FROM sqlite_master ORDER BY name").all()).toEqual(schema);
    expect(database.prepare("SELECT * FROM application_interview_recaps").all()).toEqual(recaps);
    expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  });

  it.each([1, 2, 3])("v%s 先校验旧结构，残缺库不创建快照表", version => {
    legacyRecap(version);
    database.exec("DROP INDEX idx_app_interview_recaps_round");
    const schema = database.prepare("SELECT * FROM sqlite_master ORDER BY name").all();
    const execute = vi.spyOn(database, "exec");
    expect(() => initializeDatabase(database)).toThrow(/结构/);
    expect(execute.mock.calls.some(([sql]) => sql.includes("CREATE TABLE"))).toBe(false);
    expect(database.prepare("SELECT * FROM sqlite_master ORDER BY name").all()).toEqual(schema);
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: version });
  });

  it("来源快照随复盘级联删除，且不是独立自增编号", () => {
    legacyRecap(3);
    initializeDatabase(database);
    database.exec("INSERT INTO application_interview_recap_contexts VALUES (1,'原公司','原岗位','原轮次','原 JD')");
    expect(() => database.exec("INSERT INTO application_interview_recap_contexts VALUES (1,'','','','')")).toThrow();
    expect(() => database.exec("INSERT INTO application_interview_recap_contexts VALUES (2,'','','','')")).toThrow();
    expect(() => database.exec("UPDATE application_interview_recap_contexts SET jd=NULL")).toThrow();
    expect(database.prepare("SELECT name FROM sqlite_sequence WHERE name='application_interview_recap_contexts'").get()).toBeUndefined();
    database.exec("DELETE FROM application_interview_recaps WHERE id=1");
    expect(database.prepare("SELECT * FROM application_interview_recap_contexts").all()).toEqual([]);
  });

  it("完整 v2 库升级到 v10，保留已有谈薪回执和业务数据", () => {
    initializeDatabase(database);
    database.exec("DROP TABLE application_preparation_plans; DROP TABLE mcp_generation_requests; DROP TABLE mcp_drafts; DROP TABLE mcp_creation_receipts; DROP TABLE mcp_operation_logs; DROP TABLE interview_question_graphs; DROP TABLE resume_import_source_receipts; DROP TABLE project_material_table_provenance; DROP TABLE application_interview_recap_contexts; DROP TABLE resume_creation_requests; PRAGMA user_version=2; INSERT INTO salary_creation_requests VALUES ('原编号','原哈希','failed',NULL,''); INSERT INTO resumes (title,created_at,updated_at) VALUES ('原简历','','')");
    const previous = database.prepare("SELECT * FROM salary_creation_requests").all();
    initializeDatabase(database);
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_DB_VERSION });
    expect(database.prepare("SELECT * FROM salary_creation_requests").all()).toEqual(previous);
    expect(database.prepare("SELECT title FROM resumes").all()).toEqual([{ title: "原简历" }]);
    expect(database.prepare("SELECT * FROM resume_creation_requests").all()).toEqual([]);
  });

  it("v2 升级回执建表失败时保持原版本、结构与数据", () => {
    initializeDatabase(database);
    database.exec("DROP TABLE application_preparation_plans; DROP TABLE mcp_generation_requests; DROP TABLE mcp_drafts; DROP TABLE mcp_creation_receipts; DROP TABLE mcp_operation_logs; DROP TABLE interview_question_graphs; DROP TABLE resume_import_source_receipts; DROP TABLE project_material_table_provenance; DROP TABLE application_interview_recap_contexts; DROP TABLE resume_creation_requests; PRAGMA user_version=2");
    const before = database.prepare("SELECT * FROM sqlite_master ORDER BY name").all();
    const execute = database.exec.bind(database);
    vi.spyOn(database, "exec").mockImplementation(sql => {
      if (sql.includes("CREATE TABLE IF NOT EXISTS resume_creation_requests")) throw new Error("synthetic migration failure");
      execute(sql);
    });
    expect(() => initializeDatabase(database)).toThrow("synthetic migration failure");
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    expect(database.prepare("SELECT * FROM sqlite_master ORDER BY name").all()).toEqual(before);
  });
  it("完整 v1 库原子升级到 v10，业务与登录数据保持原样", () => {
    initializeDatabase(database);
    database.exec("DROP TABLE application_preparation_plans; DROP TABLE mcp_generation_requests; DROP TABLE mcp_drafts; DROP TABLE mcp_creation_receipts; DROP TABLE mcp_operation_logs; DROP TABLE interview_question_graphs; DROP TABLE resume_import_source_receipts; DROP TABLE project_material_table_provenance; DROP TABLE application_interview_recap_contexts; DROP TABLE resume_creation_requests; DROP TABLE salary_creation_requests; PRAGMA user_version=1; INSERT INTO resumes (title,created_at,updated_at) VALUES ('原稿','','')");
    const before = database.prepare("SELECT * FROM resumes").all();
    initializeDatabase(database);
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_DB_VERSION });
    expect(database.prepare("SELECT * FROM resumes").all()).toEqual(before);
    expect(database.prepare("SELECT * FROM salary_creation_requests").all()).toEqual([]);
  });

  it.each([false, true])("v1 升级拒绝残缺结构或回滚失败写入（%s）", (broken) => {
    initializeDatabase(database);
    database.exec("DROP TABLE application_preparation_plans; DROP TABLE mcp_generation_requests; DROP TABLE mcp_drafts; DROP TABLE mcp_creation_receipts; DROP TABLE mcp_operation_logs; DROP TABLE interview_question_graphs; DROP TABLE resume_import_source_receipts; DROP TABLE project_material_table_provenance; DROP TABLE application_interview_recap_contexts; DROP TABLE resume_creation_requests; DROP TABLE salary_creation_requests; PRAGMA user_version=1");
    if (broken) database.exec("DROP INDEX idx_bank_entries_direction_id");
    else {
      const execute = database.exec.bind(database);
      vi.spyOn(database, "exec").mockImplementation((sql) => {
        if (sql.includes("CREATE TABLE IF NOT EXISTS salary_creation_requests")) throw new Error("synthetic migration failure");
        execute(sql);
      });
    }
    const before = database.prepare("SELECT * FROM sqlite_master ORDER BY name").all();
    expect(() => initializeDatabase(database)).toThrow();
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    expect(database.prepare("SELECT * FROM sqlite_master ORDER BY name").all()).toEqual(before);
  });

  it("创建完整 v10 结构并可重复打开，不回填或修改业务数据", () => {
    expect(CURRENT_DB_VERSION).toBe(10);
    initializeDatabase(database);
    database.exec("INSERT INTO resumes (id, title, created_at, updated_at) VALUES (1, '演示简历', '', '')");
    const before = database.prepare("SELECT * FROM resumes").all();
    initializeDatabase(database);
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_DB_VERSION });
    expect(database.prepare("SELECT * FROM resumes").all()).toEqual(before);
    expect(database.prepare("SELECT * FROM resume_versions").all()).toEqual([]);
    expect(() => validateDatabaseSchema(database)).not.toThrow();
    const tables = database.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string; sql: string }[];
    const business = tables.filter(({ name }) => !name.startsWith("search_fts_") && name !== "runtime_state" && name !== "resume_import_source_receipts" && name !== "salary_creation_requests" && name !== "resume_creation_requests" && !name.startsWith("auth_") && !name.startsWith("mcp_"));
    expect(business.map(({ name }) => name)).toEqual([...TABLES_CLEAR_ORDER].sort());
    expect(business.filter(({ sql }) => /\bAUTOINCREMENT\b/iu.test(sql)).map(({ name }) => name)).toEqual([...AUTOINCREMENT_TABLES].sort());
  });

  it("从完整 v7 库原子升级并创建题目图谱历史表", () => {
    initializeDatabase(database);
    database.exec("INSERT INTO resumes (id, title, created_at, updated_at) VALUES (1, '保留简历', '', ''); DROP TABLE mcp_generation_requests; DROP TABLE mcp_drafts; DROP TABLE mcp_creation_receipts; DROP TABLE mcp_operation_logs; DROP TABLE interview_question_graphs; PRAGMA user_version=7");
    expect(() => validateDatabaseSchema(database, 7)).not.toThrow();
    initializeDatabase(database);
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_DB_VERSION });
    expect(database.prepare("SELECT title FROM resumes WHERE id=1").get()).toEqual({ title: "保留简历" });
    expect(database.prepare("PRAGMA table_info(interview_question_graphs)").all().map(row => (row as { name: string }).name)).toContain("history_json");
    expect(() => validateDatabaseSchema(database)).not.toThrow();
  });

  it("从完整 v8 库原子升级到 v10，创建本机 MCP 状态且不改业务数据", () => {
    initializeDatabase(database);
    database.exec("INSERT INTO resumes (title,created_at,updated_at) VALUES ('保留原稿','',''); DROP TABLE mcp_generation_requests; DROP TABLE mcp_drafts; DROP TABLE mcp_creation_receipts; DROP TABLE mcp_operation_logs; PRAGMA user_version=8");
    const before = database.prepare("SELECT * FROM resumes").all();
    expect(() => validateDatabaseSchema(database, 8)).not.toThrow();
    initializeDatabase(database);
    expect(database.prepare("SELECT * FROM resumes").all()).toEqual(before);
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_DB_VERSION });
    expect(database.prepare("SELECT * FROM mcp_creation_receipts").all()).toEqual([]);
    expect(() => validateDatabaseSchema(database)).not.toThrow();
  });

  it("v8 到 v10 建表失败时完整回滚", () => {
    initializeDatabase(database);
    database.exec("DROP TABLE mcp_generation_requests; DROP TABLE mcp_drafts; DROP TABLE mcp_creation_receipts; DROP TABLE mcp_operation_logs; PRAGMA user_version=8");
    const before = database.prepare("SELECT * FROM sqlite_master ORDER BY name").all();
    const execute = database.exec.bind(database);
    vi.spyOn(database, "exec").mockImplementation(sql => {
      if (sql === `PRAGMA user_version = ${CURRENT_DB_VERSION}`) throw new Error("migration failed");
      execute(sql);
    });
    expect(() => initializeDatabase(database)).toThrow("migration failed");
    expect(database.prepare("SELECT * FROM sqlite_master ORDER BY name").all()).toEqual(before);
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 8 });
  });

  it.each([0, 11, 12])("拒绝含业务表的不受支持版本 v%s，不改版本、表或数据", (version) => {
    database.exec(`CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('保留'); PRAGMA user_version = ${version}`);
    const schema = database.prepare("SELECT * FROM sqlite_master").all();
    expect(() => initializeDatabase(database)).toThrow(/版本|结构/);
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: version });
    expect(database.prepare("SELECT * FROM sqlite_master").all()).toEqual(schema);
    expect(database.prepare("SELECT * FROM sentinel").all()).toEqual([{ value: "保留" }]);
  });

  it("v9 upgrades atomically while retaining already-issued drafts and receipts", () => {
    initializeDatabase(database);
    database.exec("INSERT INTO applications (id,company,role,stage,created_at,updated_at) VALUES (1,'公司','开发','interested','',''); INSERT INTO mcp_drafts (kind,application_id,source_revision,payload,created_at,expires_at) VALUES ('jd',1,'revision','{}','','2099-01-01'); INSERT INTO mcp_creation_receipts VALUES ('create_application','old-request','hash','initial',1,''); DROP TABLE mcp_generation_requests; PRAGMA user_version=9");
    const drafts = database.prepare("SELECT * FROM mcp_drafts").all(); const receipts = database.prepare("SELECT * FROM mcp_creation_receipts").all();
    initializeDatabase(database);
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_DB_VERSION });
    expect(database.prepare("SELECT * FROM mcp_drafts").all()).toEqual(drafts); expect(database.prepare("SELECT * FROM mcp_creation_receipts").all()).toEqual(receipts);
    expect(database.prepare("SELECT * FROM mcp_generation_requests").all()).toEqual([]);
  });

  it("a failed v9 upgrade rolls back the request table and keeps the original database usable", () => {
    initializeDatabase(database); database.exec("DROP TABLE mcp_generation_requests; PRAGMA user_version=9");
    const before = database.prepare("SELECT * FROM sqlite_master ORDER BY name").all(); const execute = database.exec.bind(database);
    vi.spyOn(database, "exec").mockImplementation(sql => { if (sql === `PRAGMA user_version = ${CURRENT_DB_VERSION}`) throw new Error("v10 migration failed"); execute(sql); });
    expect(() => initializeDatabase(database)).toThrow("v10 migration failed");
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 9 }); expect(database.prepare("SELECT * FROM sqlite_master ORDER BY name").all()).toEqual(before);
  });

  it.each([
    "ALTER TABLE settings DROP COLUMN proxy_password",
    "DROP INDEX idx_bank_entries_direction_id",
    "DROP TABLE resume_creation_requests",
    "DROP TABLE mcp_generation_requests; DROP TABLE mcp_drafts; DROP TABLE mcp_creation_receipts; DROP TABLE mcp_operation_logs; DROP TABLE interview_question_graphs",
    "DROP TABLE application_interview_recap_contexts",
  ])("拒绝当前版本库的残缺结构且不自动修补：%s", (statement) => {
    initializeDatabase(database);
    database.exec(statement);
    const schema = database.prepare("SELECT * FROM sqlite_master").all();
    expect(() => initializeDatabase(database)).toThrow(/结构/);
    expect(database.prepare("SELECT * FROM sqlite_master").all()).toEqual(schema);
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: CURRENT_DB_VERSION });
  });

  it("初始化失败时回滚表与版本并保持外键检查启用", () => {
    const execute = database.exec.bind(database);
    const failure = new Error("synthetic index failure");
    vi.spyOn(database, "exec").mockImplementation((sql) => {
      if (sql.includes("CREATE INDEX")) throw failure;
      execute(sql);
    });
    expect(() => initializeDatabase(database)).toThrow(failure);
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 0 });
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]);
    expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
  });
});

it("首版库提供题库方向游标索引并由查询计划使用", async () => {
    initializeDatabase(database);
    database.exec(`
      WITH RECURSIVE sequence(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1 FROM sequence WHERE value < 500
      )
      INSERT INTO bank_entries (direction, kind, question, created_at)
      SELECT CASE value % 2 WHEN 0 THEN '后端' ELSE '前端' END, 'tech', '题目 ' || value, ''
      FROM sequence;
    `);


    initializeDatabase(database);
    const indexNames = database.prepare("PRAGMA index_list(bank_entries)").all() as { name: string }[];
    expect(indexNames.map(({ name }) => name)).toContain("idx_bank_entries_direction_id");

    const plan = database.prepare(
      "EXPLAIN QUERY PLAN SELECT id, kind, question FROM bank_entries WHERE direction = ? AND id > ? ORDER BY id LIMIT ?",
    ).all("后端", 0, 50) as { detail: string }[];
    expect(plan.map(({ detail }) => detail).join("\n"))
      .toMatch(/SEARCH bank_entries USING INDEX idx_bank_entries_direction_id/i);
  });

it("首版库提供投递复合游标索引并由全局与阶段查询使用", async () => {
    initializeDatabase(database);
    database.exec(`
      WITH RECURSIVE sequence(value) AS (
        SELECT 1
        UNION ALL
        SELECT value + 1 FROM sequence WHERE value < 500
      )
      INSERT INTO applications (company, role, stage, created_at, updated_at)
      SELECT
        '公司 ' || value,
        '工程师',
        CASE value % 2 WHEN 0 THEN 'applied' ELSE 'interested' END,
        '2026-01-01T00:00:00.000Z',
        printf('2026-09-%02dT00:00:00.000Z', (value % 28) + 1)
      FROM sequence;
    `);

    initializeDatabase(database);
    const indexNames = database.prepare("PRAGMA index_list(applications)").all() as { name: string }[];
    expect(indexNames.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "idx_applications_updated_at_id",
      "idx_applications_stage_updated_at_id",
    ]));

    const globalPlan = database.prepare(`
      EXPLAIN QUERY PLAN
      SELECT a.* FROM applications a INDEXED BY idx_applications_updated_at_id
      WHERE (a.updated_at, a.id) < (?, ?)
      ORDER BY a.updated_at DESC, a.id DESC
      LIMIT ?
    `).all("2026-09-16T00:00:00.000Z", 250, 51) as { detail: string }[];
    const stagePlan = database.prepare(`
      EXPLAIN QUERY PLAN
      SELECT a.* FROM applications a INDEXED BY idx_applications_stage_updated_at_id
      WHERE a.stage = ? AND (a.updated_at, a.id) < (?, ?)
      ORDER BY a.updated_at DESC, a.id DESC
      LIMIT ?
    `).all("applied", "2026-09-16T00:00:00.000Z", 250, 51) as { detail: string }[];
    const globalDetails = globalPlan.map(({ detail }) => detail).join("\n");
    const stageDetails = stagePlan.map(({ detail }) => detail).join("\n");

    expect(globalDetails).toMatch(/SEARCH a USING INDEX idx_applications_updated_at_id/i);
    expect(stageDetails).toMatch(/SEARCH a USING INDEX idx_applications_stage_updated_at_id/i);
    expect(globalDetails).not.toMatch(/\bSCAN a\b|USE TEMP B-TREE/i);
    expect(stageDetails).not.toMatch(/\bSCAN a\b|USE TEMP B-TREE/i);
  });

