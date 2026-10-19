import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tempDir: string;
let db: DatabaseSync;

beforeEach(async () => {
  vi.resetModules();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-interviews-list-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", path.join(tempDir, "data"));
  db = (await import("@/lib/db")).getDb();
  db.exec("INSERT INTO resumes (id, title, created_at, updated_at) VALUES (1, '测试简历', '', '')");
  const addSingle = db.prepare("INSERT INTO interviews (resume_id, jd, created_at) VALUES (1, ?, '2026-09-24')");
  const addSeries = db.prepare("INSERT INTO interview_series (resume_id, jd, created_at) VALUES (1, ?, '2026-09-24')");
  for (let index = 1; index <= 51; index += 1) {
    addSingle.run(index === 1 ? "关键岗位" : `单轮 ${index}`);
    addSeries.run(index === 1 ? "关键岗位" : `进阶 ${index}`);
  }
});

afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (path.dirname(tempDir) !== os.tmpdir() || !path.basename(tempDir).startsWith("resume-life-interviews-list-")) {
    throw new Error("Unsafe cleanup path");
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe.each([
  ["/api/interviews", "@/app/api/interviews/route"],
  ["/api/interviews/series", "@/app/api/interviews/series/route"],
])("%s 游标分页", (endpoint, modulePath) => {
  async function get(query = "") {
    const route = modulePath === "@/app/api/interviews/route"
      ? await import("@/app/api/interviews/route")
      : await import("@/app/api/interviews/series/route");
    return route.GET(new Request(`http://127.0.0.1${endpoint}${query}`));
  }

  it("51 条可全部翻出，累计数独立于页面大小和搜索条件", async () => {
    const first = await get();
    expect(first.status).toBe(200);
    const firstPage = await first.json();
    expect(firstPage.items).toHaveLength(50);
    expect(firstPage.total).toBe(51);
    expect(firstPage.nextCursor).toBe("2");
    expect(firstPage.items[0].id).toBe(51);

    const second = await get(`?cursor=${firstPage.nextCursor}`);
    const secondPage = await second.json();
    expect(secondPage.items.map((row: { id: number }) => row.id)).toEqual([1]);
    expect(secondPage.nextCursor).toBeNull();
    expect(secondPage.total).toBe(51);

    const search = await (await get("?q=%E5%85%B3%E9%94%AE&limit=1")).json();
    expect(search.items.map((row: { id: number }) => row.id)).toEqual([1]);
    expect(search.total).toBe(51);
  });

  it("限制每页大小并拒绝非法游标和上限", async () => {
    const limited = await (await get("?limit=2")).json();
    expect(limited.items.map((row: { id: number }) => row.id)).toEqual([51, 50]);
    expect(limited.nextCursor).toBe("50");

    for (const query of ["?limit=0", "?limit=101", "?cursor=-1", "?cursor=abc"]) {
      const response = await get(query);
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBe("分页参数无效");
    }
  });
});
