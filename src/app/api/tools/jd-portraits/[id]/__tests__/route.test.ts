import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JdPortraitResult } from "@/lib/jd-portrait";

const TEMP_PREFIX = "resume-life-jd-portraits-id-route-test-";

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
  new Request("http://127.0.0.1/api/tools/jd-portraits/1", {
    method: "GET",
    headers: { origin: "http://127.0.0.1", host: "127.0.0.1" },
  });

const idContext = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

const seedPortrait = (result: string): number => {
  const row = db?.prepare("INSERT INTO jd_portraits (jd, result, created_at) VALUES (?, ?, ?)")
    .run("负责数据可视化平台的前端开发，要求熟悉 React 与 ECharts", result, "2026-01-01T00:00:00.000Z");
  return Number(row?.lastInsertRowid);
};

describe("GET/DELETE /api/tools/jd-portraits/[id] JD 考点画像", () => {
  it("GET 返回记录并解析 result JSON", async () => {
    const saved: JdPortraitResult = {
      role: "可视化平台前端开发", mustSkills: [{ name: "React", weight: 8, why: "JD 要求维护平台，规模尚未说明" }],
      followups: [{ topic: "渲染性能", questions: ["如果出现渲染延迟，你会如何定位？"] }],
      companyStyle: { style: "协作方式信息不足", signals: ["维护数据可视化平台"] },
    };
    const id = seedPortrait(JSON.stringify(saved));
    const route = await import("../route");
    const res = await route.GET(request(), idContext(id));
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      id: number;
      jd: string;
      result: JdPortraitResult | null;
    };
    expect(data.id).toBe(id);
    expect(data.jd).toContain("数据可视化");
    expect(data.result).toEqual(saved);
  });

  it.each(["不是JSON", JSON.stringify({ mustSkills: ["React", "ECharts"], followUps: ["渲染性能"] })])("GET 损坏结构 %s 返回 null，原始记录不变", async (stored) => {
    const id = seedPortrait(stored);
    const before = db?.prepare("SELECT * FROM jd_portraits WHERE id=?").get(id);
    const route = await import("../route");
    const res = await route.GET(request(), idContext(id));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { result: unknown };
    expect(data.result).toBeNull();
    expect(db?.prepare("SELECT * FROM jd_portraits WHERE id=?").get(id)).toEqual(before);
  });

  it("GET 不存在的记录返回 404，非法 id 返回 400", async () => {
    const route = await import("../route");
    const missing = await route.GET(request(), idContext(999));
    expect(missing.status).toBe(404);
    const missingData = (await missing.json()) as { error: string };
    expect(missingData.error).toContain("记录不存在");

    const invalid = await route.GET(request(), idContext(Number.NaN));
    expect(invalid.status).toBe(400);
    const invalidData = (await invalid.json()) as { error: string };
    expect(invalidData.error).toContain("无效的记录 ID");
  });

  it("DELETE 删除记录", async () => {
    const id = seedPortrait("{}");
    const route = await import("../route");
    const res = await route.DELETE(request(), idContext(id));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
    const rows = db?.prepare("SELECT COUNT(*) AS n FROM jd_portraits").get() as { n: number } | undefined;
    expect(rows?.n).toBe(0);
  });
});
