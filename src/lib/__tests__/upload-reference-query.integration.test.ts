import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let directory: string;
let database: DatabaseSync;
let storage: typeof import("../upload-storage");
let getAvatar: typeof import("@/app/api/uploads/[name]/route").GET;

beforeAll(async () => {
  vi.resetModules();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "resume-life-avatar-query-"));
  vi.stubEnv("RESUME_LIFE_DATA_DIR", directory);
  database = (await import("../db")).getDb();
  storage = await import("../upload-storage");
  getAvatar = (await import("@/app/api/uploads/[name]/route")).GET;
  database.prepare("INSERT INTO resumes (id,title,created_at,updated_at) VALUES (1,'合成简历','','')").run();
  fs.mkdirSync(storage.UPLOADS_DIR, { recursive: true });
  fs.writeFileSync(path.join(storage.UPLOADS_DIR, "target.png"), "synthetic-avatar");
});

beforeEach(() => {
  database.exec("DELETE FROM resume_modules; DELETE FROM resume_versions;");
  fs.writeFileSync(path.join(storage.UPLOADS_DIR, "target.png"), "synthetic-avatar");
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  database?.close();
  vi.unstubAllEnvs();
  const resolved = path.resolve(directory);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("resume-life-avatar-query-")) {
    throw new Error("Unsafe cleanup path");
  }
  fs.rmSync(resolved, { recursive: true, force: true });
});

function current(content: unknown, type = "basic") {
  database.prepare("INSERT INTO resume_modules (resume_id,module_key,type,content,updated_at) VALUES (1,'basic',?,?,'')")
    .run(type, JSON.stringify(content));
}
function historical(modules: unknown[], version = 1) {
  database.prepare("INSERT INTO resume_versions (resume_id,version,name,created_at,snapshot) VALUES (1,?,'合成版本','',?)")
    .run(version, JSON.stringify({ title: "合成简历", modules }));
}
const read = (name = "target.png") => getAvatar(new Request("http://localhost/api/uploads/target.png"), { params: Promise.resolve({ name }) });
const revision = "8f130bae-f339-493b-a69b-b41d9f471323";

describe("单个头像的引用查询", () => {
  it("清理单头像只查 EXISTS，不枚举全库正文", () => {
    historical([{ type: "summary", content: { text: "bulk-historical-content".repeat(24_000) } }]);
    const prepare = vi.spyOn(database, "prepare");
    const parse = vi.spyOn(JSON, "parse");
    storage.removeUnreferencedUploadByUrl("/api/uploads/target.png");
    expect(storage.readUploadFile("target.png")).toBeNull();
    expect(prepare.mock.calls.some(([sql]) => sql.includes("SELECT EXISTS"))).toBe(true);
    expect(parse.mock.calls.some(([value]) => typeof value === "string" && value.includes("bulk-historical-content"))).toBe(false);
  });

  it("枚举引用只返回头像标量，不把当前内容或历史正文传入 JavaScript", () => {
    current({ avatar: `/api/uploads/current.png?v=${revision}`, notes: "bulk-current-content".repeat(24_000) });
    historical([{ type: "summary", content: { text: "bulk-historical-content".repeat(24_000) } },
      { type: "basic", content: { avatar: "/api/uploads/target.png" } }]);
    const parse = vi.spyOn(JSON, "parse");
    const materialized: unknown[][] = [];
    const projectedDatabase = { prepare(sql: string) {
      const statement = database.prepare(sql);
      return { all() { const rows = statement.all(); materialized.push(rows); return rows; } };
    } };
    expect(storage.listReferencedUploadFilenames(projectedDatabase)).toEqual(new Set(["current.png", "target.png"]));
    expect(materialized.flat().every((row) => !Object.hasOwn(row as object, "content") && !Object.hasOwn(row as object, "snapshot"))).toBe(true);
    expect(parse.mock.calls.some(([value]) => typeof value === "string" && /bulk-(current|historical)-content/.test(value))).toBe(false);
  });

  it.each(["{", JSON.stringify({ modules: null }), JSON.stringify({ modules: {} }), JSON.stringify({ modules: [null] })])(
    "损坏历史快照 %s 仍中止备份引用清单", (snapshot) => {
      historical([]);
      database.prepare("UPDATE resume_versions SET snapshot = ?").run(snapshot);
      expect(() => storage.listReferencedUploadFilenames(database)).toThrow();
    },
  );

  it("损坏历史 JSON 不阻止删除已确认无引用的单文件", () => {
    historical([]);
    database.prepare("UPDATE resume_versions SET snapshot = ?").run("{");
    storage.removeUnreferencedUploadByUrl("/api/uploads/target.png");
    expect(storage.readUploadFile("target.png")).toBeNull();
  });
  it.each([false, true])("当前简历%s版本URL的头像保持可读", async (versioned) => {
    current({ avatar: `/api/uploads/target.png${versioned ? `?v=${revision}` : ""}` });
    const response = await read();
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("synthetic-avatar");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it.each([false, true])("仅历史版本引用的%s版本URL头像仍可读", async (versioned) => {
    historical([{ type: "basic", content: { avatar: `/api/uploads/target.png${versioned ? `?v=${revision}` : ""}` } }]);
    expect((await read()).status).toBe(200);
  });

  it("落盘但未被引用的头像不能读取", async () => {
    expect((await read()).status).toBe(404);
  });

  it("其他模块正文或嵌套 avatar 字段不算头像引用", async () => {
    current({ avatar: "/api/uploads/target.png" }, "custom");
    historical([{ type: "custom", content: { avatar: "/api/uploads/target.png" } },
      { type: "basic", content: { notes: "/api/uploads/target.png", nested: { avatar: "/api/uploads/target.png" } } }]);
    expect((await read()).status).toBe(404);
  });

  const basic = { type: "basic", content: { avatar: "/api/uploads/target.png" } };
  it.each([
    ["数组元素是字符串化模块", [JSON.stringify(basic)]],
    ["modules 是对象", { unexpected: basic }],
    ["modules 是 JSON 字符串", JSON.stringify(basic)],
    ["modules 是 null", null],
    ["数组元素是嵌套数组", [[basic]]],
    ["content 是字符串化对象", [{ type: "basic", content: JSON.stringify(basic.content) }]],
    ["content 是数组", [{ type: "basic", content: [basic.content] }]],
  ])("损坏的历史快照形态（%s）不授权读取头像", async (_, modules) => {
    historical([]);
    database.prepare("UPDATE resume_versions SET snapshot = ?").run(JSON.stringify({ modules }));
    expect((await read()).status).toBe(404);
  });

  it.each([JSON.stringify(basic.content), [basic.content], null])("当前模块内容不是对象时不算引用：%j", async (content) => {
    current(content);
    expect((await read()).status).toBe(404);
  });

  it("非法历史 JSON 不触发解析异常，也不授权读取头像", async () => {
    historical([]);
    database.prepare("UPDATE resume_versions SET snapshot = ?").run("{");
    expect((await read()).status).toBe(404);
  });

  it.each(["/uploads/target.png", "https://example.invalid/api/uploads/target.png", "/api/uploads/nested/../target.png",
    "/api/uploads/target.png?redirect=elsewhere", "/api/uploads/target.png?v=invalid"])("非法或旧公开路径 %s 不恢复为私有引用", async (url) => {
    current({ avatar: url });
    historical([{ type: "basic", content: { avatar: url } }]);
    expect((await read()).status).toBe(404);
    expect(storage.listReferencedUploadFilenames(database)).toEqual(new Set());
  });

  it.each(["../target.png", "nested/target.png", "target.png?redirect=other"])("非法请求文件名 %s 被拒绝", async (name) => {
    current({ avatar: "/api/uploads/target.png" });
    expect((await read(name)).status).toBe(404);
  });

  it("大历史库读取单头像时不会在 JavaScript 解析无关完整快照", async () => {
    const largeText = "bulk-historical-content".repeat(24_000);
    database.exec("BEGIN");
    for (let version = 1; version <= 30; version++) {
      historical([{ type: "summary", content: { text: largeText } }], version);
    }
    historical([{ type: "basic", content: { avatar: "/api/uploads/target.png" } }], 31);
    database.exec("COMMIT");
    const parse = vi.spyOn(JSON, "parse");
    expect((await read()).status).toBe(200);
    expect(parse.mock.calls.some(([value]) => typeof value === "string" && value.includes("bulk-historical-content"))).toBe(false);
  });
});
