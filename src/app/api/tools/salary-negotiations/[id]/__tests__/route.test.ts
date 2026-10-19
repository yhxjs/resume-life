import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMP_PREFIX = "resume-life-salary-neg-id-route-test-";

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
  new Request("http://127.0.0.1/api/tools/salary-negotiations/1", {
    method: "GET",
    headers: { origin: "http://127.0.0.1", host: "127.0.0.1" },
  });

const idContext = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

const seedNegotiation = (): number => {
  const row = db?.prepare(
    `INSERT INTO salary_negotiations
       (target_company_tier, target_role, expected_salary, hr_style, status, initial_offer, created_at)
     VALUES ('大厂', '后端工程师', '年薪 40 万', 'standard', 'ongoing', '年薪 32 万', ?)`
  ).run("2026-01-01T00:00:00.000Z");
  const id = Number(row?.lastInsertRowid);
  db?.prepare(
    `INSERT INTO salary_negotiation_turns
       (negotiation_id, turn_no, user_message, hr_response, hr_tactics, hr_mindset, mentor_analysis, created_at)
     VALUES (?, 1, '期望年薪 40 万', '预算有限，给到 32 万', '压价', '{}', '{}', ?)`
  ).run(id, "2026-01-01T00:00:00.000Z");
  return id;
};

describe("GET/DELETE /api/tools/salary-negotiations/[id] 谈判演练详情", () => {
  it("GET 返回详情、回合计数与规范化后的心理/建议字段", async () => {
    const id = seedNegotiation();
    const route = await import("../route");
    const res = await route.GET(request(), idContext(id));
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      id: number;
      target_role: string;
      status: string;
      initial_offer: string;
      report: unknown;
      turns: {
        turn_no: number;
        user_message: string;
        hr_response: string;
        hr_mindset: { looseness: number; current_attitude: string } | null;
        mentor_analysis: { user_argument_score: number } | null;
      }[];
    };
    expect(data.id).toBe(id);
    expect(data.target_role).toBe("后端工程师");
    expect(data.status).toBe("ongoing");
    expect(data.initial_offer).toBe("年薪 32 万");
    expect(data.report).toBeNull();
    expect(data.turns).toHaveLength(1);
    expect(data.turns[0]?.turn_no).toBe(1);
    expect(data.turns[0]?.hr_response).toContain("32 万");
    // 空对象入库的 hr_mindset 会被规范化为默认心理画像
    expect(data.turns[0]?.hr_mindset?.looseness).toBe(15);
    expect(data.turns[0]?.mentor_analysis?.user_argument_score).toBeGreaterThan(0);
  });

  it("GET 不存在的演练返回 404，非法 id 返回 400", async () => {
    const route = await import("../route");
    const missing = await route.GET(request(), idContext(999));
    expect(missing.status).toBe(404);
    const missingData = (await missing.json()) as { error: string };
    expect(missingData.error).toContain("谈判演练记录不存在");

    const invalid = await route.GET(request(), idContext("abc"));
    expect(invalid.status).toBe(400);
    const invalidData = (await invalid.json()) as { error: string };
    expect(invalidData.error).toContain("无效的演练 ID");
  });

  it("DELETE 删除演练并级联删除回合", async () => {
    const id = seedNegotiation();
    const route = await import("../route");
    const res = await route.DELETE(request(), idContext(id));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    const negs = db?.prepare("SELECT COUNT(*) AS n FROM salary_negotiations").get() as { n: number } | undefined;
    const turns = db?.prepare("SELECT COUNT(*) AS n FROM salary_negotiation_turns").get() as { n: number } | undefined;
    expect(negs?.n).toBe(0);
    expect(turns?.n).toBe(0);
  });

  it("DELETE id 为 0 或负数返回 400", async () => {
    const route = await import("../route");
    const zero = await route.DELETE(request(), idContext(0));
    expect(zero.status).toBe(400);
    const data = (await zero.json()) as { error: string };
    expect(data.error).toContain("无效的演练 ID");
  });
});
