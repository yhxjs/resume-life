import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PREFIX = "resume-life-bank-import-";
let directory: string;
let db: DatabaseSync;
beforeEach(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), PREFIX));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  db = (await import("@/lib/db")).getDb();
});
afterEach(() => {
  db?.close();
  vi.unstubAllEnvs();
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith(PREFIX)) {
    throw new Error("Unsafe cleanup path");
  }
  fs.rmSync(resolved, { recursive: true, force: true });
});
const text = (count: number) => Array.from({ length: count }, (_, i) => `题目 ${i + 1}`).join("\n");
async function post(text: string) {
  const { POST } = await import("../route");
  return POST(new Request("http://localhost/api/bank", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ direction: "前端", kind: "tech", text }),
  }));
}
describe("题库批量导入的原子数量边界", () => {
  it.each([499, 500])("接受 %i 条并返回真实数量", async (count) => {
    const response = await post(text(count));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ count });
    expect(db.prepare("SELECT COUNT(*) AS n FROM bank_entries").get()).toEqual({ n: count });
  });
  it("501 条整批拒绝，不静默保存前 500 条", async () => {
    const response = await post(text(501));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/500.*分批/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM bank_entries").get()).toEqual({ n: 0 });
  });
  it("按去重后的有效题量检查上限", async () => {
    const response = await post(`${text(500)}\n  题目 1  \n\n题目 500`);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ count: 500 });
  });
});
