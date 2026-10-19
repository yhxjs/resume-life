import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tempDir: string;
let db: DatabaseSync;

beforeEach(async () => {
  vi.resetModules();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-notebook-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", path.join(tempDir, "data"));
  db = (await import("@/lib/db")).getDb();
});

afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  if (path.dirname(tempDir) !== os.tmpdir() || !path.basename(tempDir).startsWith("resume-life-notebook-")) {
    throw new Error("Unsafe cleanup path");
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function seed(count: number, source: "drill" | "interview" = "drill") {
  const statement = db.prepare(
    `INSERT INTO notebook_entries (source, source_id, question, created_at, updated_at)
     VALUES (?, ?, ?, '', '')`
  );
  for (let i = 1; i <= count; i += 1) {
    statement.run(source, source === "drill" ? i : 10_000 + i, `${source} 题目 ${i}`);
  }
}

type Entry = { id: number; question: string };

async function listEntries(query: string): Promise<{ items: Entry[]; nextCursor: string | null }> {
  const route = await import("@/app/api/notebook/route");
  const response = await route.GET(new Request(`http://localhost/api/notebook?${query}`));
  expect(response.status, `${query} 应返回 200`).toBe(200);
  return (await response.json()) as { items: Entry[]; nextCursor: string | null };
}

async function walkAll(query: string, limit = 50): Promise<{ items: Entry[]; pages: number }> {
  const items: Entry[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 60; page += 1) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor !== null) params.set("cursor", cursor);
    const extra = new URLSearchParams(query);
    for (const [key, value] of extra) params.set(key, value);
    const result = await listEntries(params.toString());
    items.push(...result.items);
    cursor = result.nextCursor;
    if (cursor === null) return { items, pages: page + 1 };
  }
  throw new Error("分页未在 60 页内结束，游标可能没有推进");
}

describe("错题本游标分页", () => {
  it("翻页不重复、不丢项且 id 严格递减", async () => {
    seed(120);
    const { items, pages } = await walkAll("");
    expect(pages).toBeGreaterThan(1);
    expect(items).toHaveLength(120);

    const ids = items.map((entry) => entry.id);
    expect(new Set(ids).size, "翻页过程中出现了重复条目").toBe(120);
    for (let i = 1; i < ids.length; i += 1) {
      expect(ids[i]!).toBeLessThan(ids[i - 1]!);
    }
    expect(new Set(items.map((entry) => entry.question)).size).toBe(120);
  });

  it("游标与筛选条件组合时仍然一致", async () => {
    seed(120, "drill");
    seed(30, "interview");

    const drill = await walkAll("source=drill");
    expect(drill.items).toHaveLength(120);
    expect(drill.items.every((entry) => entry.question.startsWith("drill"))).toBe(true);

    const interview = await walkAll("source=interview");
    expect(interview.items).toHaveLength(30);
    expect(interview.items.every((entry) => entry.question.startsWith("interview"))).toBe(true);

    const searched = await walkAll("q=题目 12");
    expect(searched.items.length).toBeGreaterThan(0);
    expect(searched.items.every((entry) => entry.question.includes("题目 12"))).toBe(true);
  });

  it("最后一页返回 nextCursor 为 null", async () => {
    seed(10);
    const first = await listEntries("limit=50");
    expect(first.items).toHaveLength(10);
    expect(first.nextCursor).toBeNull();
  });

  it("非法分页参数被拒绝", async () => {
    for (const query of ["limit=0", "limit=1000", "limit=abc", "cursor=-1", "cursor=abc"]) {
      const route = await import("@/app/api/notebook/route");
      const response = await route.GET(new Request(`http://localhost/api/notebook?${query}`));
      expect(response.status, `${query} 应被拒绝`).toBe(400);
      expect((await response.json()).error).toBe("分页参数无效");
    }
  });
});
