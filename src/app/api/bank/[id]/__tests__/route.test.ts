import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMP_PREFIX = "resume-life-bank-id-route-test-";

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

const request = () =>
  new Request("http://127.0.0.1/api/bank/1", {
    method: "DELETE",
    headers: { origin: "http://127.0.0.1", host: "127.0.0.1" },
  });

const idContext = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

const seedEntry = (): number => {
  const result = db?.prepare(
    "INSERT INTO bank_entries (direction, kind, question, created_at) VALUES (?, 'tech', ?, ?)"
  ).run("前端", "什么是闭包", "2026-01-01T00:00:00.000Z");
  return Number(result?.lastInsertRowid);
};

describe("DELETE /api/bank/[id] 题库条目删除", () => {
  it("删除存在的题目返回 ok，且库里不再有该行", async () => {
    const id = seedEntry();
    const route = await import("../route");
    const res = await route.DELETE(request(), idContext(id));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean };
    expect(data.ok).toBe(true);
    const rows = db?.prepare("SELECT COUNT(*) AS n FROM bank_entries").get() as { n: number } | undefined;
    expect(rows?.n).toBe(0);
    expect((await route.GET(new Request("http://127.0.0.1/api/bank/1"), idContext(id))).status).toBe(404);
  });

  it("删除不存在的题目返回 404", async () => {
    const route = await import("../route");
    const res = await route.DELETE(request(), idContext(999));
    expect(res.status).toBe(404);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("题目不存在");
  });

  it.each(["NaN", "0", "-1", "1.5", "9007199254740992", "Infinity", ""])("非法 id %s 的读写均返回 400，不触及其他题目", async id => {
    const savedId = seedEntry();
    const route = await import("../route");
    for (const method of [route.GET, route.DELETE]) {
      const res = await method(request(), idContext(id));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("无效的题目 ID");
    }
    expect(db!.prepare("SELECT id FROM bank_entries").all()).toEqual([{ id: savedId }]);
  });

  it("只读详情逐字返回历史长题目，不改写另一题", async () => {
    const id = seedEntry(); const otherId = seedEntry();
    const question = "  C++ / C# <T> &amp;\n内部  空格".repeat(1000);
    db!.prepare("UPDATE bank_entries SET question = ?, direction = '' WHERE id = ?").run(question, id);
    const before = db!.prepare("SELECT * FROM bank_entries ORDER BY id").all();
    const route = await import("../route");
    const response = await route.GET(new Request(`http://127.0.0.1/api/bank/${id}`), idContext(id));
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ id, direction: "", kind: "tech", question, created_at: "2026-01-01T00:00:00.000Z" });
    expect(db!.prepare("SELECT * FROM bank_entries ORDER BY id").all()).toEqual(before);
    expect((await route.GET(new Request("http://127.0.0.1/api/bank/999"), idContext(999))).status).toBe(404);
    expect(otherId).not.toBe(id);
  });

  it("题目删除失败时标题清理与删除一并回滚，另一题与计量不变", async () => {
    const id = seedEntry(); const otherId = seedEntry();
    db!.prepare("INSERT INTO llm_call_logs (created_at,feature,entity_type,entity_id,entity_label,task,model,api_format,status,input_tokens) VALUES ('','test','bank_entry',?,'原题标题','evaluate','test','openai_chat','ok',12)").run(id);
    db!.exec(`CREATE TRIGGER block_bank_delete BEFORE DELETE ON bank_entries WHEN old.id = ${id} BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`);
    const route = await import("../route");
    expect((await route.DELETE(request(), idContext(id))).status).toBe(500);
    expect(db!.prepare("SELECT id FROM bank_entries ORDER BY id").all()).toEqual([{ id }, { id: otherId }]);
    expect(db!.prepare("SELECT entity_label,input_tokens FROM llm_call_logs WHERE entity_type = 'bank_entry' AND entity_id = ?").get(id)).toEqual({ entity_label: "原题标题", input_tokens: 12 });
    db!.exec("DROP TRIGGER block_bank_delete");
    expect((await route.DELETE(request(), idContext(id))).status).toBe(200);
    expect(db!.prepare("SELECT entity_label,input_tokens FROM llm_call_logs WHERE entity_type = 'bank_entry' AND entity_id = ?").get(id)).toEqual({ entity_label: "", input_tokens: 12 });
    expect(db!.prepare("SELECT id FROM bank_entries").all()).toEqual([{ id: otherId }]);
  });
});
