import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMP_PREFIX = "resume-life-drills-id-route-test-";

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
  new Request("http://127.0.0.1/api/drills/1", {
    method: "GET",
    headers: { origin: "http://127.0.0.1", host: "127.0.0.1" },
  });

const idContext = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

const seedDrill = (): number => {
  const drill = db?.prepare(
    "INSERT INTO drills (source, direction, jd, focus, created_at) VALUES ('bank', ?, ?, ?, ?)"
  ).run("前端", "寻求数据可视化方向的前端", "事件循环与渲染性能", "2026-01-01T00:00:00.000Z");
  const drillId = Number(drill?.lastInsertRowid);
  const insert = db?.prepare(
    "INSERT INTO drill_questions (drill_id, idx, question, answer, kind) VALUES (?, ?, ?, ?, ?)"
  );
  insert?.run(drillId, 0, "什么是事件循环", "浏览器的事件循环机制……", "tech");
  insert?.run(drillId, 1, "如何优化首屏渲染", "", "tech");
  return drillId;
};

describe("GET/DELETE /api/drills/[id] 练习详情与删除", () => {
  it("GET 返回练习详情与按 idx 排序的题目列表", async () => {
    const id = seedDrill();
    const route = await import("../route");
    const res = await route.GET(request(), idContext(id));
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      id: number;
      direction: string;
      project_name: string | null;
      questions: { idx: number; question: string; answer: string; scores: string | null; review_mastery: string | null }[];
    };
    expect(data.id).toBe(id);
    expect(data.direction).toBe("前端");
    expect(data.project_name).toBeNull();
    expect(data.questions).toHaveLength(2);
    expect(data.questions[0]?.idx).toBe(0);
    expect(data.questions[0]?.question).toBe("什么是事件循环");
    expect(data.questions[0]?.answer).toContain("事件循环机制");
    // 未作答的题目 scores 为 null，无复习卡时 review_mastery 也为 null
    expect(data.questions[0]?.scores).toBeNull();
    expect(data.questions[0]?.review_mastery).toBeNull();
  });

  it("GET 不存在的练习返回 404", async () => {
    const route = await import("../route");
    const res = await route.GET(request(), idContext(999));
    expect(res.status).toBe(404);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("练习不存在");
  });

  it("非法 id 返回 400", async () => {
    const route = await import("../route");
    const get = await route.GET(request(), idContext("abc"));
    expect(get.status).toBe(400);
    const data = (await get.json()) as { error: string };
    expect(data.error).toContain("无效的练习 ID");
  });

  it("DELETE 删除练习后题目级联清空", async () => {
    const id = seedDrill();
    const route = await import("../route");
    const res = await route.DELETE(request(), idContext(id));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean };
    expect(data.ok).toBe(true);
    const questions = db?.prepare("SELECT COUNT(*) AS n FROM drill_questions").get() as { n: number } | undefined;
    expect(questions?.n).toBe(0);
  });

  it("DELETE 不存在的练习返回 404", async () => {
    const route = await import("../route");
    const res = await route.DELETE(request(), idContext(999));
    expect(res.status).toBe(404);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("练习不存在");
  });
});
