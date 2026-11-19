import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readNotebookListPage, type NotebookEntry } from "@/lib/notebook-records";

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

function seed(count: number, source: NotebookEntry["source"] = "drill") {
  const statement = db.prepare(
    `INSERT INTO notebook_entries (source, source_id, question, created_at, updated_at)
     VALUES (?, ?, ?, '', '')`
  );
  for (let i = 1; i <= count; i += 1) {
    statement.run(source, source === "drill" ? i : 10_000 + i, `${source} 题目 ${i}`);
  }
}

type Entry = NotebookEntry;

async function listEntries(query: string): Promise<{ items: Entry[]; nextCursor: string | null }> {
  const route = await import("@/app/api/notebook/route");
  const response = await route.GET(new Request(`http://localhost/api/notebook?${query}`));
  expect(response.status, `${query} 应返回 200`).toBe(200);
  const params = new URLSearchParams(query);
  return readNotebookListPage(await response.json(), {
    category: params.has("category_id") ? Number(params.get("category_id")) : "all",
    source: (params.get("source") ?? "") as NotebookEntry["source"] | "",
    keyword: params.get("q") ?? "",
    cursor: params.get("cursor") ?? undefined,
  });
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

  it("三种来源、分类和未分类组合贯穿所有页，读取不改变快照或复习进度", async () => {
    db.prepare("INSERT INTO notebook_categories (id, name, created_at) VALUES (1, '分类 <T> &amp;', ''), (2, '另一分类', '')").run();
    for (const source of ["drill", "interview", "application_interview"] as const) seed(60, source);
    db.prepare("UPDATE notebook_entries SET category_id = CASE WHEN id % 3 = 0 THEN NULL WHEN id % 3 = 1 THEN 1 ELSE 2 END").run();
    db.prepare("UPDATE notebook_entries SET answer = '  原答内部  空格 <T> &amp;  ', comment = '原点评', reference = '原参考', scores = ?").run(JSON.stringify({ depth: "6.4", structure: 0, authenticity: 10, completeness: 7.6 }));
    db.prepare("INSERT INTO review_cards (notebook_id, next_review_date, created_at) SELECT id, '2026-10-29', '' FROM notebook_entries WHERE id % 2 = 0").run();
    const snapshot = () => ["notebook_entries", "review_cards", "notebook_categories"].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
    const before = snapshot();
    for (const source of ["drill", "interview", "application_interview"] as const) {
      for (const category of ["", "0", "1", "2"]) {
        const { items, pages } = await walkAll(new URLSearchParams({ source, q: "  原答内部  空格 <t> &AMP;  ", ...(category ? { category_id: category } : {}) }).toString(), 7);
        expect(items).toHaveLength(category ? 20 : 60); expect(pages).toBeGreaterThan(1);
        for (const item of items) {
          expect(item.source).toBe(source);
          if (category) expect(item.category_id).toBe(category === "0" ? null : Number(category));
          expect(item.answer).toBe("  原答内部  空格 <T> &amp;  ");
          expect(item.scores).toEqual({ depth: 6, structure: 0, authenticity: 10, completeness: 8 });
          expect(item.review_card_id === null).toBe(item.id % 2 !== 0);
          expect([item.review_mastery, item.next_review_date]).toEqual(item.id % 2 === 0 ? ["new", "2026-10-29"] : [null, null]);
        }
      }
    }
    expect(snapshot()).toEqual(before);
  });

  it.each([
    ["question", "C++ <T> &amp; 100%_path\\file", " c++ <t> &AMP; 100%_path\\file ", true],
    ["answer", "C++ <T> &amp; 100%_path\\file", "c++ <t> &AMP; 100%_path\\file", true],
    ["comment", "C++ <T> &amp; 100%_path\\file", "c++ <t> &AMP; 100%_path\\file", true],
    ["answer", "100XXpathZfile", "100%_path\\file", false],
    ["answer", "内部  空格", "内部 空格", false],
    ["answer", "École", "é", false], ["answer", "École", "É", true],
    ["answer", "abc\0hidden", "hidden", false],
    ["answer", "xABC\0hidden", "abc\0ignored", true],
    ["answer", "abc extra", "abc\0ignored", false],
    ["reference", "仅参考中出现", "仅参考中出现", false],
    ["source_label", "仅来源中出现", "仅来源中出现", false],
  ] as const)("真实 SQLite 搜索 %s / %j / %j 与目录协议一致", async (field, text, keyword, matches) => {
    seed(1);
    db.prepare(`UPDATE notebook_entries SET question = '', ${field} = ?`).run(text);
    const before = db.prepare("SELECT * FROM notebook_entries").all();
    const page = await listEntries(new URLSearchParams({ q: keyword }).toString());
    expect(page.items).toHaveLength(matches ? 1 : 0);
    if (matches) expect(page.items[0]![field]).toBe(text);
    expect(db.prepare("SELECT * FROM notebook_entries").all()).toEqual(before);
  });

  it("历史坏评分返回 null，原始长文本和空字段仍可读取", async () => {
    seed(2);
    const longQuestion = "  原题 <T> &amp;\n内部  空格 ".repeat(2000);
    db.prepare("UPDATE notebook_entries SET question = ?, scores = CASE WHEN id = 1 THEN 'bad json' ELSE '{}' END").run(longQuestion);
    const page = await listEntries("");
    expect(page.items).toHaveLength(2);
    for (const item of page.items) expect(item).toMatchObject({ question: longQuestion, answer: "", comment: "", reference: "", scores: null, review_card_id: null, review_mastery: null, next_review_date: null });
  });

  it.each(["", "abc", "-1", "1.5", "Infinity", "01", "1e0", "0x1", "+1", " 1", "9007199254740992"])("非法分类 %j 不能静默扩大为全部错题", async category_id => {
    seed(1);
    db.exec("INSERT INTO notebook_categories (id, name, created_at) VALUES (1, '筛选分类', '')");
    db.exec("UPDATE notebook_entries SET category_id = 1");
    const { GET } = await import("@/app/api/notebook/route");
    const response = await GET(new Request(`http://localhost/api/notebook?${new URLSearchParams({ category_id })}`));
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: "无效的分类筛选" });
  });

  it.each(["legacy", "Drill", " drill ", "0"])("非法来源 %j 不能静默扩大为全部错题", async source => {
    seed(1);
    const { GET } = await import("@/app/api/notebook/route");
    const response = await GET(new Request(`http://localhost/api/notebook?${new URLSearchParams({ source })}`));
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: "无效的来源筛选" });
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
