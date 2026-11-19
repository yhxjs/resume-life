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
    expect(res.headers.get("cache-control")).toBe("no-store");
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

  it.each(["abc", "0", "-1", "1.5", "9007199254740992", "Infinity", ""])("非法 id %s 读写均返回 400，不触及已有练习", async invalidId => {
    const id = seedDrill();
    const route = await import("../route");
    for (const method of [route.GET, route.DELETE]) {
      const response = await method(request(), idContext(invalidId));
      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain("无效的练习 ID");
    }
    expect(db!.prepare("SELECT id FROM drills").all()).toEqual([{ id }]);
    expect(db!.prepare("SELECT id FROM drill_questions").all()).toHaveLength(2);
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

  it("删除级联清理原题复习与历史，保留错题快照及其复习、其他练习和匿名计量", async () => {
    const id = seedDrill(); const otherId = seedDrill();
    const questions = db!.prepare("SELECT id FROM drill_questions WHERE drill_id = ? ORDER BY idx").all(id) as { id: number }[];
    const notebook = await import("@/app/api/notebook/route");
    const response = await notebook.POST(new Request("http://127.0.0.1/api/notebook", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: "drill", source_id: questions[0]!.id }) }));
    expect(response.status).toBe(201); const saved = await response.json();
    const directCard = Number(db!.prepare("INSERT INTO review_cards (drill_question_id,next_review_date,created_at) VALUES (?,'2026-10-29','')").run(questions[1]!.id).lastInsertRowid);
    const cards = (await import("@/lib/spaced-repetition-cards"));
    for (const card of [directCard, saved.review.review_card_id]) cards.saveReview(card, { answer: `保留边界 ${card}`, grade: "good", expected_review_count: 0, request_id: `delete-test-${card}` });
    const snapshot = db!.prepare("SELECT * FROM notebook_entries WHERE id = ?").get(saved.id);
    const review = db!.prepare("SELECT * FROM review_cards WHERE id = ?").get(saved.review.review_card_id);
    const history = db!.prepare("SELECT * FROM review_attempts WHERE card_id = ?").all(saved.review.review_card_id);
    db!.prepare("INSERT INTO llm_call_logs (created_at,feature,entity_type,entity_id,entity_label,task,model,api_format,status,input_tokens) VALUES ('','test','drill',?,'原练习标题','evaluate','test','openai_chat','ok',12)").run(id);
    db!.prepare("INSERT INTO llm_call_logs (created_at,feature,entity_type,entity_id,entity_label,task,model,api_format,status,input_tokens) VALUES ('','test','drill',?,'另一练习标题','evaluate','test','openai_chat','ok',17)").run(otherId);
    const route = await import("../route");
    expect((await route.DELETE(request(), idContext(id))).status).toBe(200);
    const absent = await route.GET(request(), idContext(id)); expect(absent.status).toBe(404); expect(absent.headers.get("cache-control")).toBe("no-store");
    expect(db!.prepare("SELECT id FROM drill_questions WHERE drill_id = ?").all(id)).toEqual([]);
    expect(db!.prepare("SELECT id FROM review_cards WHERE id = ?").get(directCard)).toBeUndefined();
    expect(db!.prepare("SELECT id FROM review_attempts WHERE card_id = ?").all(directCard)).toEqual([]);
    expect(db!.prepare("SELECT * FROM notebook_entries WHERE id = ?").get(saved.id)).toEqual(snapshot);
    expect(db!.prepare("SELECT * FROM review_cards WHERE id = ?").get(saved.review.review_card_id)).toEqual(review);
    expect(db!.prepare("SELECT * FROM review_attempts WHERE card_id = ?").all(saved.review.review_card_id)).toEqual(history);
    expect((await route.GET(request(), idContext(otherId))).status).toBe(200);
    expect(db!.prepare("SELECT entity_label,input_tokens FROM llm_call_logs WHERE entity_type = 'drill' AND entity_id = ?").get(id)).toEqual({ entity_label: "", input_tokens: 12 });
    expect(db!.prepare("SELECT entity_label,input_tokens FROM llm_call_logs WHERE entity_type = 'drill' AND entity_id = ?").get(otherId)).toEqual({ entity_label: "另一练习标题", input_tokens: 17 });
  });

  it("删除失败时练习、题目与日志标题清理一并回滚", async () => {
    const id = seedDrill(); const otherId = seedDrill();
    db!.prepare("INSERT INTO llm_call_logs (created_at,feature,entity_type,entity_id,entity_label,task,model,api_format,status,input_tokens) VALUES ('','test','drill',?,'原标题','evaluate','test','openai_chat','ok',12)").run(id);
    db!.exec(`CREATE TRIGGER block_drill_delete BEFORE DELETE ON drills WHEN old.id = ${id} BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`);
    const route = await import("../route");
    expect((await route.DELETE(request(), idContext(id))).status).toBe(500);
    expect(db!.prepare("SELECT id FROM drills ORDER BY id").all()).toEqual([{ id }, { id: otherId }]);
    expect(db!.prepare("SELECT id FROM drill_questions").all()).toHaveLength(4);
    expect(db!.prepare("SELECT entity_label,input_tokens FROM llm_call_logs WHERE entity_type = 'drill' AND entity_id = ?").get(id)).toEqual({ entity_label: "原标题", input_tokens: 12 });
  });
});
