import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMP_PREFIX = "resume-life-notebook-sync-test-";

let tempDir: string;
let db: DatabaseSync;

beforeEach(async () => {
  vi.resetModules();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", path.join(tempDir, "data"));
  db = (await import("@/lib/db")).getDb();
});

afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  const resolved = path.resolve(tempDir);
  if (
    path.dirname(resolved) !== path.resolve(os.tmpdir())
    || !path.basename(resolved).startsWith(TEMP_PREFIX)
  ) {
    throw new Error(`Unsafe cleanup path: ${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
});

describe("notebook snapshot completion", () => {
  it("syncNotebookSnapshot 同步题目练习的标准答案与作答详情到错题本", async () => {
    const { syncNotebookSnapshot } = await import("@/lib/notebook");

    // 预先收藏了一道未作答的题目
    db.prepare(`
      INSERT INTO notebook_entries (source, source_id, question, answer, comment, reference, scores, created_at, updated_at)
      VALUES ('drill', 101, '什么是事件循环？', '', '', '', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `).run();

    // 模拟提交回答并生成参考答案
    const updated = syncNotebookSnapshot(db, "drill", 101, {
      answer: "事件循环是 JavaScript 处理异步事件的机制...",
      comment: "回答条理清晰",
      reference: "事件循环（Event Loop）的标准解析：宏任务、微任务...",
      scores: JSON.stringify({ depth: 8, structure: 8, authenticity: 8, completeness: 8 }),
    });

    expect(updated).toBe(true);

    const entry = db.prepare("SELECT * FROM notebook_entries WHERE source = 'drill' AND source_id = 101").get() as {
      answer: string;
      comment: string;
      reference: string;
      scores: string;
      updated_at: string;
    };

    expect(entry.answer).toContain("事件循环是 JavaScript");
    expect(entry.comment).toBe("回答条理清晰");
    expect(entry.reference).toContain("事件循环（Event Loop）的标准解析");
    expect(entry.scores).toContain('"depth":8');
    expect(entry.updated_at).not.toBe("2026-01-01T00:00:00.000Z");
  });

  it("syncNotebookSnapshot 在题目未被收藏时不报错且返回 false", async () => {
    const { syncNotebookSnapshot } = await import("@/lib/notebook");
    const updated = syncNotebookSnapshot(db, "drill", 999, {
      reference: "参考答案",
    });
    expect(updated).toBe(false);
  });

  it.each(["drill", "interview"] as const)("%s 不会覆盖已有收藏字段或改变更新时间", async (source) => {
    const { syncNotebookSnapshot } = await import("@/lib/notebook");

    db.prepare(`
      INSERT INTO notebook_entries (source, source_id, question, answer, comment, reference, scores, created_at, updated_at)
      VALUES (?, 201, '介绍下项目的核心挑战', '原回答', '原点评', '原参考答案', '{"depth":6}', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `).run(source);

    const updated = syncNotebookSnapshot(db, source, 201, {
      reference: "新参考答案",
      answer: "新回答",
      comment: "新点评",
      scores: '{"depth":9}',
    });

    expect(updated).toBe(false);

    expect(db.prepare("SELECT answer, comment, reference, scores, updated_at FROM notebook_entries WHERE source = ? AND source_id = 201").get(source)).toEqual({
      answer: "原回答",
      comment: "原点评",
      reference: "原参考答案",
      scores: '{"depth":6}',
      updated_at: "2026-01-01T00:00:00.000Z",
    });
  });

  it("只补齐空字段，不接受空白输入，重复补齐不改变快照", async () => {
    const { syncNotebookSnapshot } = await import("@/lib/notebook");

    db.prepare(`
      INSERT INTO notebook_entries (source, source_id, question, answer, comment, reference, scores, created_at, updated_at)
      VALUES ('drill', 501, '什么是闭包？', '原回答', '', '', '', '2026-01-01', '2026-01-01')
    `).run();
    expect(syncNotebookSnapshot(db, "drill", 501, { comment: " \n ", reference: "" })).toBe(false);
    expect(syncNotebookSnapshot(db, "drill", 501, { answer: "新回答", reference: "首次参考", scores: '{"depth":8}' })).toBe(true);
    const entry = db.prepare("SELECT answer, comment, reference, scores, updated_at FROM notebook_entries WHERE source_id = 501").get();
    expect(entry).toMatchObject({ answer: "原回答", comment: "", reference: "首次参考", scores: '{"depth":8}' });
    expect(syncNotebookSnapshot(db, "drill", 501, { reference: "再次生成", scores: '{"depth":9}' })).toBe(false);
    expect(db.prepare("SELECT answer, comment, reference, scores, updated_at FROM notebook_entries WHERE source_id = 501").get()).toEqual(entry);
  });

  it("补齐与源记录写入在外层事务失败时一起回滚", async () => {
    const { syncNotebookSnapshot } = await import("@/lib/notebook");
    const { inTransaction } = await import("@/lib/db");
    db.prepare("INSERT INTO drills (id, source, jd, focus, created_at) VALUES (1, 'bank', '', '', '2026-01-01')").run();
    db.prepare("INSERT INTO notebook_entries (source, source_id, question, created_at, updated_at) VALUES ('drill', 501, '题目', '2026-01-01', '2026-01-01')").run();
    expect(() => inTransaction(() => {
      db.prepare("UPDATE drills SET focus = '已修改' WHERE id = 1").run();
      syncNotebookSnapshot(db, "drill", 501, { reference: "新参考" });
      throw new Error("模拟后续写入失败");
    })).toThrow("模拟后续写入失败");
    expect(db.prepare("SELECT focus FROM drills WHERE id = 1").get()).toEqual({ focus: "" });
    expect(db.prepare("SELECT reference, updated_at FROM notebook_entries WHERE source_id = 501").get()).toEqual({ reference: "", updated_at: "2026-01-01" });
  });
});
