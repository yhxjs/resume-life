import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let db: DatabaseSync; let directory: string;
const prefix = "resume-life-review-receipt-";
beforeEach(async () => {
  vi.resetModules(); directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("@/lib/db")).getDb(); vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  db?.close(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith(prefix)) throw new Error("Unsafe cleanup");
  fs.rmSync(directory, { recursive: true, force: true });
});
async function seed() {
  const drill = Number(db.prepare("INSERT INTO drills (source,focus,created_at) VALUES ('interview','来源','旧日期')").run().lastInsertRowid);
  const question = Number(db.prepare("INSERT INTO drill_questions (drill_id,idx,question,answer,reference,answered_at) VALUES (?,1,?,'原回答','原参考','旧日期')").run(drill, " 长原题 <T> &amp;\n内部  空格 ".repeat(2000)).lastInsertRowid);
  (await import("@/lib/spaced-repetition-enrollment")).enrollRemedialReview(db, question);
  const card = db.prepare("SELECT id FROM review_cards WHERE drill_question_id=?").get(question) as { id: number };
  return { id: card.id, drill, question };
}
async function submit(id: number, requestId: string, count = 0) {
  return (await import("@/app/api/reviews/[id]/route")).POST(new Request(`http://localhost/api/reviews/${id}`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ answer: "  本次原答 <T> &amp;\n内部  空格  ", grade: "good", expected_review_count: count, request_id: requestId, time_zone: "Asia/Tokyo" }) }), { params: Promise.resolve({ id: String(id) }) });
}
async function lookup(id: string | number, requestId: string) {
  return (await import("../route")).GET(new Request(`http://localhost/api/reviews/${id}/requests/${requestId}`), { params: Promise.resolve({ id: String(id), requestId }) });
}
function snapshot() {
  return { cards: db.prepare("SELECT * FROM review_cards ORDER BY id").all(), attempts: db.prepare("SELECT * FROM review_attempts ORDER BY id").all(), questions: db.prepare("SELECT * FROM drill_questions ORDER BY id").all(), notebooks: db.prepare("SELECT * FROM notebook_entries ORDER BY id").all() };
}

describe("复习提交编号只读核对", () => {
  it("精确读取原提交与当前排期，后续复习不覆盖原答，不新增计次或历史", async () => {
    const card = await seed(); const requestId = randomUUID(); const first = await submit(card.id, requestId); expect(first.status).toBe(200); const saved = await first.json();
    expect((await submit(card.id, randomUUID(), 1)).status).toBe(200); const before = snapshot();
    const response = await lookup(card.id, requestId); expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    const receipt = await response.json(); expect(receipt.request_id).toBe(requestId); expect(receipt.attempt).toEqual(saved.attempt); expect(receipt.card.review_count).toBe(2);
    expect((await import("@/lib/review-records")).readReviewSubmission(receipt, { cardId: card.id, answer: "  本次原答 <T> &amp;\n内部  空格  ", grade: "good", expectedReviewCount: 0, timeZone: "Asia/Tokyo" }, requestId).attempt).toEqual(saved.attempt);
    expect(snapshot()).toEqual(before);
  });

  it("同文回答、其他卡的编号和不存在编号都不认领，404 不写入", async () => {
    const first = await seed(); const other = await seed(); const requestId = randomUUID(); expect((await submit(first.id, requestId)).status).toBe(200);
    const before = snapshot();
    for (const [id, key] of [[other.id, requestId], [first.id, randomUUID()], [999999, requestId]] as const) {
      const response = await lookup(id, key); expect(response.status).toBe(404); expect(response.headers.get("cache-control")).toBe("no-store");
    }
    expect(snapshot()).toEqual(before);
  });

  it("追练转收藏并删除原练习后仍按同一卡和编号读取，移出收藏后返回404", async () => {
    const card = await seed(); const requestId = randomUUID(); const saved = await (await submit(card.id, requestId)).json();
    const response = await (await import("@/app/api/notebook/route")).POST(new Request("http://localhost/api/notebook", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: "drill", source_id: card.question }) }));
    expect(response.status).toBe(201); const notebook = await response.json(); db.prepare("DELETE FROM drills WHERE id=?").run(card.drill);
    const before = snapshot(); const receipt = await (await lookup(card.id, requestId)).json();
    expect(receipt.card).toMatchObject({ id: card.id, source: "notebook", source_id: notebook.id, review_count: 1 }); expect(receipt.attempt).toEqual(saved.attempt); expect(snapshot()).toEqual(before);
    db.prepare("DELETE FROM notebook_entries WHERE id=?").run(notebook.id); expect((await lookup(card.id, requestId)).status).toBe(404);
  });

  it.each([["0", randomUUID()], ["-1", randomUUID()], ["01", randomUUID()], ["1e0", randomUUID()], ["1.5", randomUUID()], ["9007199254740992", randomUUID()], ["bad", randomUUID()], ["1", "bad"], ["1", ""], ["1", "11111111-1111-1111-1111-11111111111g"]])("非法对象或编号 %s/%s 返回无缓存400", async (id, key) => {
    const response = await lookup(id!, key!); expect(response.status).toBe(400); expect(response.headers.get("cache-control")).toBe("no-store"); expect(snapshot().attempts).toEqual([]);
  });

  it("保存事务回滚后查不到提交，原卡排期保持不变", async () => {
    const card = await seed(); const requestId = randomUUID(); const before = snapshot();
    db.exec("CREATE TRIGGER fail_review_receipt BEFORE INSERT ON review_attempts BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
    expect((await submit(card.id, requestId)).status).toBe(500); expect((await lookup(card.id, requestId)).status).toBe(404); expect(snapshot()).toEqual(before);
  });
});
