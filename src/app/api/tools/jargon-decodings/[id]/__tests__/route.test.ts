import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
    const id = seedDecoding(JSON.stringify({ items: [{ term: "弹性工作制", meaning: "加班没有加班费" }] }));
    const route = await import("../route");
    const res = await route.GET(request(), idContext(id));
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      id: number;
      source_text: string;
      result: { items: { term: string; meaning: string }[] } | null;
    };
    expect(data.id).toBe(id);
    expect(data.source_text).toContain("弹性工作制");
    expect(data.result?.items[0]?.term).toBe("弹性工作制");
  });

  it("GET result JSON 损坏时 result 为 null 而不是 500", async () => {
    const id = seedDecoding("不是JSON");
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
