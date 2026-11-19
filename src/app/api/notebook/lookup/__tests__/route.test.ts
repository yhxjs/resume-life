import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let db: DatabaseSync; let directory: string;
const prefix = "resume-life-notebook-lookup-test-";
beforeEach(async () => {
  vi.resetModules(); directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); vi.stubEnv("RESUME_LIFE_DATA_DIR", path.join(directory, "data"));
  db = (await import("@/lib/db")).getDb(); vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  db?.close(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  const resolved = path.resolve(directory); if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(prefix)) throw new Error("Unsafe cleanup");
  fs.rmSync(resolved, { recursive: true, force: true });
});
const request = (query: string) => new Request(`http://localhost/api/notebook/lookup?${query}`);
function seed(source: "drill" | "interview", sourceId = 11) {
  const question = "  长历史原题 <T> &amp;\n内部  空格 ".repeat(1000);
  const result = db.prepare(`INSERT INTO notebook_entries (source,source_id,question,answer,comment,reference,created_at,updated_at) VALUES (?,?,?,'旧原答','旧点评','旧参考','旧时间','')`).run(source, sourceId, question);
  return { id: Number(result.lastInsertRowid), question };
}

describe("GET /api/notebook/lookup 精确来源只读核对", () => {
  it("来源已不存在仍读取独立长快照，来源同 ID 不串题，不创建缺失复习卡", async () => {
    const drill = seed("drill"); const interview = seed("interview"); seed("drill", 12);
    const before = db.prepare("SELECT * FROM notebook_entries ORDER BY id").all(); const route = await import("../route");
    for (const [source, saved] of [["drill", drill], ["interview", interview]] as const) {
      const response = await route.GET(request(`source=${source}&source_id=11`)); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({ id: saved.id, source, source_id: 11, category_id: null, question: saved.question, answer: "旧原答", comment: "旧点评", reference: "旧参考", review: null });
    }
    expect(db.prepare("SELECT * FROM notebook_entries ORDER BY id").all()).toEqual(before); expect(db.prepare("SELECT * FROM review_cards").all()).toEqual([]);
  });

  it("返回真实复习进度和分类，读取不重置进度或写入历史", async () => {
    const saved = seed("drill"); db.exec("INSERT INTO notebook_categories (id,name,created_at) VALUES (4,'旧分类','旧时间')");
    db.prepare("UPDATE notebook_entries SET category_id=4 WHERE id=?").run(saved.id);
    db.prepare(`INSERT INTO review_cards (id,notebook_id,interval_days,ease_factor,repetitions,review_count,lapses,next_review_date,last_reviewed_at,created_at) VALUES (8,?,10,250,3,4,0,'2026-11-03','旧复习日','旧时间')`).run(saved.id);
    const before = db.prepare("SELECT * FROM review_cards").all(); const response = await (await import("../route")).GET(request("source=drill&source_id=11"));
    const result = await response.json(); expect(result.id).toBe(saved.id); expect(result.category_id).toBe(4); expect(result.review).toEqual((await import("@/lib/spaced-repetition-cards")).getNotebookReviewLink(saved.id));
    expect(db.prepare("SELECT * FROM review_cards").all()).toEqual(before);
  });

  it("当前未收藏返回无缓存404，不按同文题或其他来源认领", async () => {
    seed("interview"); seed("drill", 12); const response = await (await import("../route")).GET(request("source=drill&source_id=11"));
    expect(response.status).toBe(404); expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it.each(["", "source=drill", "source=drill&source_id=0", "source=drill&source_id=-1", "source=drill&source_id=1.5", "source=drill&source_id=1.1e1", "source=drill&source_id=0xb", "source=drill&source_id=011", "source=drill&source_id=%2B11", "source=drill&source_id=9007199254740992", "source=drill&source_id=NaN", "source=drill&source_id=true", "source=application_interview&source_id=11", "source_id=11"])("非法来源参数 %s 返回400", async query => {
    seed("drill", 11);
    expect((await (await import("../route")).GET(request(query))).status).toBe(400);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, true, "11", {}, []])("POST 非数字正安全整数来源 %j 在查源题前拒绝", async sourceId => {
    const response = await (await import("../../route")).POST(new Request("http://localhost/api/notebook", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: "drill", source_id: sourceId }) }));
    expect(response.status).toBe(400); expect((await response.json()).error).toBe("无效的收藏请求"); expect(db.prepare("SELECT * FROM notebook_entries").all()).toEqual([]);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, true, "4", {}, []])("POST 非数字正安全整数分类 %j 不被强制转换", async categoryId => {
    const response = await (await import("../../route")).POST(new Request("http://localhost/api/notebook", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: "drill", source_id: 11, category_id: categoryId }) }));
    expect(response.status).toBe(400); expect((await response.json()).error).toBe("无效的分类");
  });
});
