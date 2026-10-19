import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMP_PREFIX = "resume-life-series-id-route-test-";

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
  new Request("http://127.0.0.1/api/interviews/series/1", {
    method: "GET",
    headers: { origin: "http://127.0.0.1", host: "127.0.0.1" },
  });

const idContext = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

/** interview_series 与 resumes 是 JOIN 关系，必须先有简历 */
const seedSeries = (): number => {
  db?.prepare("INSERT INTO resumes (id, title, created_at, updated_at) VALUES (1, '测试简历', '', '')").run();
  const result = db?.prepare(
    "INSERT INTO interview_series (resume_id, jd, status, final_report, created_at) VALUES (1, ?, 'ongoing', ?, ?)"
  ).run("高级前端工程师", JSON.stringify({ overall: 8.5, verdict: "整体表现良好", strengths: "表达清晰", weaknesses: "细节不足", suggestions: "补充实例" }), "2026-01-01T00:00:00.000Z");
  const seriesId = Number(result?.lastInsertRowid);
  db?.prepare(
    "INSERT INTO interviews (resume_id, jd, series_id, round_no, style, status, created_at) VALUES (1, ?, ?, 1, 'deep', 'ongoing', '')"
  ).run("高级前端工程师", seriesId);
  return seriesId;
};

describe("GET/DELETE /api/interviews/series/[id] 进阶面试", () => {
  it("GET 返回系列详情、跨轮总评与按轮排序的轮次列表", async () => {
    const id = seedSeries();
    const route = await import("../route");
    const res = await route.GET(request(), idContext(id));
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      id: number;
      resume_title: string;
      status: string;
      rounds_total: number;
      final_report: { overall: number; verdict: string } | null;
      entries: { interview_id: number; round_no: number; style: string; answered: number; report: string | null }[];
    };
    expect(data.id).toBe(id);
    expect(data.resume_title).toBe("测试简历");
    expect(data.status).toBe("ongoing");
    expect(data.rounds_total).toBe(3);
    expect(data.final_report?.overall).toBe(8.5);
    expect(data.final_report?.verdict).toBe("整体表现良好");
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0]?.round_no).toBe(1);
    expect(data.entries[0]?.style).toBe("deep");
    expect(data.entries[0]?.answered).toBe(0);
    expect(data.entries[0]?.report).toBeNull();
  });

  it("GET 不存在的系列返回 404，非法 id 返回 400", async () => {
    const route = await import("../route");
    const missing = await route.GET(request(), idContext(999));
    expect(missing.status).toBe(404);
    const missingData = (await missing.json()) as { error: string };
    expect(missingData.error).toContain("进阶面试不存在");

    const invalid = await route.GET(request(), idContext(Number.NaN));
    expect(invalid.status).toBe(400);
    const invalidData = (await invalid.json()) as { error: string };
    expect(invalidData.error).toContain("无效的进阶面试 ID");
  });

  it("DELETE 删除系列并级联删除其面试轮", async () => {
    const id = seedSeries();
    const route = await import("../route");

    const res = await route.DELETE(request(), idContext(id));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);

    const series = db?.prepare("SELECT COUNT(*) AS n FROM interview_series").get() as { n: number } | undefined;
    const interviews = db?.prepare("SELECT COUNT(*) AS n FROM interviews WHERE series_id = ?").get(id) as
      | { n: number }
      | undefined;
    expect(series?.n).toBe(0);
    expect(interviews?.n).toBe(0);
  });

  it("DELETE 不存在的系列返回 404", async () => {
    const route = await import("../route");
    const res = await route.DELETE(request(), idContext(999));
    expect(res.status).toBe(404);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("进阶面试不存在");
  });
});
