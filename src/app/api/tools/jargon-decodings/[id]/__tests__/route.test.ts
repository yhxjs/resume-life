import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JargonDecoderResult } from "@/lib/jargon-decoder";

const TEMP_PREFIX = "resume-life-jargon-id-route-test-";

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
  new Request("http://127.0.0.1/api/tools/jargon-decodings/1", {
    method: "GET",
    headers: { origin: "http://127.0.0.1", host: "127.0.0.1" },
  });

const idContext = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

const seedDecoding = (result: string): number => {
  const row = db?.prepare("INSERT INTO jargon_decodings (source_text, result, created_at) VALUES (?, ?, ?)")
    .run("我们这边弹性工作制，是大力出奇迹的文化", result, "2026-01-01T00:00:00.000Z");
  return Number(row?.lastInsertRowid);
};

describe("GET/DELETE /api/tools/jargon-decodings/[id] 黑话解码记录", () => {
  it("GET 返回记录并解析 result JSON", async () => {
    const saved: JargonDecoderResult = {
      targetSummary: "工作安排说明", punchline: "需要核实实际条件", overallRiskScore: null,
      riskRatings: { overtime: null, stability: null, resources: null, management: null },
      items: [{ keyword: "弹性工作制", surfaceMeaning: "可能允许灵活安排时间", hiddenMeaning: "没有说明实际工时和补偿",
        riskLevel: null, riskCategory: "时间条件", warning: "若需要持续在线，可能影响休息", interviewRule: "先核实再表达真实诉求",
        counterQuestions: ["核心协作时段和响应边界如何约定？"] }],
      companyProfile: { teamStyle: "信息不足", riskFlags: [], cultureSummary: "不能只据文本推断公司现状" },
      goldenQuestions: ["最近一次紧急响应如何安排？"],
    };
    const id = seedDecoding(JSON.stringify(saved));
    const route = await import("../route");
    const res = await route.GET(request(), idContext(id));
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      id: number;
      source_text: string;
      result: JargonDecoderResult | null;
    };
    expect(data.id).toBe(id);
    expect(data.source_text).toContain("弹性工作制");
    expect(data.result).toEqual(saved);
  });

  it.each(["不是JSON", JSON.stringify({ items: [{ term: "弹性工作制", meaning: "未经证实的推断" }] })])("GET 损坏结构 %s 返回 null，原始记录不变", async (stored) => {
    const id = seedDecoding(stored);
    const before = db?.prepare("SELECT * FROM jargon_decodings WHERE id=?").get(id);
    const route = await import("../route");
    const res = await route.GET(request(), idContext(id));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { result: unknown };
    expect(data.result).toBeNull();
    expect(db?.prepare("SELECT * FROM jargon_decodings WHERE id=?").get(id)).toEqual(before);
  });

  it("GET 不存在的记录返回 404，非法 id 返回 400", async () => {
    const route = await import("../route");
    const missing = await route.GET(request(), idContext(999));
    expect(missing.status).toBe(404);
    const missingData = (await missing.json()) as { error: string };
    expect(missingData.error).toContain("记录不存在");

    const invalid = await route.GET(request(), idContext("abc"));
    expect(invalid.status).toBe(400);
    const invalidData = (await invalid.json()) as { error: string };
    expect(invalidData.error).toContain("无效的记录 ID");
  });

  it("DELETE 删除记录，再删一次返回 404", async () => {
    const id = seedDecoding("{}");
    const route = await import("../route");
    const first = await route.DELETE(request(), idContext(id));
    expect(first.status).toBe(200);
    expect(((await first.json()) as { ok: boolean }).ok).toBe(true);

    const second = await route.DELETE(request(), idContext(id));
    expect(second.status).toBe(404);
    const data = (await second.json()) as { error: string };
    expect(data.error).toContain("记录不存在");
  });
});
