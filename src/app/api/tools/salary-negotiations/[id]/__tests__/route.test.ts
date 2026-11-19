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
  it("GET 保留详情和回合，旧空对象不补造模拟状态、评分或练习建议", async () => {
    const id = seedNegotiation();
    const route = await import("../route");
    const res = await route.GET(request(), idContext(id));
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      id: number;
      revision: string;
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
    expect(data.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(data.target_role).toBe("后端工程师");
    expect(data.status).toBe("ongoing");
    expect(data.initial_offer).toBe("年薪 32 万");
    expect(data.report).toBeNull();
    expect(data.turns).toHaveLength(1);
    expect(data.turns[0]?.turn_no).toBe(1);
    expect(data.turns[0]?.hr_response).toContain("32 万");
    expect(data.turns[0]?.hr_mindset).toEqual({ looseness: null, current_attitude: "", estimated_package: "", tactics_label: "", internal_pressure: "" });
    expect(data.turns[0]?.mentor_analysis).toEqual({ user_argument_score: null, strengths: [], vulnerabilities: [], tactical_tips: "", suggested_replies: [] });
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

  it.each(["abc", "0", "-1", "1.5", "9007199254740992"])("GET/DELETE 无效 ID %s 在查询前拒绝且不改变存档", async (invalid) => {
    seedNegotiation();
    const before = db!.prepare("SELECT * FROM salary_negotiations").all();
    const route = await import("../route");
    expect((await route.GET(request(), idContext(invalid))).status).toBe(400);
    expect((await route.DELETE(new Request(request(), { method: "DELETE" }), idContext(invalid))).status).toBe(400);
    expect(db!.prepare("SELECT * FROM salary_negotiations").all()).toEqual(before);
  });

  it.each(["{", "[]", "null", '{"suggested_replies":[null]}'])("损坏的军师存档 %s 返回422，不伪造评分或改写数据库", async (invalid) => {
    const id = seedNegotiation();
    db!.prepare("UPDATE salary_negotiation_turns SET mentor_analysis=?").run(invalid);
    const before = db!.prepare("SELECT * FROM salary_negotiation_turns").all();
    const route = await import("../route");
    const response = await route.GET(request(), idContext(id));
    expect(response.status).toBe(422);
    expect((await response.json()).error).toContain("原始存档未修改");
    expect(db!.prepare("SELECT * FROM salary_negotiation_turns").all()).toEqual(before);
    db!.prepare("UPDATE salary_negotiation_turns SET mentor_analysis='{}'").run();
    expect((await route.GET(request(), idContext(id))).status).toBe(200);
  });

  it("历史长条件、所有建议和小数评分完整回读，读取零写入", async () => {
    const id = seedNegotiation();
    const long = " 原始条件 <T> &amp;\n" + "此前提供的条件。".repeat(100) + "需审批，尚未书面确认。 ";
    const mindset = { looseness: 20.5, current_attitude: long, estimated_package: long, tactics_label: long, internal_pressure: long };
    const mentor = { user_argument_score: 7.5, strengths: Array(6).fill(long), vulnerabilities: [], tactical_tips: long,
      suggested_replies: Array.from({ length: 4 }, (_, index) => ({ title: `${index}${long}`, content: long, rationale: long })) };
    const report = { final_package_summary: long, score: 70.5, persuasion_grade: "A", leverage_efficiency: "", mentor_summary: long,
      turn_critiques: [{ turn_no: 1, gain_or_loss: "neutral", summary: long, key_point: long }], real_world_tips: Array(7).fill(long) };
    db!.prepare("UPDATE salary_negotiation_turns SET hr_mindset=?,mentor_analysis=?").run(JSON.stringify(mindset), JSON.stringify(mentor));
    db!.prepare("UPDATE salary_negotiations SET status='finished',report=?").run(JSON.stringify(report));
    const before = [db!.prepare("SELECT * FROM salary_negotiations").all(), db!.prepare("SELECT * FROM salary_negotiation_turns").all()];
    const { GET } = await import("../route");
    const response = await GET(request(), idContext(id));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.turns[0].hr_mindset).toEqual(mindset);
    expect(data.turns[0].mentor_analysis).toEqual(mentor);
    expect(data.report).toEqual(report);
    expect([db!.prepare("SELECT * FROM salary_negotiations").all(), db!.prepare("SELECT * FROM salary_negotiation_turns").all()]).toEqual(before);
  });
});
