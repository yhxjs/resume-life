import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ResignationGapRemedyResult } from "@/lib/career-gap-remedy";

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
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "", "Infinity", "NaN", "abc"])("路径 ID %j 必须为正安全整数，GET/DELETE 都在写入前拒绝", async (id) => {
    seedRemedy("{}");
    const before = db?.prepare("SELECT * FROM resignation_gap_remedies ORDER BY id").all();
    const route = await import("../route");
    const get = await route.GET(request(), idContext(id));
    const deletion = await route.DELETE(request(), idContext(id));
    expect([get.status, deletion.status]).toEqual([400, 400]);
    expect(db?.prepare("SELECT * FROM resignation_gap_remedies ORDER BY id").all()).toEqual(before);
  });
  it("GET 返回记录并解析 result JSON", async () => {
    const script = { label: "原版话术", applicableScene: "初步沟通", script: "休整半年，没有开展项目；到岗安排待确认。", keyPoints: ["只说明真实情况"] };
    const saved: ResignationGapRemedyResult = {
      title: "休整经历说明", punchline: "保留事实与未知条件",
      hrMindsetAnalysis: { coreConcerns: [], riskPoints: [], whatHrWantsToHear: "可确认与岗位有关的时间安排" },
      reframeFormula: { factAcknowledgment: "休整半年", positiveAttribution: "个人选择", growthAndValue: "未开展项目", motivationAlignment: "真实岗位方向待补充" },
      scripts: { concise: script, detailed: script, pivoting: script }, drills: [], forbiddenList: [], closingTips: [],
    };
    const id = seedRemedy(JSON.stringify(saved));
    const route = await import("../route");
    const res = await route.GET(request(), idContext(id));
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      id: number;
      scenario_type: string;
      raw_story: string;
      target_role: string;
      result: ResignationGapRemedyResult | null;
    };
    expect(data.id).toBe(id);
    expect(data.scenario_type).toBe("both");
    expect(data.raw_story).toBe("裸辞半年想回大厂");
    expect(data.target_role).toBe("后端工程师");
    expect(data.result).toEqual(saved);
  });

  it.each(["不是JSON", JSON.stringify({ scripts: [{ scenario: "自我介绍", script: "这样讲" }] })])("GET 损坏结构 %s 返回 null，原始记录不变", async (stored) => {
    const id = seedRemedy(stored);
    const before = db?.prepare("SELECT * FROM resignation_gap_remedies WHERE id=?").get(id);
    const route = await import("../route");
    const res = await route.GET(request(), idContext(id));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { result: unknown };
    expect(data.result).toBeNull();
    expect(db?.prepare("SELECT * FROM resignation_gap_remedies WHERE id=?").get(id)).toEqual(before);
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
