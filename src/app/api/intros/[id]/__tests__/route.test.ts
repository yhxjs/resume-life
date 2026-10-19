import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

const request = () =>
  new Request("http://127.0.0.1/api/intros/1", {
    method: "GET",
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
    expect(data.resume_title).toBe("测试简历");
    expect(data.jd).toBe("招聘前端工程师");
    expect(data.versions).toHaveLength(1);
    expect(data.versions[0]?.kind).toBe("30s");
    expect(data.versions[0]?.sentences[0]?.text).toBe("面试官您好");
  });

  it("GET 句子 JSON 损坏的版本以空句子列表呈现", async () => {
    const id = seedIntro();
    seedVersion(id, "30s", "这不是JSON");
    seedVersion(id, "2min", JSON.stringify([{ text: "两分钟版本", comment: "" }]));

    const route = await import("../route");
    const res = await route.GET(request(), idContext(id));
    expect(res.status).toBe(200);
    const data = (await res.json()) as { versions: { kind: string; sentences: unknown[] }[] };
    expect(data.versions).toHaveLength(2);
    const corrupt = data.versions.find((v) => v.kind === "30s");
    const good = data.versions.find((v) => v.kind === "2min");
    expect(corrupt?.sentences).toEqual([]);
    expect(good?.sentences).toHaveLength(1);
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

    const res = await route.DELETE(request(), idContext(id));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);

    const intros = db?.prepare("SELECT COUNT(*) AS n FROM intros").get() as { n: number } | undefined;
    const versions = db?.prepare("SELECT COUNT(*) AS n FROM intro_versions").get() as { n: number } | undefined;
    expect(intros?.n).toBe(0);
    expect(versions?.n).toBe(0);
  });

  it("DELETE 不存在的记录返回 404", async () => {
    const route = await import("../route");
    const res = await route.DELETE(request(), idContext(999));
    expect(res.status).toBe(404);
    const data = (await res.json()) as { error: string };
    expect(data.error).toContain("记录不存在");
  });
});
