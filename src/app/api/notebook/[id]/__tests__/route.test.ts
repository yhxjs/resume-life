import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMP_PREFIX = "resume-life-notebook-id-route-test-";

let tempDir: string;
let db: DatabaseSync | undefined;

beforeEach(async () => {
  vi.resetModules();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), TEMP_PREFIX));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", path.join(tempDir, "data"));
  db = (await import("@/lib/db")).getDb();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  // Windows 上删除仍被 SQLite 持有的文件会 EPERM，必须先关句柄
  db?.close();
  db = undefined;
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

const request = (method: string, body?: unknown) =>
  new Request("http://127.0.0.1/api/notebook/1", {
    method,
    headers: { "content-type": "application/json", origin: "http://127.0.0.1", host: "127.0.0.1" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const idContext = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

const seedEntry = (sourceId = 1): number => {
  const result = db?.prepare(
    `INSERT INTO notebook_entries (source, source_id, question, answer, created_at, updated_at)
     VALUES ('drill', ?, ?, '答案', ?, ?)`
  ).run(sourceId, "什么是闭包", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  return Number(result?.lastInsertRowid);
};

const seedCategory = (): number => {
  const result = db?.prepare("INSERT INTO notebook_categories (name, created_at) VALUES (?, ?)")
    .run("八股文", "2026-01-01T00:00:00.000Z");
  return Number(result?.lastInsertRowid);
};

describe("GET/PATCH/DELETE /api/notebook/[id] 错题详情", () => {
  it("GET 返回错题详情", async () => {
    const id = seedEntry();
    const route = await import("../route");
    const res = await route.GET(request("GET"), idContext(id));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const data = (await res.json()) as { id: number; question: string; answer: string };
    expect(data.id).toBe(id);
    expect(data.question).toBe("什么是闭包");
  });

  it.each(["abc", "0", "-1", "1.5", "9007199254740992", "Infinity", ""])("非法 id %s 的读写均返回 400，不触及快照与分类", async invalidId => {
    const id = seedEntry(); const categoryId = seedCategory();
    const route = await import("../route");
    const before = db!.prepare("SELECT * FROM notebook_entries").all();
    for (const response of [await route.GET(request("GET"), idContext(invalidId)), await route.PATCH(request("PATCH", { category_id: categoryId }), idContext(invalidId)), await route.DELETE(request("DELETE"), idContext(invalidId))]) {
      expect(response.status).toBe(400); expect((await response.json()).error).toContain("无效的错题 ID");
    }
    expect(db!.prepare("SELECT * FROM notebook_entries").all()).toEqual(before); expect(id).toBeGreaterThan(0);
  });

  it("PATCH 设置分类后可再传 null 清空", async () => {
    const id = seedEntry();
    const categoryId = seedCategory();
    const route = await import("../route");

    const set = await route.PATCH(request("PATCH", { category_id: categoryId }), idContext(id));
    expect(set.status).toBe(200);
    const afterSet = db?.prepare("SELECT category_id FROM notebook_entries WHERE id = ?").get(id) as
      | { category_id: number }
      | undefined;
    expect(afterSet?.category_id).toBe(categoryId);
    expect(await (await route.GET(request("GET"), idContext(id))).json()).toMatchObject({ id, category_id: categoryId });

    const cleared = await route.PATCH(request("PATCH", { category_id: null }), idContext(id));
    expect(cleared.status).toBe(200);
    const afterClear = db?.prepare("SELECT category_id FROM notebook_entries WHERE id = ?").get(id) as
      | { category_id: number | null }
      | undefined;
    expect(afterClear?.category_id).toBeNull();
    expect(await (await route.GET(request("GET"), idContext(id))).json()).toMatchObject({ id, category_id: null });
  });

  it("PATCH 指向不存在的分类返回 400", async () => {
    const id = seedEntry();
    const route = await import("../route");
    const res = await route.PATCH(request("PATCH", { category_id: 9999 }), idContext(id));
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("分类不存在");
  });

  it("PATCH 非对象或缺少显式分类字段时返回 400 且不修改分类和时间", async () => {
    const id = seedEntry();
    const categoryId = seedCategory();
    const route = await import("../route");
    expect((await route.PATCH(request("PATCH", { category_id: categoryId }), idContext(id))).status).toBe(200);
    const before = db?.prepare("SELECT category_id, updated_at FROM notebook_entries WHERE id = ?").get(id) as
      | { category_id: number; updated_at: string }
      | undefined;
    expect(before).toBeDefined();

    for (const body of [null, [], {}, "invalid", true, { category_id: true }]) {
      const res = await route.PATCH(request("PATCH", body), idContext(id));
      expect(res.status).toBe(400);
      const after = db?.prepare("SELECT category_id, updated_at FROM notebook_entries WHERE id = ?").get(id) as
        | { category_id: number; updated_at: string }
        | undefined;
      expect(after).toEqual(before);
    }
  });

  it("PATCH 不存在的错题返回 404", async () => {
    seedCategory();
    const route = await import("../route");
    const res = await route.PATCH(request("PATCH", { category_id: 1 }), idContext(999));
    expect(res.status).toBe(404);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("错题不存在");
  });

  it("DELETE 删除错题，再删一次返回 404", async () => {
    const id = seedEntry();
    const route = await import("../route");
    const first = await route.DELETE(request("DELETE"), idContext(id));
    expect(first.status).toBe(200);
    expect(((await first.json()) as { ok: boolean }).ok).toBe(true);

    const second = await route.DELETE(request("DELETE"), idContext(id));
    expect(second.status).toBe(404);
    const data = (await second.json()) as { error: string };
    expect(data.error).toContain("错题不存在");
  });

  it.each(["drill", "interview", "application_interview"])("来源 %s 已删除仍可逐字读取独立快照，移出后只读核对为 404", async source => {
    const id = seedEntry(); const question = "  唯一副本 <T> &amp;\n内部  空格".repeat(2000);
    db!.prepare("UPDATE notebook_entries SET source = ?, question = ?, reference = ? WHERE id = ?").run(source, question, question, id);
    const before = db!.prepare("SELECT * FROM notebook_entries").all(); const route = await import("../route");
    const response = await route.GET(request("GET"), idContext(id)); expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id, question, answer: "答案", comment: "", reference: question, category_id: null }); expect(db!.prepare("SELECT * FROM notebook_entries").all()).toEqual(before);
    expect((await route.DELETE(request("DELETE"), idContext(id))).status).toBe(200);
    const absent = await route.GET(request("GET"), idContext(id)); expect(absent.status).toBe(404); expect(absent.headers.get("cache-control")).toBe("no-store");
  });
});

async function seedRemovalGraph() {
  const id = seedEntry(); const otherId = seedEntry(2);
  db!.exec("INSERT INTO drills (id,source,created_at) VALUES (1,'bank',''); INSERT INTO drill_questions (id,drill_id,idx,question,answer,comment,reference) VALUES (1,1,0,'原题','来源原答','来源点评','来源参考')");
  const categoryId = seedCategory(); db!.prepare("UPDATE notebook_entries SET category_id = ?").run(categoryId);
  const card = Number(db!.prepare("INSERT INTO review_cards (notebook_id,next_review_date,created_at) VALUES (?,'2026-10-29','')").run(id).lastInsertRowid);
  const { saveReview } = await import("@/lib/spaced-repetition-cards"); saveReview(card, { answer: "本次回忆", grade: "good", expected_review_count: 0, request_id: "notebook-remove-test" });
  const applicationId = Number(db!.prepare("INSERT INTO applications (company,role,stage,created_at,updated_at) VALUES ('公司','岗位','interested','','')").run().lastInsertRowid);
  db!.prepare("INSERT INTO application_preparation_resources (application_id,notebook_id) VALUES (?,?)").run(applicationId, id);
  return { id, otherId, card, applicationId, categoryId };
}

describe("错题移出事务与级联范围", () => {
  const tables = ["notebook_entries", "review_cards", "review_attempts", "application_preparation_resources", "applications", "drills", "drill_questions", "notebook_categories"];
  const contents = () => Object.fromEntries(tables.map(table => [table, db!.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));

  it("清理收藏复习历史和准备关联，保留来源、其他收藏、分类及投递", async () => {
    const { id, otherId, applicationId, categoryId } = await seedRemovalGraph(); const before = contents(); const route = await import("../route");
    expect((await route.DELETE(request("DELETE"), idContext(id))).status).toBe(200); const after = contents();
    for (const table of ["review_cards", "review_attempts", "application_preparation_resources"]) expect(after[table]).toEqual([]);
    expect(after.notebook_entries).toEqual(before.notebook_entries!.filter(row => row.id === otherId));
    for (const table of ["applications", "drills", "drill_questions", "notebook_categories"]) expect(after[table]).toEqual(before[table]);
    const categories = await (await import("@/app/api/notebook/categories/route")).GET(new Request("http://127.0.0.1/api/notebook/categories"));
    expect(await categories.json()).toEqual([expect.objectContaining({ id: categoryId, entry_count: 1 })]); expect(applicationId).toBeGreaterThan(0);
  });

  it("级联中途失败时快照、复习历史及准备关联全部回滚", async () => {
    const { id } = await seedRemovalGraph(); const before = contents();
    db!.exec("CREATE TRIGGER block_review_attempt_remove BEFORE DELETE ON review_attempts BEGIN SELECT RAISE(ABORT,'synthetic cascade failure'); END");
    const route = await import("../route"); expect((await route.DELETE(request("DELETE"), idContext(id))).status).toBe(500); expect(contents()).toEqual(before);
  });
});
