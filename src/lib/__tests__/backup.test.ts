import { describe, it, expect } from "vitest";
import {
  BACKUP_APP_NAME,
  BACKUP_VERSION,
  TABLES_CLEAR_ORDER,
  TABLES_INSERT_ORDER,
  AUTOINCREMENT_TABLES,
  validateBackupPayload,
} from "./backup-fixture";
import { CURRENT_DB_VERSION } from "../db";

describe("backup.ts 数据备份与一致性定义", () => {
  it("TABLES_CLEAR_ORDER 必须完整包含新增的排雷与空窗期数据表", () => {
    expect(TABLES_CLEAR_ORDER).toContain("resume_defense_drills");
    expect(TABLES_CLEAR_ORDER).toContain("resume_defenses");
    expect(TABLES_CLEAR_ORDER).toContain("resignation_gap_remedies");
  });

  it("子表必须在主表之前清空，以维持外键依赖", () => {
    const drillIndex = TABLES_CLEAR_ORDER.indexOf("resume_defense_drills");
    const defenseIndex = TABLES_CLEAR_ORDER.indexOf("resume_defenses");
    expect(drillIndex).toBeLessThan(defenseIndex);

    const moduleIndex = TABLES_CLEAR_ORDER.indexOf("resume_modules");
    const resumeIndex = TABLES_CLEAR_ORDER.indexOf("resumes");
    expect(moduleIndex).toBeLessThan(resumeIndex);
  });

  it("TABLES_INSERT_ORDER 是 TABLES_CLEAR_ORDER 的精确逆序", () => {
    expect(TABLES_INSERT_ORDER).toEqual([...TABLES_CLEAR_ORDER].reverse());
  });

  it("validateBackupPayload 能够拦截格式损坏或非本系统备份包", () => {
    expect(validateBackupPayload(null).valid).toBe(false);
    expect(validateBackupPayload({}).valid).toBe(false);

    const invalidApp = {
      meta: { appName: "other-app" },
      data: {},
    };
    expect(validateBackupPayload(invalidApp).valid).toBe(false);

    const validPayload = {
      meta: {
        appName: BACKUP_APP_NAME,
        version: "1.0.0",
        dbVersion: CURRENT_DB_VERSION,
        createdAt: new Date().toISOString(),
        stats: {},
      },
      data: {
        resumes: [],
      },
    };
    expect(validateBackupPayload(validPayload).valid).toBe(false);
  });

  it("拒绝旧版备份格式，只接受当前版本与当前数据库版本", () => {
    const withMeta = (meta: Record<string, unknown>) => ({
      meta: { appName: BACKUP_APP_NAME, createdAt: new Date().toISOString(), stats: {}, ...meta },
      data: {},
    });

    const oldFormat = validateBackupPayload(withMeta({ version: "0.9.0", dbVersion: CURRENT_DB_VERSION }));
    expect(oldFormat.valid).toBe(false);
    expect(oldFormat).toMatchObject({ error: expect.stringContaining("不支持此备份版本") });

    const oldDatabase = validateBackupPayload(withMeta({ version: BACKUP_VERSION, dbVersion: CURRENT_DB_VERSION - 1 }));
    expect(oldDatabase.valid).toBe(false);
    expect(oldDatabase).toMatchObject({ error: expect.stringContaining("不支持此备份版本") });

    // 普通 JSON（缺少本系统的 appName / version 结构）同样必须被拒绝
    expect(validateBackupPayload({ meta: { appName: BACKUP_APP_NAME }, data: {} }).valid).toBe(false);
    expect(validateBackupPayload({ resumes: [], projects: [] }).valid).toBe(false);
  });

  it("AUTOINCREMENT_TABLES 涵盖所有需要重置自增 ID 的表", () => {
    expect(AUTOINCREMENT_TABLES).toContain("resume_defense_drills");
    expect(AUTOINCREMENT_TABLES).toContain("resume_defenses");
    expect(AUTOINCREMENT_TABLES).toContain("resignation_gap_remedies");
    expect(AUTOINCREMENT_TABLES).toContain("resumes");
    expect(AUTOINCREMENT_TABLES).toContain("applications");
  });
});
