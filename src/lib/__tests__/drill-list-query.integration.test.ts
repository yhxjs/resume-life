import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let directory: string;
let db: DatabaseSync;

beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-drill-list-query-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("@/lib/db")).getDb();
  db.exec(`INSERT INTO projects (id,name,created_at,updated_at) VALUES (1,'项目一','',''),(2,'项目二','','');
    INSERT INTO drills (id,source,project_id,created_at) VALUES (1,'project',1,''),(2,'project',2,''),(3,'bank',NULL,'');`);
});

afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  if (path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith("resume-life-drill-list-query-")) throw new Error("Unsafe cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("GET /api/drills project_id query", () => {
  it("preserves unfiltered and exact-filter behavior while rejecting invalid filters", async () => {
    const { GET } = await import("@/app/api/drills/route");
    const snapshot = () => ["projects", "drills", "drill_questions", "notebook_entries", "review_cards", "review_attempts", "llm_call_logs"]
      .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
    const before = snapshot();
    const all = await GET(new Request("http://localhost/api/drills?limit=50"));
    expect(all.status).toBe(200);
    expect((await all.json()).items.map((item: { id: number }) => item.id)).toEqual([3, 2, 1]);

    const filtered = await GET(new Request("http://localhost/api/drills?project_id=1&limit=50"));
    expect(filtered.status).toBe(200);
    expect((await filtered.json()).items.map((item: { id: number }) => item.id)).toEqual([1]);

    for (const value of ["", "0", "-1", "1.5", "bad", "1e0", "0x1", "+1", "01", " 1", "1\n", "1\t", "9007199254740992"]) {
      const response = await GET(new Request(`http://localhost/api/drills?project_id=${encodeURIComponent(value)}&limit=50`));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "无效的项目筛选" });
    }
    const missing = await GET(new Request(`http://localhost/api/drills?project_id=${Number.MAX_SAFE_INTEGER}`));
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({ items: [], nextCursor: null });
    expect(snapshot()).toEqual(before);
  });
});
