import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMP_PREFIX = "resume-life-gap-remedies-id-route-test-";

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
  new Request("http://127.0.0.1/api/tools/career-gap-remedies/1", {
    method: "GET",
    headers: { origin: "http://127.0.0.1", host: "127.0.0.1" },
  });

const idContext = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

const seedRemedy = (result: string): number => {
  const insert = db?.prepare(
    `INSERT INTO resignation_gap_remedies (scenario_type, raw_story, target_role, persona_style, result, created_at)
     VALUES ('both', ?, ?, 'pragmatic', ?, ?)`
  );
  const row = insert?.run("裸辞半年想回大厂", "后端工程师", result, "2026-01-01T00:00:00.000Z");
  return Number(row?.lastInsertRowid);
};

describe("GET/DELETE /api/tools/career-gap-remedies/[id] 空窗补救方案", () => {
  it("GET 返回记录并解析 result JSON", async () => {
    const id = seedRemedy(JSON.stringify({ scripts: [{ scenario: "自我介绍", script: "这样讲" }] }));
    const route = await import("../route");
    const res = await route.GET(request(), idContext(id));
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      id: number;
      scenario_type: string;
      raw_story: string;
      target_role: string;
      result: { scripts: { scenario: string; script: string }[] } | null;
    };
    expect(data.id).toBe(id);
    expect(data.scenario_type).toBe("both");
    expect(data.raw_story).toBe("裸辞半年想回大厂");
    expect(data.target_role).toBe("后端工程师");
    expect(data.result?.scripts[0]?.scenario).toBe("自我介绍");
  });

  it("GET result JSON 损坏时 result 为 null 而不是 500", async () => {
    const id = seedRemedy("不是JSON");
    const route = await import("../route");
    const res = await route.GET(request(), idContext(id));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { result: unknown };
    expect(data.result).toBeNull();
  });

  it("GET 不存在的记录返回 404，非法 id 返回 400", async () => {
    const route = await import("../route");
    const missing = await route.GET(request(), idContext(999));
    expect(missing.status).toBe(404);
    const missingData = (await missing.json()) as { error: string };
    expect(missingData.error).toContain("Record not found");

    const invalid = await route.GET(request(), idContext("abc"));
    expect(invalid.status).toBe(400);
    const invalidData = (await invalid.json()) as { error: string };
    expect(invalidData.error).toContain("Invalid id");
  });

  it("DELETE 删除记录", async () => {
    const id = seedRemedy("{}");
    const route = await import("../route");
    const res = await route.DELETE(request(), idContext(id));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    const rows = db?.prepare("SELECT COUNT(*) AS n FROM resignation_gap_remedies").get() as { n: number } | undefined;
    expect(rows?.n).toBe(0);
  });
});
