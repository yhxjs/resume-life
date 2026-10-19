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
  it("创建完整 v1 结构并可重复打开，不回填或修改业务数据", () => {
    expect(CURRENT_DB_VERSION).toBe(1);
    initializeDatabase(database);
    database.exec("INSERT INTO resumes (id, title, created_at, updated_at) VALUES (1, '演示简历', '', '')");
    const before = database.prepare("SELECT * FROM resumes").all();
    initializeDatabase(database);
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
    expect(database.prepare("SELECT * FROM resumes").all()).toEqual(before);
    expect(database.prepare("SELECT * FROM resume_versions").all()).toEqual([]);
    expect(() => validateDatabaseSchema(database)).not.toThrow();
    const tables = database.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string; sql: string }[];
    const business = tables.filter(({ name }) => !name.startsWith("search_fts_") && name !== "runtime_state" && !name.startsWith("auth_"));
    expect(business.map(({ name }) => name)).toEqual([...TABLES_CLEAR_ORDER].sort());
    expect(business.filter(({ sql }) => /\bAUTOINCREMENT\b/iu.test(sql)).map(({ name }) => name)).toEqual([...AUTOINCREMENT_TABLES].sort());
  });

  it.each([0, 2, 3])("拒绝含业务表的不受支持版本 v%s，不改版本、表或数据", (version) => {
    database.exec(`CREATE TABLE sentinel (value TEXT); INSERT INTO sentinel VALUES ('保留'); PRAGMA user_version = ${version}`);
    const schema = database.prepare("SELECT * FROM sqlite_master").all();
    expect(() => initializeDatabase(database)).toThrow(/版本|结构/);
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: version });
    expect(database.prepare("SELECT * FROM sqlite_master").all()).toEqual(schema);
    expect(database.prepare("SELECT * FROM sentinel").all()).toEqual([{ value: "保留" }]);
  });

  it.each([
    "ALTER TABLE settings DROP COLUMN proxy_password",
    "DROP INDEX idx_bank_entries_direction_id",
  ])("拒绝当前版本库的残缺结构且不自动修补：%s", (statement) => {
    initializeDatabase(database);
    database.exec(statement);
    const schema = database.prepare("SELECT * FROM sqlite_master").all();
    expect(() => initializeDatabase(database)).toThrow(/结构/);
    expect(database.prepare("SELECT * FROM sqlite_master").all()).toEqual(schema);
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
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

