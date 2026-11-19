import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateExistingIntro } from "@/lib/intro-history";

const TEMP_PREFIX = "resume-life-intros-id-route-test-";

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

const request = (method = "GET") =>
  new Request("http://127.0.0.1/api/intros/1", {
    method,
    headers: { origin: "http://127.0.0.1", host: "127.0.0.1" },
  });

const idContext = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

/** intros 与 resumes 是 JOIN 关系，必须先有简历 */
const seedIntro = (): number => {
  db?.prepare("INSERT INTO resumes (id, title, created_at, updated_at) VALUES (1, '测试简历', '', '')").run();
  const result = db?.prepare("INSERT INTO intros (resume_id, jd, created_at) VALUES (1, ?, ?)")
    .run("招聘前端工程师", "2026-01-01T00:00:00.000Z");
  return Number(result?.lastInsertRowid);
};

const seedVersion = (introId: number, kind: string, sentences: string): void => {
  db?.prepare("INSERT INTO intro_versions (intro_id, kind, sentences, updated_at) VALUES (?, ?, ?, ?)")
    .run(introId, kind, sentences, "2026-01-01T00:00:00.000Z");
};

describe("GET/DELETE /api/intros/[id] 自我介绍记录", () => {
  it.each(["0", "-1", "1.5", "9007199254740992", "NaN"])("GET/DELETE 拒绝非正安全 ID %s，零业务写入", async id => {
    seedIntro();
    const before = db!.prepare("SELECT * FROM intros").all();
    const route = await import("../route");
    for (const handler of [route.GET, route.DELETE]) {
      const response = await handler(request(handler === route.DELETE ? "DELETE" : "GET"), idContext(id));
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toContain("no-store");
    }
    expect(db!.prepare("SELECT * FROM intros").all()).toEqual(before);
  });

  it("GET 返回记录、简历标题与版本句子", async () => {
    const id = seedIntro();
    seedVersion(id, "30s", JSON.stringify([{ text: "面试官您好", comment: "" }]));

    const route = await import("../route");
    const res = await route.GET(request(), idContext(id));
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      id: number;
      resume_title: string;
      jd: string;
      versions: { kind: string; sentences: { text: string }[] }[];
    };
    expect(data.id).toBe(id);
    expect(() => validateExistingIntro(data, id)).not.toThrow();
    expect(data.resume_title).toBe("测试简历");
    expect(data.jd).toBe("招聘前端工程师");
    expect(data.versions).toHaveLength(1);
    expect(data.versions[0]?.kind).toBe("30s");
    expect(data.versions[0]?.sentences[0]?.text).toBe("面试官您好");
  });

  it("GET 句子 JSON 损坏的版本明确标记并返回只读原稿，另一版正常读取", async () => {
    const id = seedIntro();
    seedVersion(id, "30s", "这不是JSON");
    seedVersion(id, "2min", JSON.stringify([{ text: "两分钟版本", comment: "" }]));

    const route = await import("../route");
    const res = await route.GET(request(), idContext(id));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { versions: { kind: string; sentences: unknown[]; read_error?: string; raw_sentences?: string }[] };
    expect(data.versions).toHaveLength(2);
    const corrupt = data.versions.find((v) => v.kind === "30s");
    const good = data.versions.find((v) => v.kind === "2min");
    expect(corrupt?.sentences).toEqual([]);
    expect(corrupt?.read_error).toContain("不是有效 JSON");
    expect(corrupt?.raw_sentences).toBe("这不是JSON");
    expect(good?.read_error).toBeUndefined();
    expect(good?.sentences).toHaveLength(1);
    expect(() => validateExistingIntro(data, id)).not.toThrow();
  });

  it("GET 不存在的记录返回 404，非法 id 返回 400", async () => {
    const route = await import("../route");
    const missing = await route.GET(request(), idContext(999));
    expect(missing.status).toBe(404);
    const missingData = (await missing.json()) as { error: string };
    expect(missingData.error).toContain("记录不存在");

    const invalid = await route.GET(request(), idContext(Number.NaN));
    expect(invalid.status).toBe(400);
    const invalidData = (await invalid.json()) as { error: string };
    expect(invalidData.error).toContain("无效的记录 ID");
  });

  it("DELETE 删除记录及其版本", async () => {
    const id = seedIntro();
    seedVersion(id, "30s", "[]");
    const route = await import("../route");

    const res = await route.DELETE(request("DELETE"), idContext(id));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);

    const intros = db?.prepare("SELECT COUNT(*) AS n FROM intros").get() as { n: number } | undefined;
    const versions = db?.prepare("SELECT COUNT(*) AS n FROM intro_versions").get() as { n: number } | undefined;
    expect(intros?.n).toBe(0);
    expect(versions?.n).toBe(0);
  });

  it("DELETE 不存在的记录返回 404", async () => {
    const route = await import("../route");
    const res = await route.DELETE(request("DELETE"), idContext(999));
    expect(res.status).toBe(404);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("记录不存在");
  });

  it("DELETE 任一版本级联失败同时回滚两版及隐私标签，成功后只删除目标记录", async () => {
    const id = seedIntro(); seedVersion(id, "30s", "[]"); seedVersion(id, "2min", "{broken");
    const other = Number(db!.prepare("INSERT INTO intros (resume_id,jd,created_at) VALUES (1,'保留另一份','')").run().lastInsertRowid);
    seedVersion(other, "30s", "[]");
    for (const target of [id, other]) db!.prepare("INSERT INTO llm_call_logs (created_at,feature,entity_type,entity_id,entity_label,task,model,api_format,status,input_tokens) VALUES ('','intro','intro',?,'隐私原始标题','intro','synthetic','openai_chat','ok',12)").run(target);
    const snapshot = () => ["intros", "intro_versions", "llm_call_logs"].map(table => db!.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
    const before = snapshot();
    db!.exec("CREATE TRIGGER block_intro_version BEFORE DELETE ON intro_versions WHEN OLD.kind = '2min' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    const route = await import("../route");
    const failed = await route.DELETE(request("DELETE"), idContext(id)); expect(failed.status).toBe(500); expect(snapshot()).toEqual(before);
    db!.exec("DROP TRIGGER block_intro_version");
    expect((await route.DELETE(request("DELETE"), idContext(id))).status).toBe(200);
    expect((await route.GET(request(), idContext(id))).status).toBe(404);
    expect(db!.prepare("SELECT * FROM intro_versions WHERE intro_id = ?").all(id)).toEqual([]);
    expect(db!.prepare("SELECT entity_label,input_tokens FROM llm_call_logs WHERE entity_id = ?").get(id)).toEqual({ entity_label: "", input_tokens: 12 });
    expect(db!.prepare("SELECT * FROM intros WHERE id = ?").get(other)).toEqual(before[0]![1]);
    expect(db!.prepare("SELECT * FROM intro_versions WHERE intro_id = ?").all(other)).toEqual([before[1]![2]]);
    expect(db!.prepare("SELECT entity_label,input_tokens FROM llm_call_logs WHERE entity_id = ?").get(other)).toEqual({ entity_label: "隐私原始标题", input_tokens: 12 });
  });
});


describe("历史自我介绍完整读取", () => {
  it.each([
    "{broken", "null", "{}", "[]",
    JSON.stringify([{ text: "完整第一句", comment: "点评" }, null]),
    JSON.stringify([{ text: "完整第一句", comment: "点评" }, { text: " ", comment: "不应丢弃" }]),
    JSON.stringify([{ text: "完整第一句", comment: { text: "不能当成 React 子节点" } }]),
    JSON.stringify([{ text: "完整第一句", comment: 1 }]),
    JSON.stringify([{ text: "完整第一句" }, ["数组不是句子"]]),
  ])("异常原稿不静默过滤或改写（%#）", async (raw) => {
    const id = seedIntro();
    seedVersion(id, "30s", raw);
    const before = db!.prepare("SELECT * FROM intro_versions").all();
    const route = await import("../route");
    const response = await route.GET(request(), idContext(id));
    expect(response.status).toBe(200);
    const version = (await response.json()).versions[0];
    expect(version.sentences).toEqual([]);
    expect(version.read_error).toEqual(expect.any(String));
    expect(version.raw_sentences).toBe(raw);
    expect(version.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(db!.prepare("SELECT * FROM intro_versions").all()).toEqual(before);
  });

  it("结构正常的超长历史全文与顺序完整展示，不套新的生成上限", async () => {
    const id = seedIntro();
    const sentences = Array.from({ length: 61 }, (_, index) => ({ text: `第${index}句：` + "文".repeat(801), comment: "注".repeat(301) }));
    seedVersion(id, "30s", JSON.stringify(sentences));
    const route = await import("../route");
    const version = (await (await route.GET(request(), idContext(id))).json()).versions[0];
    expect(version.sentences).toEqual(sentences);
    expect(version.read_error).toBeUndefined();
    expect(version.raw_sentences).toBeUndefined();
  });

  it("缺省点评兼容为空文本，正文空白与技术符号原样保留", async () => {
    const id = seedIntro();
    seedVersion(id, "30s", JSON.stringify([{ text: "  a < b && b > c\n尚未上线  " }]));
    const route = await import("../route");
    const version = (await (await route.GET(request(), idContext(id))).json()).versions[0];
    expect(version.sentences).toEqual([{ text: "  a < b && b > c\n尚未上线  ", comment: "" }]);
    expect(version.read_error).toBeUndefined();
  });
});
