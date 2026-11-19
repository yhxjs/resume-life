import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readBankListPage } from "@/lib/bank";

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

describe("题库导入材料类型", () => {
  const badValues: unknown[] = [null, 0, true, [], ["behavior"], {}];
  it.each(["direction", "kind", "text"].flatMap(field => badValues.map(value => [field, value] as const)))(
    "%s=%j 不得丢弃材料后写入", async (field, value) => {
      await post("已有题目");
      const before = db.prepare("SELECT * FROM bank_entries ORDER BY id").all();
      const { POST } = await import("../route");
      const response = await POST(new Request("http://localhost/api/bank", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ direction: "前端", kind: "behavior", text: "不得导入的新题", [field]: value }),
      }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: expect.any(String) });
      expect(db.prepare("SELECT * FROM bank_entries ORDER BY id").all()).toEqual(before);
    },
  );
  it.each([null, 0, true, [], "正文"].map(value => [value]))("非对象请求 %j 拒绝", async value => {
    const { POST } = await import("../route");
    const response = await POST(new Request("http://localhost/api/bank", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value),
    }));
    expect(response.status).toBe(400);
    expect(db.prepare("SELECT COUNT(*) AS n FROM bank_entries").get()).toEqual({ n: 0 });
  });
  it.each([undefined, "", "legacy"])("缺省及未知字符串题型 %j 保留 tech 兼容规则", async kind => {
    const { POST } = await import("../route");
    const response = await POST(new Request("http://localhost/api/bank", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, text: "  C++  <T> &amp;  " }),
    }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ count: 1 });
    expect(db.prepare("SELECT direction, kind, question FROM bank_entries").all()).toEqual([
      { direction: "", kind: "tech", question: "C++  <T> &amp;" },
    ]);
  });
});

describe("题库题型筛选不能静默扩大", () => {
  it.each(["legacy", "TECH", "tech,behavior", "null"])("未知筛选 %j 返回 400 且不修改历史", async kind => {
    const insert = db.prepare("INSERT INTO bank_entries (direction,kind,question,created_at) VALUES ('前端',?,?, '历史时间')");
    for (const savedKind of ["tech", "behavior"]) insert.run(savedKind, `${savedKind} 原题`);
    const before = db.prepare("SELECT * FROM bank_entries ORDER BY id").all();
    const { GET } = await import("../route");
    const response = await GET(new Request(`http://localhost/api/bank?${new URLSearchParams({ kind })}`));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: expect.any(String) });
    expect(db.prepare("SELECT * FROM bank_entries ORDER BY id").all()).toEqual(before);
  });
  it.each([undefined, "", "   ", " tech ", " behavior "])("合法或空筛选 %j 完整保留匹配历史", async kind => {
    const insert = db.prepare("INSERT INTO bank_entries (direction,kind,question,created_at) VALUES ('前端',?,?, '历史时间')");
    for (const savedKind of ["tech", "behavior"]) insert.run(savedKind, `${savedKind} 原题 <T> &amp;`);
    const before = db.prepare("SELECT * FROM bank_entries ORDER BY id DESC").all();
    const { GET } = await import("../route");
    const params = new URLSearchParams(kind === undefined ? {} : { kind });
    const response = await GET(new Request(`http://localhost/api/bank?${params}`));
    expect(response.status).toBe(200);
    const page = readBankListPage(await response.json(), { kind });
    expect(page.items).toEqual(kind?.trim() ? before.filter(row => row.kind === kind.trim()) : before);
    expect(db.prepare("SELECT * FROM bank_entries ORDER BY id DESC").all()).toEqual(before);
  });
});
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

  it("只在本批次逐行去重，保留技术符号、实体字面量与内部空格；再次导入仍新增", async () => {
    const input = "  C++ / C# <T> &amp;\r\n\n内部  空格？\nC++ / C# <T> &amp;  ";
    for (let batch = 0; batch < 2; batch++) {
      const response = await post(input); expect(response.status).toBe(201); expect(await response.json()).toEqual({ count: 2 });
    }
    expect(db.prepare("SELECT direction, kind, question FROM bank_entries ORDER BY id").all()).toEqual(
      Array.from({ length: 2 }, () => [{ direction: "前端", kind: "tech", question: "C++ / C# <T> &amp;" }, { direction: "前端", kind: "tech", question: "内部  空格？" }]).flat(),
    );
  });

  it("批次中途写入失败整批回滚，已有题目不变", async () => {
    await post("已存在的题目");
    const before = db.prepare("SELECT * FROM bank_entries ORDER BY id").all();
    db.exec("CREATE TRIGGER reject_test_bank BEFORE INSERT ON bank_entries WHEN NEW.question = '拒绝本题' BEGIN SELECT RAISE(ABORT, 'synthetic insert failure'); END");
    const response = await post("第一道应回滚\n拒绝本题\n第三道不能写入"); expect(response.status).toBe(500);
    expect(db.prepare("SELECT * FROM bank_entries ORDER BY id").all()).toEqual(before);
  });
});

describe("题库目录协议与真实 SQLite 筛选一致", () => {
  const questions = ["C++ / C# <T> &amp;", "literal 100%_path\\file", "literal 100XXpathZfile", "École", "école", "用户含中文",
    "abc\0hidden", "abc", "xABC", "abc extra", "back\\\0ignore", "back\\"];
  it.each([
    ["c++", [0]], ["100%_path\\file", [1]], ["É", [3]], ["é", [4]], ["中文", [5]], ["hidden", []],
    ["abc", [6, 7, 8, 9]], ["abc\0ignored", [6, 7, 8]], ["\0ignored", questions.map((_, index) => index)], ["back\\\0ignored", [10, 11]],
  ] as [string, number[]][])("关键词 %j 按实际 LIKE 回读，保留原始存档", async (keyword, indexes) => {
    const insert = db.prepare("INSERT INTO bank_entries (direction,kind,question,created_at) VALUES ('C++ <T> &amp;','tech',?,'历史时间')");
    for (const question of questions) insert.run(question);
    const before = db.prepare("SELECT * FROM bank_entries ORDER BY id DESC").all();
    const { GET } = await import("../route");
    const params = new URLSearchParams({ q: `  ${keyword}  `, direction: "  C++ <T> &amp;  ", kind: "tech" });
    const response = await GET(new Request(`http://localhost/api/bank?${params}`)); expect(response.status).toBe(200);
    const page = readBankListPage(await response.json(), { keyword, direction: "C++ <T> &amp;", kind: "tech" });
    expect(page.items.map(item => item.question)).toEqual(indexes.toReversed().map(index => questions[index]));
    expect(db.prepare("SELECT * FROM bank_entries ORDER BY id DESC").all()).toEqual(before);
  });
});
