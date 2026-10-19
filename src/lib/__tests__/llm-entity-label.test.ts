import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as DatabaseSync | undefined }));

vi.mock("../db", () => ({
  getDb: () => {
    if (!holder.db) throw new Error("测试未初始化数据库");
    return holder.db;
  },
}));

import { resolveEntityLabel } from "../llm-entity-label";
import { ENTITY_TYPES } from "../llm-source";

const SCHEMA = `
  CREATE TABLE resumes (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
  CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE resume_templates (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE resume_defenses (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
  CREATE TABLE salary_negotiations (id INTEGER PRIMARY KEY, target_role TEXT NOT NULL);
  CREATE TABLE interviews (id INTEGER PRIMARY KEY, resume_id INTEGER, round_no INTEGER NOT NULL);
  CREATE TABLE interview_series (id INTEGER PRIMARY KEY, resume_id INTEGER);
  CREATE TABLE intros (id INTEGER PRIMARY KEY, resume_id INTEGER);
  CREATE TABLE drills (id INTEGER PRIMARY KEY, project_id INTEGER, direction TEXT NOT NULL);
  CREATE TABLE bank_entries (id INTEGER PRIMARY KEY, direction TEXT NOT NULL);
`;

beforeEach(() => {
  holder.db = new DatabaseSync(":memory:");
  holder.db.exec(SCHEMA);
  holder.db.exec(`
    INSERT INTO resumes (id, title) VALUES (1, '前端开发工程师');
    INSERT INTO projects (id, name) VALUES (2, '订单中台');
    INSERT INTO resume_templates (id, name) VALUES (3, '极简单栏');
    INSERT INTO resume_defenses (id, title) VALUES (4, '简历排雷 · 后端');
    INSERT INTO salary_negotiations (id, target_role) VALUES (5, '资深后端');
    INSERT INTO interviews (id, resume_id, round_no) VALUES (6, 1, 3), (7, 1, 0);
    INSERT INTO interview_series (id, resume_id) VALUES (8, 1);
    INSERT INTO intros (id, resume_id) VALUES (9, 1);
    INSERT INTO drills (id, project_id, direction) VALUES (10, 2, ''), (11, NULL, '后端');
    INSERT INTO bank_entries (id, direction) VALUES (12, '前端');
  `);
});

describe("resolveEntityLabel", () => {
  it("本地有标题字段的实体直接取标题", () => {
    expect(resolveEntityLabel("resume", 1)).toBe("前端开发工程师");
    expect(resolveEntityLabel("project", 2)).toBe("订单中台");
    expect(resolveEntityLabel("template", 3)).toBe("极简单栏");
    expect(resolveEntityLabel("defense", 4)).toBe("简历排雷 · 后端");
    expect(resolveEntityLabel("negotiation", 5)).toBe("资深后端");
    expect(resolveEntityLabel("bank_entry", 12)).toBe("前端");
  });

  it("经父表关联取标题", () => {
    expect(resolveEntityLabel("interview", 6)).toBe("前端开发工程师 第3轮");
    expect(resolveEntityLabel("interview", 7)).toBe("前端开发工程师");
    expect(resolveEntityLabel("interview_series", 8)).toBe("前端开发工程师");
    expect(resolveEntityLabel("intro", 9)).toBe("前端开发工程师");
  });

  it("drill 优先取项目名，无项目时回退方向", () => {
    expect(resolveEntityLabel("drill", 10)).toBe("订单中台");
    expect(resolveEntityLabel("drill", 11)).toBe("后端");
  });

  it("无标题字段的类型返回空串", () => {
    expect(resolveEntityLabel("jd_portrait", 1)).toBe("");
    expect(resolveEntityLabel("jargon_decoding", 1)).toBe("");
    expect(resolveEntityLabel("gap_remedy", 1)).toBe("");
  });

  it("实体不存在或 id 非法时返回空串，不抛出", () => {
    expect(resolveEntityLabel("resume", 999)).toBe("");
    expect(resolveEntityLabel("resume", 0)).toBe("");
    expect(resolveEntityLabel("resume", -1)).toBe("");
  });

  it("数据库不可用时返回空串，不抛出", () => {
    holder.db = undefined;
    expect(resolveEntityLabel("resume", 1)).toBe("");
  });

  it("每个 EntityType 都有注册表条目", () => {
    for (const type of ENTITY_TYPES) {
      expect(() => resolveEntityLabel(type, 1)).not.toThrow();
    }
  });
});
